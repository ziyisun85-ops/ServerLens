// ServerLens: SSH transport tests against a fake ssh executable.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifySshFailure, isValidSshTarget, SshError, SshTransport, TransportSettings } from '../sshTransport';

const fakeSsh = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'fake-ssh', 'ssh');

function readLog(file: string): { pid: string; args: string[] }[] {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
        const [pid, ...args] = line.split('\x1f');
        return { pid, args };
    });
}

async function rejectsWith(promise: Promise<unknown>, kind: string): Promise<SshError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof SshError, `expected SshError, got ${error}`);
        assert.strictEqual(error.kind, kind, `${error.message} / ${error.detail}`);
        return error;
    }
    throw new Error(`expected ${kind} failure`);
}

async function main(): Promise<void> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ssh-'));
    const log = path.join(directory, 'ssh.log');
    process.env.FAKE_SSH_LOG = log;
    // Keep the control base short so the socket-path length check passes on macOS too.
    const base = fs.mkdtempSync('/tmp/slt-');
    let settings: TransportSettings = { connectionReuse: true, controlPersistSeconds: 60, sshCommand: fakeSsh, controlBaseDirectory: base, sshConfigPath: '~/.ssh/custom_config' };
    const transport = new SshTransport(() => settings);
    const options = { timeoutMs: 5000, connectTimeoutSeconds: 4 };
    try {
        const result = await transport.exec('ok', 'printf "hello from %s" "$(echo remote)"; exit 0', options);
        assert.strictEqual(result.stdout, 'hello from remote', 'The script is executed from stdin.');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.multiplexed, true);
        const args = readLog(log)[0].args;
        const option = (name: string) => args.includes(name);
        for (const expected of ['BatchMode=yes', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no', 'RemoteCommand=none',
            'RequestTTY=no', 'PermitLocalCommand=no', 'ControlMaster=auto', 'ConnectTimeout=4', 'ControlPersist=60']) {
            assert.ok(option(expected), `ssh must receive -o ${expected}`);
        }
        assert.ok(option('-T'), 'No pseudo-terminal is requested.');
        assert.deepStrictEqual(args.slice(-3), ['--', 'ok', 'sh -s'], 'The host follows "--" and the remote command is only "sh -s".');
        assert.strictEqual(args[args.indexOf('-F') + 1], path.join(os.homedir(), '.ssh', 'custom_config'), 'A custom ssh config is honoured.');
        const controlPath = args.find(arg => arg.startsWith('ControlPath='))?.slice('ControlPath='.length) || '';
        const controlDirectory = path.dirname(controlPath);
        assert.strictEqual(path.basename(controlPath), '%C');
        assert.strictEqual(fs.statSync(controlDirectory).mode & 0o777, 0o700, 'Control sockets live in a private directory.');

        const failures: [string, string][] = [
            ['auth', 'authentication'], ['unknown-host', 'host-not-found'], ['refused', 'refused'],
            ['hostkey', 'host-key'], ['drop', 'connection-closed']
        ];
        for (const [host, kind] of failures) {
            const error = await rejectsWith(transport.exec(host, 'echo hi', options), kind);
            assert.ok(error.detail.length > 0, 'The original ssh message is kept as detail.');
        }

        const startedAt = Date.now();
        await rejectsWith(transport.exec('hang', 'echo hi', { ...options, timeoutMs: 600 }), 'timeout');
        assert.ok(Date.now() - startedAt < 3000, 'A hung command is stopped at its timeout.');
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.ok(readLog(log).some(entry => entry.args.includes('-O') && entry.args.includes('exit') && entry.args.includes('hang')),
            'A timed-out shared connection is closed so the next attempt reconnects.');

        const abort = new AbortController();
        const cancelled = transport.exec('hang', 'echo hi', { ...options, signal: abort.signal });
        setTimeout(() => abort.abort(), 100);
        await rejectsWith(cancelled, 'cancelled');
        await rejectsWith(transport.exec('ok', 'echo hi', { ...options, signal: abort.signal }), 'cancelled');

        await rejectsWith(transport.exec('flood', 'echo hi', { ...options, maxOutputBytes: 64 * 1024 }), 'output-too-large');

        const before = readLog(log).length;
        await rejectsWith(transport.exec('-oProxyCommand=touch /tmp/pwned', 'echo hi', options), 'invalid-target');
        assert.strictEqual(readLog(log).length, before, 'Invalid targets never reach ssh.');
        assert.strictEqual(isValidSshTarget('alice@10.0.0.5'), true);
        assert.strictEqual(isValidSshTarget('gpu node'), false);

        settings = { ...settings, connectionReuse: false };
        await transport.exec('ok', 'true', options);
        const plain = readLog(log).at(-1)?.args || [];
        assert.ok(!plain.some(arg => arg.startsWith('ControlMaster')), 'Connection reuse can be turned off.');

        // An unsafe control directory disables reuse instead of using it.
        const unsafeBase = fs.mkdtempSync('/tmp/slu-');
        const target = fs.mkdtempSync('/tmp/slv-');
        fs.symlinkSync(target, path.join(unsafeBase, `serverlens-${process.getuid?.()}`));
        const unsafe = new SshTransport(() => ({ ...settings, connectionReuse: true, controlBaseDirectory: unsafeBase }));
        assert.strictEqual(unsafe.controlDirectory(), undefined, 'A symlinked control directory is rejected.');
        await unsafe.dispose();
        const looseBase = fs.mkdtempSync('/tmp/slw-');
        fs.mkdirSync(path.join(looseBase, `serverlens-${process.getuid?.()}`), { mode: 0o777 });
        fs.chmodSync(path.join(looseBase, `serverlens-${process.getuid?.()}`), 0o777);
        const loose = new SshTransport(() => ({ ...settings, connectionReuse: true, controlBaseDirectory: looseBase }));
        const fixed = loose.controlDirectory();
        assert.ok(fixed);
        assert.strictEqual(fs.statSync(fixed).mode & 0o777, 0o700, 'Loose permissions are tightened.');
        await loose.dispose();
        const longBase = fs.mkdtempSync(path.join(os.tmpdir(), 'a-very-long-directory-name-that-pushes-the-socket-path-over-the-limit-'));
        const long = new SshTransport(() => ({ ...settings, connectionReuse: true, controlBaseDirectory: longBase }));
        assert.strictEqual(long.controlDirectory(), undefined, 'Socket paths over the Unix limit disable reuse.');
        await long.dispose();
        for (const dir of [unsafeBase, target, looseBase, longBase]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }

        settings = { ...settings, connectionReuse: true };
        const running = rejectsWith(transport.exec('hang', 'echo hi', { ...options, timeoutMs: 20000 }), 'cancelled');
        await new Promise(resolve => setTimeout(resolve, 100));
        const disposeStarted = Date.now();
        await transport.dispose();
        await running;
        assert.ok(Date.now() - disposeStarted < 4000, 'Dispose does not wait for running commands.');
        const exits = readLog(log).filter(entry => entry.args.includes('-O') && entry.args.includes('ok'));
        assert.ok(exits.length > 0, 'Dispose releases every shared connection it used.');
        assert.ok(exits.every(entry => entry.args.includes('stop')),
            'Dispose uses -O stop so commands of other VS Code windows on the same connection can finish.');
        await rejectsWith(transport.exec('ok', 'true', options), 'cancelled');

        assert.strictEqual(classifySshFailure('ssh: connect to host x port 22: Operation timed out', 255).kind, 'timeout');
        assert.strictEqual(classifySshFailure('ssh: connect to host x port 22: No route to host', 255).kind, 'unreachable');
        assert.strictEqual(classifySshFailure('kex_exchange_identification: read: Connection reset by peer', 255).kind, 'connection-closed');
        const secret = classifySshFailure('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nboom', 255);
        assert.ok(!secret.detail.includes('abc') && secret.detail.includes('[private key removed]'), 'Key material never reaches diagnostics.');
        console.log('SSH transport: stdin scripts, hardened options, connection reuse, error kinds, timeouts, cancellation and cleanup passed.');
    } finally {
        delete process.env.FAKE_SSH_LOG;
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
