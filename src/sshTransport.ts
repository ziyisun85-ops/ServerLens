// ServerLens: SSH transport. Runs POSIX sh scripts on remote hosts through the system
// OpenSSH client, reusing one connection per host via ControlMaster where supported.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sshConfigArguments } from './sshConfig';
import { Logger, nullLogger, sanitizeDiagnostic } from './log';

export type SshErrorKind =
    | 'timeout' | 'cancelled' | 'authentication' | 'host-key' | 'host-not-found'
    | 'unreachable' | 'refused' | 'connection-closed' | 'ssh-missing' | 'output-too-large'
    | 'invalid-target' | 'incomplete' | 'unknown';

export class SshError extends Error {
    constructor(
        message: string,
        readonly kind: SshErrorKind,
        readonly detail = '',
        readonly exitCode: number | null = null
    ) {
        super(message);
        this.name = 'SshError';
    }
}

export interface TransportSettings {
    sshConfigPath?: string;
    /** Reuse one SSH connection per host (OpenSSH ControlMaster). Ignored on Windows. */
    connectionReuse: boolean;
    /** Seconds an idle shared connection stays open after the last command. */
    controlPersistSeconds: number;
    /** Executable to run; tests inject a fake. */
    sshCommand?: string;
    /** Base directory for control sockets; tests inject a temporary directory. */
    controlBaseDirectory?: string;
}

export interface ExecOptions {
    /** Hard limit for the whole command, including connection setup. */
    timeoutMs: number;
    connectTimeoutSeconds: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    /** Receives stdout as it arrives (used to learn the PID of long scans). */
    onStdout?: (text: string) => void;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    multiplexed: boolean;
}

const SSH_TARGET = /^[A-Za-z0-9_.:@-]+$/;
const MAX_UNIX_SOCKET_PATH = 104;
// %C expands to a 40-character hash; while binding, ssh appends ".<16 random chars>".
const CONTROL_SOCKET_SUFFIX_LENGTH = 1 + 40 + 17;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export function isValidSshTarget(host: unknown): host is string {
    return typeof host === 'string' && host.length > 0 && host.length <= 255 &&
        !host.startsWith('-') && SSH_TARGET.test(host);
}

/** Maps ssh stderr to an error kind with a short English message; the UI localizes by kind. */
export function classifySshFailure(stderr: string, exitCode: number | null): SshError {
    const detail = sanitizeDiagnostic(stderr);
    const text = stderr.toLowerCase();
    const make = (kind: SshErrorKind, message: string) => new SshError(message, kind, detail, exitCode);
    if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) {
        return make('host-key', 'The host key is not trusted. Connect once in a terminal to verify it.');
    }
    if (text.includes('permission denied') || text.includes('too many authentication failures')) {
        return make('authentication', 'SSH authentication failed. ServerLens needs key-based login without a password prompt.');
    }
    if (text.includes('could not resolve hostname') || text.includes('name or service not known') ||
        text.includes('nodename nor servname') || text.includes('no address associated')) {
        return make('host-not-found', 'Host not found. Check the SSH alias or address.');
    }
    if (text.includes('connection refused')) {
        return make('refused', 'Connection refused. The SSH service may be down.');
    }
    if (text.includes('timed out')) {
        return make('timeout', 'Connection timed out.');
    }
    if (text.includes('no route to host') || text.includes('network is unreachable') || text.includes('host is down')) {
        return make('unreachable', 'Server is unreachable. Check its network and SSH service.');
    }
    // e.g. "Connection to gpu-01 closed by remote host.", "Connection reset by peer".
    if (/connection (to \S+ )?closed|closed by remote host|connection reset|broken pipe|kex_exchange_identification/.test(text)) {
        return make('connection-closed', 'The connection was closed by the server.');
    }
    return make('unknown', detail || `ssh exited with code ${exitCode ?? 'unknown'}.`);
}

function killTree(child: cp.ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    try {
        child.kill('SIGTERM');
    } catch {
        return;
    }
    const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
    }, 2000);
    escalation.unref?.();
}

export class SshTransport {
    /** Running commands and how to stop each one with a reason. */
    private readonly children = new Map<cp.ChildProcess, (error: SshError) => void>();
    private readonly activeByHost = new Map<string, number>();
    private readonly multiplexedHosts = new Set<string>();
    private controlDirectoryCache: { base: string; directory: string | null } | undefined;
    private disposed = false;

    constructor(
        private readonly settings: () => TransportSettings,
        private readonly log: Logger = nullLogger
    ) {}

    /**
     * Returns a private directory for control sockets, or undefined when multiplexing must
     * not be used (Windows, unsafe or too long path). The directory is created with mode 0700
     * and rejected if it is a symlink, owned by another user or accessible by others.
     */
    controlDirectory(): string | undefined {
        if (process.platform === 'win32' || typeof process.getuid !== 'function') {
            return undefined;
        }
        const configured = this.settings().controlBaseDirectory;
        const base = configured || (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir());
        if (this.controlDirectoryCache?.base === base) {
            return this.controlDirectoryCache.directory || undefined;
        }
        const uid = process.getuid();
        const directory = path.join(base, `serverlens-${uid}`);
        let usable: string | null = null;
        try {
            try {
                fs.mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            }
            const stat = fs.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) {
                throw new Error('control directory is not a private directory owned by the current user');
            }
            if ((stat.mode & 0o077) !== 0) {
                fs.chmodSync(directory, 0o700);
            }
            if (Buffer.byteLength(directory) + CONTROL_SOCKET_SUFFIX_LENGTH >= MAX_UNIX_SOCKET_PATH) {
                throw new Error('control socket path would exceed the Unix socket length limit');
            }
            usable = directory;
        } catch (error) {
            this.log.warn(`SSH connection reuse disabled: ${(error as Error).message}`);
        }
        this.controlDirectoryCache = { base, directory: usable };
        return usable || undefined;
    }

    /** Options shared by every monitoring connection. User forwards and TTY settings are cleared. */
    buildArgs(host: string, connectTimeoutSeconds: number, controlDirectory: string | undefined, remoteCommand?: string): string[] {
        const settings = this.settings();
        const args = [
            ...sshConfigArguments(settings.sshConfigPath),
            '-T',
            '-o', 'BatchMode=yes',
            '-o', `ConnectTimeout=${Math.max(1, Math.round(connectTimeoutSeconds))}`,
            '-o', 'ClearAllForwardings=yes',
            '-o', 'ForwardAgent=no',
            '-o', 'ForwardX11=no',
            '-o', 'PermitLocalCommand=no',
            '-o', 'RemoteCommand=none',
            '-o', 'RequestTTY=no',
            '-o', 'LogLevel=ERROR',
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3'
        ];
        if (controlDirectory) {
            args.push(
                '-o', 'ControlMaster=auto',
                '-o', `ControlPath=${path.join(controlDirectory, '%C')}`,
                '-o', `ControlPersist=${Math.max(10, Math.round(settings.controlPersistSeconds))}`
            );
        }
        args.push('--', host);
        if (remoteCommand) {
            args.push(remoteCommand);
        }
        return args;
    }

    activeCommands(host: string): number {
        return this.activeByHost.get(host) || 0;
    }

    /** Runs `script` with `sh -s` on the host. The script is sent on stdin, so the login shell type does not matter. */
    exec(host: string, script: string, options: ExecOptions): Promise<ExecResult> {
        if (this.disposed) {
            return Promise.reject(new SshError('ServerLens is shutting down.', 'cancelled'));
        }
        if (!isValidSshTarget(host)) {
            return Promise.reject(new SshError(`Invalid SSH target: ${String(host)}`, 'invalid-target'));
        }
        if (options.signal?.aborted) {
            return Promise.reject(new SshError('Cancelled.', 'cancelled'));
        }
        const settings = this.settings();
        const controlDirectory = settings.connectionReuse ? this.controlDirectory() : undefined;
        const args = this.buildArgs(host, options.connectTimeoutSeconds, controlDirectory, 'sh -s');
        const maxOutput = options.maxOutputBytes || DEFAULT_MAX_OUTPUT;
        const startedAt = Date.now();

        return new Promise<ExecResult>((resolve, reject) => {
            let child: cp.ChildProcess;
            try {
                child = cp.spawn(settings.sshCommand || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (error) {
                reject(new SshError((error as Error).message, 'unknown'));
                return;
            }
            this.activeByHost.set(host, this.activeCommands(host) + 1);
            if (controlDirectory) {
                this.multiplexedHosts.add(host);
            }
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let failure: SshError | undefined;
            let finished = false;

            const stop = (error: SshError) => {
                if (!failure) {
                    failure = error;
                }
                killTree(child);
            };
            this.children.set(child, stop);
            const timer = setTimeout(() => {
                stop(new SshError(`Timed out after ${Math.round(options.timeoutMs / 1000)} s.`, 'timeout'));
            }, options.timeoutMs);
            const onAbort = () => stop(new SshError('Cancelled.', 'cancelled'));
            options.signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', (chunk: string) => {
                outputBytes += Buffer.byteLength(chunk);
                if (outputBytes > maxOutput) {
                    stop(new SshError(`Remote output exceeded ${Math.round(maxOutput / 1048576)} MiB.`, 'output-too-large'));
                    return;
                }
                stdout += chunk;
                options.onStdout?.(chunk);
            });
            child.stderr?.on('data', (chunk: string) => {
                if (stderr.length < MAX_STDERR) {
                    stderr += chunk.slice(0, MAX_STDERR - stderr.length);
                }
            });
            // ssh may exit before reading stdin (for example on authentication failure).
            child.stdin?.on('error', () => undefined);

            const finish = (exitCode: number | null, spawnError?: NodeJS.ErrnoException) => {
                if (finished) {
                    return;
                }
                finished = true;
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                this.children.delete(child);
                const remaining = this.activeCommands(host) - 1;
                if (remaining > 0) {
                    this.activeByHost.set(host, remaining);
                } else {
                    this.activeByHost.delete(host);
                }
                const durationMs = Date.now() - startedAt;
                if (spawnError) {
                    const missing = spawnError.code === 'ENOENT';
                    reject(new SshError(
                        missing ? 'The ssh command was not found. Install an OpenSSH client.' : spawnError.message,
                        missing ? 'ssh-missing' : 'unknown'
                    ));
                    return;
                }
                if (failure) {
                    this.log.debug(`${host}: ${failure.kind} after ${durationMs} ms`);
                    if (failure.kind === 'timeout' && controlDirectory && remaining <= 0) {
                        // A stalled shared connection would block every later command; drop it.
                        void this.closeMaster(host);
                    }
                    reject(new SshError(failure.message, failure.kind, sanitizeDiagnostic(stderr), exitCode));
                    return;
                }
                if (exitCode === 255) {
                    const error = classifySshFailure(stderr, exitCode);
                    this.log.debug(`${host}: ssh failed (${error.kind}) after ${durationMs} ms`);
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr, exitCode, durationMs, multiplexed: Boolean(controlDirectory) });
            };
            child.on('error', error => finish(null, error as NodeJS.ErrnoException));
            child.on('close', code => finish(code));
            child.stdin?.end(script);
        });
    }

    /**
     * Controls the shared connection for a host. 'exit' ends it at once (used when it is stuck);
     * 'stop' only stops it from accepting new sessions, so commands that another VS Code window is
     * running over it can finish, and it then exits on its own. Errors are ignored.
     */
    closeMaster(host: string, operation: 'exit' | 'stop' = 'exit'): Promise<void> {
        const directory = this.controlDirectoryCache?.directory;
        if (!directory || !isValidSshTarget(host)) {
            return Promise.resolve();
        }
        const settings = this.settings();
        const args = [
            ...sshConfigArguments(settings.sshConfigPath),
            '-o', `ControlPath=${path.join(directory, '%C')}`,
            '-O', operation, '--', host
        ];
        return new Promise(resolve => {
            let child: cp.ChildProcess;
            try {
                child = cp.spawn(settings.sshCommand || 'ssh', args, { stdio: 'ignore', windowsHide: true });
            } catch {
                resolve();
                return;
            }
            const timer = setTimeout(() => { killTree(child); resolve(); }, 3000);
            child.on('error', () => { clearTimeout(timer); resolve(); });
            child.on('close', () => { clearTimeout(timer); resolve(); });
        });
    }

    /** Stops every running command and closes shared connections. Safe to call more than once. */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const stop of this.children.values()) {
            stop(new SshError('ServerLens is shutting down.', 'cancelled'));
        }
        const hosts = Array.from(this.multiplexedHosts);
        this.multiplexedHosts.clear();
        if (hosts.length) {
            this.log.info(`Closing ${hosts.length} shared SSH connection(s).`);
        }
        await Promise.race([
            Promise.all(hosts.map(host => this.closeMaster(host, 'stop'))),
            new Promise(resolve => setTimeout(resolve, 3500))
        ]);
    }
}
