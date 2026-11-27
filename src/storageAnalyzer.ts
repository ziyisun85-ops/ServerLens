// ServerLens: on-demand, read-only directory size analysis with du. Never runs automatically;
// one scan per host at a time, low CPU/IO priority, remote timeout, cancellable.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import { EventEmitter } from 'events';
import { buildStopScanScript, newNonce, shellPath, validateRemotePath } from './remoteScript';
import { ExecOptions, ExecResult, SshError } from './sshTransport';

export interface StorageTarget {
    label: string;
    /** Absolute paths or paths under ~; missing ones are skipped. */
    paths: string[];
    depth?: number;
}

export interface StorageEntry {
    /** Path as reported by du, with $HOME shown as ~. */
    path: string;
    kib: number;
    /** True for a scanned root (the totals). */
    root: boolean;
}

export type StorageState = 'running' | 'done' | 'cancelled' | 'error';

export interface StorageResult {
    host: string;
    label: string;
    paths: string[];
    depth: number;
    state: StorageState;
    startedAt: number;
    finishedAt?: number;
    /** Largest directories first, roots excluded. */
    entries: StorageEntry[];
    roots: StorageEntry[];
    /** Directories found beyond the display limit. */
    omitted: number;
    totalKiB: number;
    /** Scan stopped by its time limit; unfinished folders are missing. */
    timedOut: boolean;
    /** Approximate count of unreadable directories (permission denied). */
    unreadable: number;
    missing: string[];
    filesystem?: { source: string; totalKiB: number; usedKiB: number; availKiB: number; mountPoint: string };
    error?: string;
}

export interface StorageRunner {
    exec(host: string, script: string, options: ExecOptions): Promise<ExecResult>;
}

export interface StorageAnalyzerSettings {
    depth: number;
    timeoutSeconds: number;
    sshTimeoutSeconds: number;
}

/** Presets for the caches and environments that usually fill research home directories. */
export const STORAGE_PRESETS: StorageTarget[] = [
    { label: 'Home directory', paths: ['~'] },
    { label: 'Conda environments and packages', paths: ['~/.conda', '~/miniconda3', '~/anaconda3', '~/miniforge3', '~/mambaforge'], depth: 2 },
    { label: 'pip cache', paths: ['~/.cache/pip'], depth: 1 },
    { label: 'Hugging Face cache', paths: ['~/.cache/huggingface'], depth: 3 },
    { label: 'PyTorch cache', paths: ['~/.cache/torch'], depth: 2 },
    { label: 'All caches (~/.cache)', paths: ['~/.cache'], depth: 1 }
];

const MAX_ENTRIES = 100;
const MAX_TARGETS = 16;

/** Reads "Label=/path" or "/path" entries from settings. */
export function parseStoragePathSetting(entries: string[]): StorageTarget[] {
    const targets: StorageTarget[] = [];
    for (const raw of entries) {
        const entry = raw.trim();
        const separator = entry.indexOf('=');
        const label = separator > 0 ? entry.slice(0, separator).trim() : '';
        const path = separator > 0 ? entry.slice(separator + 1).trim() : entry;
        try {
            const valid = validateRemotePath(path);
            targets.push({ label: label || valid, paths: [valid] });
        } catch {
            // Invalid entries are ignored; the settings UI shows the expected format.
        }
    }
    return targets;
}

/** Builds the scan script for several roots; missing roots are reported, not fatal. */
export function buildMultiScanScript(paths: string[], depth: number, timeoutSeconds: number, nonce: string): string {
    if (!paths.length || paths.length > MAX_TARGETS) {
        throw new Error(`Choose between 1 and ${MAX_TARGETS} paths.`);
    }
    const quoted = paths.map(path => shellPath(validateRemotePath(path))).join(' ');
    const safeDepth = Math.max(1, Math.min(4, Math.round(depth)));
    const seconds = Math.max(5, Math.min(3600, Math.round(timeoutSeconds)));
    return `SL_N=${nonce}
LC_ALL=C
LANG=C
export LC_ALL LANG
sl_main() {
  set --
  for sl_p in ${quoted}; do
    if [ -d "$sl_p" ] && [ -r "$sl_p" ] && [ -x "$sl_p" ]; then set -- "$@" "$sl_p"; else printf '@@SL:%s:missing %s@@\\n' "$SL_N" "$sl_p"; fi
  done
  if [ $# -eq 0 ]; then printf '@@SL:%s:error notfound@@\\n' "$SL_N"; return 0; fi
  printf '@@SL:%s:home %s@@\\n' "$SL_N" "$HOME"
  printf '@@SL:%s:fs %s@@\\n' "$SL_N" "$(df -P -k "$1" 2>/dev/null | tail -n 1)"
  printf '@@SL:%s:pid %s@@\\n' "$SL_N" "$$"
  set -- du -x -k -d ${safeDepth} -- "$@"
  if command -v ionice >/dev/null 2>&1; then set -- ionice -c3 "$@"; fi
  set -- nice -n 19 "$@"
  if command -v timeout >/dev/null 2>&1 && timeout 5 true >/dev/null 2>&1; then set -- timeout ${seconds} "$@"; fi
  exec "$@"
}
sl_main </dev/null
`;
}

function displayPath(path: string, home: string | undefined): string {
    if (home && home !== '/' && (path === home || path.startsWith(home + '/'))) {
        return '~' + path.slice(home.length);
    }
    return path;
}

/** Parses scan output into sorted entries. Exported for tests. */
export function parseScanOutput(stdout: string, nonce: string, roots: string[]): Pick<StorageResult, 'entries' | 'roots' | 'omitted' | 'totalKiB' | 'missing' | 'filesystem'> & { pid?: number; notFound: boolean; home?: string } {
    const prefix = `@@SL:${nonce}:`;
    let home: string | undefined;
    let pid: number | undefined;
    let notFound = false;
    let filesystem: StorageResult['filesystem'];
    const missing: string[] = [];
    const sizes: { path: string; kib: number }[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.startsWith(prefix) && line.endsWith('@@')) {
            const content = line.slice(prefix.length, -2);
            const space = content.indexOf(' ');
            const key = space < 0 ? content : content.slice(0, space);
            const value = space < 0 ? '' : content.slice(space + 1);
            if (key === 'home') home = value;
            else if (key === 'pid') pid = Number(value) || undefined;
            else if (key === 'missing') missing.push(value);
            else if (key === 'error' && value === 'notfound') notFound = true;
            else if (key === 'fs') {
                const match = value.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+%|-)\s+(\/.*)$/);
                if (match) {
                    filesystem = { source: match[1], totalKiB: Number(match[2]), usedKiB: Number(match[3]), availKiB: Math.max(0, Number(match[4])), mountPoint: match[6] };
                }
            }
            continue;
        }
        const match = line.match(/^(\d+)\t(.+)$/);
        if (match) {
            sizes.push({ kib: Number(match[1]), path: match[2] });
        }
    }
    const rootSet = new Set<string>();
    const expandedRoots = roots.map(root => root === '~' ? home || root : root.startsWith('~/') && home ? home + root.slice(1) : root);
    expandedRoots.forEach(root => rootSet.add(root.replace(/\/+$/, '') || '/'));
    const rootEntries = sizes.filter(item => rootSet.has(item.path)).map(item => ({ path: displayPath(item.path, home), kib: item.kib, root: true }));
    const depthOf = (value: string) => value.split('/').length;
    // Same size: show the parent before the child it consists of.
    const children = sizes.filter(item => !rootSet.has(item.path))
        .sort((left, right) => right.kib - left.kib || depthOf(left.path) - depthOf(right.path) || left.path.localeCompare(right.path));
    return {
        pid,
        home,
        notFound,
        missing: missing.map(path => displayPath(path, home)),
        filesystem,
        roots: rootEntries,
        entries: children.slice(0, MAX_ENTRIES).map(item => ({ path: displayPath(item.path, home), kib: item.kib, root: false })),
        omitted: Math.max(0, children.length - MAX_ENTRIES),
        totalKiB: rootEntries.reduce((sum, item) => sum + item.kib, 0)
    };
}

function countUnreadable(stderr: string): number {
    return stderr.split(/\r?\n/).filter(line => /permission denied|cannot read directory|cannot access/i.test(line)).length;
}

export class StorageAnalyzer {
    private readonly results = new Map<string, StorageResult>();
    private readonly running = new Map<string, { abort: AbortController; pid?: number }>();
    private readonly events = new EventEmitter();
    private disposed = false;

    constructor(private readonly runner: StorageRunner, private readonly settings: () => StorageAnalyzerSettings, private readonly now: () => number = Date.now) {}

    onDidChange(listener: (host: string) => void): { dispose(): void } {
        this.events.on('change', listener);
        return { dispose: () => this.events.off('change', listener) };
    }

    get(host: string): StorageResult | undefined {
        return this.results.get(host);
    }

    isRunning(host: string): boolean {
        return this.running.has(host);
    }

    clear(host: string): void {
        if (!this.running.has(host) && this.results.delete(host)) {
            this.events.emit('change', host);
        }
    }

    /** Runs one scan. Rejects if another scan is already running on this host. */
    async analyze(host: string, target: StorageTarget): Promise<StorageResult> {
        if (this.disposed) {
            throw new Error('ServerLens is shutting down.');
        }
        if (this.running.has(host)) {
            throw new Error('A storage scan is already running on this server.');
        }
        const settings = this.settings();
        const depth = Math.max(1, Math.min(4, target.depth || settings.depth));
        const nonce = newNonce();
        const script = buildMultiScanScript(target.paths, depth, settings.timeoutSeconds, nonce);
        const abort = new AbortController();
        const job: { abort: AbortController; pid?: number } = { abort };
        this.running.set(host, job);
        const result: StorageResult = {
            host, label: target.label, paths: target.paths, depth, state: 'running', startedAt: this.now(),
            entries: [], roots: [], omitted: 0, totalKiB: 0, timedOut: false, unreadable: 0, missing: []
        };
        this.results.set(host, result);
        this.events.emit('change', host);
        let buffered = '';
        try {
            const output = await this.runner.exec(host, script, {
                timeoutMs: (settings.timeoutSeconds + settings.sshTimeoutSeconds + 15) * 1000,
                connectTimeoutSeconds: settings.sshTimeoutSeconds,
                signal: abort.signal,
                maxOutputBytes: 32 * 1024 * 1024,
                onStdout: chunk => {
                    if (job.pid === undefined) {
                        buffered += chunk;
                        const match = buffered.match(new RegExp(`@@SL:${nonce}:pid (\\d+)@@`));
                        if (match) {
                            job.pid = Number(match[1]);
                            buffered = '';
                        }
                    }
                }
            });
            const parsed = parseScanOutput(output.stdout, nonce, target.paths);
            Object.assign(result, {
                entries: parsed.entries, roots: parsed.roots, omitted: parsed.omitted, totalKiB: parsed.totalKiB,
                missing: parsed.missing, filesystem: parsed.filesystem, unreadable: countUnreadable(output.stderr),
                timedOut: output.exitCode === 124, finishedAt: this.now()
            });
            if (parsed.notFound) {
                result.state = 'error';
                result.error = 'None of these folders exist or are readable on the server.';
            } else {
                result.state = 'done';
            }
        } catch (error) {
            result.finishedAt = this.now();
            if (error instanceof SshError && error.kind === 'cancelled') {
                result.state = 'cancelled';
                if (job.pid) {
                    // Closing the channel does not stop du at once; end it explicitly.
                    await this.runner.exec(host, buildStopScanScript(job.pid), {
                        timeoutMs: 10_000, connectTimeoutSeconds: settings.sshTimeoutSeconds
                    }).catch(() => undefined);
                }
            } else {
                result.state = 'error';
                result.error = error instanceof Error ? error.message : String(error);
            }
        } finally {
            this.running.delete(host);
            if (!this.disposed) {
                this.events.emit('change', host);
            }
        }
        return result;
    }

    cancel(host: string): void {
        this.running.get(host)?.abort.abort();
    }

    dispose(): void {
        this.disposed = true;
        for (const job of this.running.values()) {
            job.abort.abort();
        }
        this.events.removeAllListeners();
    }
}
