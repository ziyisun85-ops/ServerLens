// ServerLens: directory analysis (local du run, parsing, cancellation) and disk alert rules.
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildMultiScanScript, parseScanOutput, parseStoragePathSetting, StorageAnalyzer, StorageRunner, STORAGE_PRESETS
} from '../storageAnalyzer';
import { DiskAlertTracker, GpuTransitionTracker, KeyValueStore } from '../alerts';
import { ServerStatus } from '../fleetModel';
import { DiskInfo } from '../diskMetrics';
import { ExecOptions, ExecResult, SshError } from '../sshTransport';

function localRunner(home: string): StorageRunner {
    return {
        exec(_host: string, script: string, options: ExecOptions): Promise<ExecResult> {
            return new Promise((resolve, reject) => {
                const child = cp.spawn('/bin/sh', ['-s'], { env: { ...process.env, HOME: home } });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', chunk => { stdout += chunk; options.onStdout?.(String(chunk)); });
                child.stderr.on('data', chunk => { stderr += chunk; });
                child.on('error', reject);
                child.on('close', code => resolve({ stdout, stderr, exitCode: code, durationMs: 1, multiplexed: false }));
                child.stdin.end(script);
            });
        }
    };
}

function write(file: string, bytes: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(bytes));
}

async function testLocalScan(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-du-'));
    try {
        write(path.join(home, 'checkpoints', 'run1', 'model.pt'), 3 * 1024 * 1024);
        write(path.join(home, 'datasets', 'imagenet', 'part.bin'), 1024 * 1024);
        write(path.join(home, 'logs', 'train.log'), 64 * 1024);
        write(path.join(home, '.cache', 'pip', 'wheel.whl'), 512 * 1024);
        const analyzer = new StorageAnalyzer(localRunner(home), () => ({ depth: 2, timeoutSeconds: 30, sshTimeoutSeconds: 5 }));
        const changes: string[] = [];
        analyzer.onDidChange(host => changes.push(host));
        const result = await analyzer.analyze('lab', { label: 'Home', paths: ['~', '~/does-not-exist'] });
        assert.strictEqual(result.state, 'done', result.error);
        assert.deepStrictEqual(result.missing, ['~/does-not-exist'], 'Missing folders are listed, not fatal.');
        assert.strictEqual(result.roots[0].path, '~');
        assert.strictEqual(result.entries[0].path, '~/checkpoints', 'Largest folders come first.');
        assert.ok(result.entries[0].kib >= 3072);
        assert.ok(result.entries.some(entry => entry.path === '~/checkpoints/run1'), 'Depth 2 lists nested folders.');
        assert.ok(result.entries.findIndex(entry => entry.path === '~/datasets') < result.entries.findIndex(entry => entry.path === '~/logs'));
        assert.ok(result.totalKiB >= 4600);
        assert.ok(result.filesystem && result.filesystem.totalKiB > 0, 'The free space of the scanned filesystem is reported.');
        assert.ok(changes.length >= 2, 'Running and finished states are published.');
        assert.ok(!analyzer.isRunning('lab'));
        const none = await analyzer.analyze('lab', { label: 'Nothing', paths: ['~/nope'] });
        assert.strictEqual(none.state, 'error');
        analyzer.clear('lab');
        assert.strictEqual(analyzer.get('lab'), undefined);
        analyzer.dispose();
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function testCancelAndExclusivity(): Promise<void> {
    const scripts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const runner: StorageRunner = {
        exec(_host, script, options) {
            scripts.push(script);
            if (scripts.length > 1) {
                return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, multiplexed: true });
            }
            const nonce = script.match(/^SL_N=([0-9a-f]+)$/m)?.[1];
            options.onStdout?.(`@@SL:${nonce}:pid 31337@@\n`);
            return new Promise((_resolve, reject) => {
                releaseFirst = () => reject(new SshError('Cancelled.', 'cancelled'));
                options.signal?.addEventListener('abort', () => releaseFirst?.(), { once: true });
            });
        }
    };
    const analyzer = new StorageAnalyzer(runner, () => ({ depth: 1, timeoutSeconds: 60, sshTimeoutSeconds: 5 }));
    const scan = analyzer.analyze('lab', STORAGE_PRESETS[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(analyzer.isRunning('lab'));
    await assert.rejects(analyzer.analyze('lab', STORAGE_PRESETS[0]), /already running/, 'Only one scan per server at a time.');
    analyzer.cancel('lab');
    const result = await scan;
    assert.strictEqual(result.state, 'cancelled');
    assert.ok(scripts[1].includes('sl_p=31337') && scripts[1].includes('kill -TERM'), 'Cancelling stops the remote du by PID.');
    assert.ok(scripts[0].includes('nice -n 19') && scripts[0].includes('ionice -c3') && scripts[0].includes('du -x -k -d 1'));
    assert.ok(scripts[0].includes('timeout 60'), 'The remote scan has its own time limit.');
    analyzer.dispose();

    assert.deepStrictEqual(parseStoragePathSetting(['Checkpoints=/data/alice/ckpt', '~/projects', 'bad path', 'Logs = ~/logs']), [
        { label: 'Checkpoints', paths: ['/data/alice/ckpt'] },
        { label: '~/projects', paths: ['~/projects'] },
        { label: 'Logs', paths: ['~/logs'] }
    ]);
    assert.throws(() => buildMultiScanScript([], 1, 10, 'ab'));
    const parsed = parseScanOutput('@@SL:ab:home /home/a@@\n@@SL:ab:pid 5@@\n10\t/home/a/x\n30\t/home/a\n', 'ab', ['~']);
    assert.strictEqual(parsed.totalKiB, 30);
    assert.deepStrictEqual(parsed.entries, [{ path: '~/x', kib: 10, root: false }]);
}

class MemoryStore implements KeyValueStore {
    values = new Map<string, unknown>();
    get<T>(key: string, fallback: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
    async update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); }
}

function server(usages: Record<string, number>, error?: string): ServerStatus {
    const disks: DiskInfo[] = Object.entries(usages).map(([mountPoint, usedPercent]) => ({
        id: mountPoint, mountPoint, alsoMountedAt: [], pinnedPaths: [], pinned: false, source: '/dev/x', fsType: 'ext4',
        network: false, totalKiB: 100, usedKiB: usedPercent, availKiB: 100 - usedPercent, usedPercent
    }));
    return {
        host: 'gpu-01', gpus: [], collectedAt: 0, latencyMs: 1, stale: false, error,
        disks: { disks, hidden: [], otherQuotas: [], quotaToolAvailable: false, missingPinnedPaths: [], partial: false, typesFromMounts: false }
    };
}

async function testDiskAlerts(): Promise<void> {
    let now = 1000;
    const store = new MemoryStore();
    const tracker = new DiskAlertTracker(store, () => now);
    const fire = async (usages: Record<string, number>, mode: 'off' | 'warning' | 'critical' = 'critical') =>
        (await tracker.evaluate(server(usages), mode, 70, 90)).map(alert => `${alert.mountPoint}:${alert.level}`);
    assert.deepStrictEqual(await fire({ '/data': 85 }), [], 'Below the critical threshold nothing fires in critical mode.');
    assert.deepStrictEqual(await fire({ '/data': 93 }), ['/data:critical']);
    assert.deepStrictEqual(await fire({ '/data': 95 }), [], 'An active alert does not repeat.');
    assert.deepStrictEqual(await fire({ '/data': 89 }), [], 'Hovering just under the threshold does not re-arm.');
    assert.deepStrictEqual(await fire({ '/data': 91 }), []);
    assert.deepStrictEqual(await fire({ '/data': 87 }), [], 'Dropping two points below re-arms silently.');
    assert.deepStrictEqual(await fire({ '/data': 90 }), ['/data:critical']);

    const reloaded = new DiskAlertTracker(store, () => now);
    assert.deepStrictEqual((await reloaded.evaluate(server({ '/data': 96 }), 'critical', 70, 90)).length, 0, 'Reloading VS Code does not repeat alerts.');

    assert.deepStrictEqual(await fire({ '/home': 75 }, 'warning'), ['/home:warning']);
    assert.deepStrictEqual(await fire({ '/home': 92 }, 'warning'), ['/home:critical'], 'Escalation from warning to critical notifies.');
    assert.deepStrictEqual(await fire({ '/home': 95 }, 'off'), []);

    await tracker.mute(['gpu-01\u0000/scratch']);
    assert.strictEqual(tracker.isMuted('gpu-01', '/scratch'), true);
    assert.deepStrictEqual(await fire({ '/scratch': 99 }), [], 'Muted disks never notify.');
    await tracker.snooze(['gpu-01\u0000/tmpdata'], 60_000);
    assert.deepStrictEqual(await fire({ '/tmpdata': 99 }), [], 'Snoozed disks stay quiet until the snooze ends.');
    now += 120_000;
    assert.deepStrictEqual(await fire({ '/tmpdata': 50 }), []);
    assert.deepStrictEqual(await fire({ '/tmpdata': 99 }), ['/tmpdata:critical'], 'After the snooze, a new crossing notifies.');
    assert.deepStrictEqual(await tracker.evaluate(server({ '/x': 99 }, 'unreachable'), 'critical', 70, 90), [], 'Offline hosts do not alert on stale data.');
    assert.strictEqual(await tracker.reset(), 1);
    assert.strictEqual(tracker.isMuted('gpu-01', '/scratch'), false);
}

function testGpuTransitions(): void {
    let now = 0;
    const tracker = new GpuTransitionTracker(() => now);
    const settings = { enabled: true, events: new Set(['serverState', 'gpuAvailable', 'threshold']), cooldownMs: 60_000, memoryWarningThreshold: 85, temperatureWarningThreshold: 80, powerWarningThreshold: 90 };
    const gpu = (available: boolean, used: number) => ({
        index: '0', uuid: 'GPU-0', name: 'A100', utilization: { gpu: '0 %', memory: '0 %' },
        memory: { total: '100 MiB', free: `${100 - used} MiB`, used: `${used} MiB` }, temperature: { gpu: '40 C' },
        power: { draw: '50 W', limit: '400 W' }, fanSpeed: 'N/A', processes: [], availability: { available, reasons: [] }
    });
    const status = (available: boolean, used: number, error?: string): ServerStatus => ({ host: 'h', gpus: [gpu(available, used)], collectedAt: 0, latencyMs: 0, stale: false, error });
    assert.deepStrictEqual(tracker.evaluate(status(false, 90), settings), ['h GPU 0 crossed a warning threshold']);
    now += 1000;
    assert.deepStrictEqual(tracker.evaluate(status(true, 10), settings), [], 'Notifications respect the cooldown.');
    now += 120_000;
    assert.deepStrictEqual(tracker.evaluate(status(true, 10, 'down'), settings), ['h is offline']);
    assert.deepStrictEqual(tracker.evaluate(status(true, 10), { ...settings, enabled: false }), []);
}

async function main(): Promise<void> {
    await testLocalScan();
    await testCancelAndExclusivity();
    await testDiskAlerts();
    testGpuTransitions();
    console.log('Storage analysis (local du, sorting, missing folders, cancel, one scan per host) and disk/GPU alert rules passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
