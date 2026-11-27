// ServerLens: MonitorService scheduling with a fake clock and a fake command runner.
import * as assert from 'assert';
import { Clock, CommandRunner, MonitorConfig, MonitorService } from '../monitorService';
import { ExecOptions, ExecResult, SshError } from '../sshTransport';

class FakeClock implements Clock {
    time = 1_000_000;
    private timers: { at: number; callback: () => void; id: number }[] = [];
    private nextId = 1;
    now(): number { return this.time; }
    setTimeout(callback: () => void, ms: number): unknown {
        const id = this.nextId++;
        this.timers.push({ at: this.time + ms, callback, id });
        return id;
    }
    clearTimeout(handle: unknown): void { this.timers = this.timers.filter(timer => timer.id !== handle); }
    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        for (;;) {
            await flush();
            this.timers.sort((left, right) => left.at - right.at);
            const next = this.timers[0];
            if (!next || next.at > target) {
                break;
            }
            this.timers.shift();
            this.time = next.at;
            next.callback();
        }
        this.time = target;
        await flush();
    }
}

async function flush(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

interface Call { host: string; sections: string[]; options: ExecOptions; resolve: () => void; reject: (error: Error) => void; }

/** Answers each script with well-formed output for the sections it requested. */
class FakeRunner implements CommandRunner {
    calls: Call[] = [];
    autoResolve = true;
    failHosts = new Map<string, SshError>();
    exec(host: string, script: string, options: ExecOptions): Promise<ExecResult> {
        const nonce = script.match(/^SL_N=([0-9a-f]+)$/m)?.[1] || '';
        const sections = Array.from(script.matchAll(/^sl_begin (\w+)$/gm)).map(match => match[1]);
        return new Promise((resolve, reject) => {
            const answer = () => {
                const failure = this.failHosts.get(host);
                if (failure) {
                    reject(failure);
                    return;
                }
                const body: Record<string, string> = {
                    gpu: '0, GPU-1, NVIDIA A100, 50, 10, 40960, 20480, 20480, 50, 200, 400, 30',
                    cpu: 'stat cpu 100 0 100 800 0 0 0 0\nncpu 8\nloadavg 1 1 1 1/100 5\nnproc 8',
                    mem: 'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB',
                    sys: 'hostname h\nuptime 100',
                    df: 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 900 100 90% /'
                };
                const output = sections.map(name => `@@SL:${nonce}:begin ${name}@@\n${body[name] || ''}\n@@SL:${nonce}:end ${name} 0@@`).join('\n');
                resolve({ stdout: `${output}\n@@SL:${nonce}:done@@\n`, stderr: '', exitCode: 0, durationMs: 5, multiplexed: true });
            };
            const call: Call = { host, sections, options, resolve: answer, reject };
            this.calls.push(call);
            options.signal?.addEventListener('abort', () => reject(new SshError('Cancelled.', 'cancelled')), { once: true });
            if (this.autoResolve) {
                answer();
            }
        });
    }
}

function baseConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
    return {
        hosts: ['a'],
        autoRefresh: true,
        pauseWhenHidden: false,
        intervals: { gpu: 5, cpu: 5, memory: 5, disk: 60 },
        slurmIntervalSeconds: 30,
        sshTimeoutSeconds: 8,
        maxConcurrentHosts: 8,
        gpuProcesses: true,
        processOwners: false,
        slurm: false,
        quota: false,
        diskFilters: () => ({ hiddenFsTypes: [], hiddenMountPatterns: [], pinnedPaths: [] }),
        ...overrides
    };
}

async function testIntervalsAndBatching(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const service = new MonitorService(runner, () => baseConfig(), undefined, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 1, 'The first round collects once.');
    assert.deepStrictEqual(runner.calls[0].sections, ['gpu', 'gpuproc', 'cpu', 'mem', 'sys', 'df'], 'Everything due is batched into one script.');
    await clock.advance(5_000);
    assert.strictEqual(runner.calls.length, 2);
    assert.deepStrictEqual(runner.calls[1].sections, ['gpu', 'gpuproc', 'cpu', 'mem'], 'Disk is not re-read every 5 s.');
    await clock.advance(55_000);
    const withDisk = runner.calls.filter(call => call.sections.includes('df'));
    assert.strictEqual(withDisk.length, 2, 'Disk runs again after 60 s.');
    assert.ok(withDisk[1].sections.includes('gpu'), 'The disk read rides along with a GPU round instead of a separate SSH command.');
    const rounds = runner.calls.length;
    assert.ok(rounds >= 12 && rounds <= 13, `about one round per 5 s, got ${rounds}`);
    const snapshot = service.getSnapshot('a');
    assert.strictEqual(snapshot?.memory?.usedKiB, 600);
    assert.strictEqual(snapshot?.disks?.disks[0].usedPercent, 90);
    service.dispose();
}

async function testCustomIntervals(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const service = new MonitorService(runner, () => baseConfig({ intervals: { gpu: 2, cpu: 10, memory: 10, disk: 30 } }), undefined, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(20_050);
    const gpuRounds = runner.calls.filter(call => call.sections.includes('gpu')).length;
    const cpuRounds = runner.calls.filter(call => call.sections.includes('cpu')).length;
    assert.ok(gpuRounds >= 9, `GPU every 2 s, got ${gpuRounds}`);
    assert.ok(cpuRounds >= 2 && cpuRounds <= 3, `CPU every 10 s, got ${cpuRounds}`);
    service.dispose();
}

async function testNoOverlapAndManualRefresh(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    runner.autoResolve = false;
    const service = new MonitorService(runner, () => baseConfig(), undefined, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 1);
    await clock.advance(30_000);
    assert.strictEqual(runner.calls.length, 1, 'A slow host is never collected twice at the same time.');
    const refreshes = [service.refresh(['a']), service.refresh(['a']), service.refresh(['a'])];
    await flush();
    assert.strictEqual(runner.calls.length, 1);
    runner.calls[0].resolve();
    await flush();
    assert.strictEqual(runner.calls.length, 2, 'Several manual refreshes during a collection queue exactly one more.');
    assert.deepStrictEqual(runner.calls[1].sections, ['gpu', 'gpuproc', 'cpu', 'mem', 'sys', 'df'], 'A manual refresh collects everything.');
    runner.calls[1].resolve();
    await Promise.all(refreshes);
    service.dispose();
}

async function testConcurrencyLimit(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    runner.autoResolve = false;
    const service = new MonitorService(runner, () => baseConfig({ hosts: ['a', 'b', 'c', 'd', 'e'], maxConcurrentHosts: 2 }), undefined, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 2, 'At most maxConcurrentHosts collections run at once.');
    assert.deepStrictEqual(service.activity(), { running: 2, queued: 3, total: 5 });
    runner.calls[0].resolve();
    await flush();
    assert.strictEqual(runner.calls.length, 3);
    for (const call of runner.calls.slice(1)) {
        call.resolve();
    }
    await flush();
    for (const call of runner.calls.slice(3)) {
        call.resolve();
    }
    await flush();
    assert.deepStrictEqual(runner.calls.map(call => call.host).sort(), ['a', 'b', 'c', 'd', 'e']);
    service.dispose();
}

async function testBackoffAndRecovery(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const service = new MonitorService(runner, () => baseConfig({ hosts: ['ok', 'down'] }), undefined, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    runner.failHosts.set('down', new SshError('Server is unreachable.', 'unreachable', 'No route to host'));
    await clock.advance(5_000);
    const down = service.getSnapshot('down');
    assert.strictEqual(down?.errorCategory, 'unreachable');
    assert.strictEqual(down?.stale, true, 'Last good data stays visible and is marked stale.');
    assert.ok(down?.lastSuccessAt && down.lastSuccessAt < clock.now());
    assert.ok(down?.memory, 'Previous metrics are kept.');
    const firstRetry = (down?.nextRetryAt || 0) - clock.now();
    assert.ok(firstRetry >= 9_000 && firstRetry <= 10_000, `first retry after ~10 s, got ${firstRetry}`);
    const callsBefore = runner.calls.filter(call => call.host === 'down').length;
    await clock.advance(9_000);
    assert.strictEqual(runner.calls.filter(call => call.host === 'down').length, callsBefore, 'No automatic attempt during backoff.');
    await clock.advance(2_000);
    assert.strictEqual(runner.calls.filter(call => call.host === 'down').length, callsBefore + 1);
    const secondRetry = (service.getSnapshot('down')?.nextRetryAt || 0) - clock.now();
    assert.ok(secondRetry > 15_000, `backoff doubles, got ${secondRetry}`);
    const okCalls = runner.calls.filter(call => call.host === 'ok').length;
    assert.ok(okCalls >= 4, 'A failing host does not slow down healthy ones.');
    runner.failHosts.delete('down');
    await service.refresh(['down']);
    const recovered = service.getSnapshot('down');
    assert.strictEqual(recovered?.error, undefined, 'A manual refresh bypasses backoff and clears the error.');
    assert.strictEqual(recovered?.stale, false);
    service.dispose();
}

async function testPauseWhenHidden(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    let config = baseConfig({ pauseWhenHidden: true });
    const service = new MonitorService(runner, () => config, undefined, clock);
    await clock.advance(30_000);
    assert.strictEqual(runner.calls.length, 0, 'Nothing runs while no view is visible.');
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 1);
    service.setConsumerVisible('sidebar', false);
    await clock.advance(60_000);
    assert.strictEqual(runner.calls.length, 1, 'Hiding the last view pauses automatic refresh.');
    service.setConsumerVisible('dashboard', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 2, 'Overdue metrics run as soon as any view is visible again.');
    config = baseConfig({ pauseWhenHidden: true, autoRefresh: false });
    service.reconfigure();
    await clock.advance(60_000);
    assert.strictEqual(runner.calls.length, 2, 'With automatic refresh off, only manual refreshes run.');
    await service.refresh();
    assert.strictEqual(runner.calls.length, 3);
    service.dispose();
}

async function testDiskSuspensionOnTimeout(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const service = new MonitorService(runner, () => baseConfig(), undefined, clock);
    runner.failHosts.set('a', new SshError('Timed out after 32 s.', 'timeout'));
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.ok(runner.calls[0].sections.includes('df'));
    runner.failHosts.delete('a');
    await clock.advance(11_000);
    const retry = runner.calls[1];
    assert.ok(retry && !retry.sections.includes('df'), 'After a timeout with df, df is left out so GPU/CPU/memory keep updating.');
    await clock.advance(10 * 60_000);
    assert.ok(runner.calls.slice(2).some(call => call.sections.includes('df')), 'df is retried later.');
    service.dispose();
}

async function testHostChangesAndDispose(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    runner.autoResolve = false;
    let hosts = ['a', 'b'];
    const service = new MonitorService(runner, () => baseConfig({ hosts }), undefined, clock);
    const changes: string[][] = [];
    service.onDidChangeHosts(value => changes.push(value));
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    hosts = ['b', 'c'];
    service.reconfigure();
    assert.deepStrictEqual(service.hosts(), ['b', 'c']);
    assert.deepStrictEqual(changes.at(-1), ['b', 'c']);
    assert.strictEqual(runner.calls.find(call => call.host === 'a')?.options.signal?.aborted, true, 'Removing a host cancels its collection.');
    assert.strictEqual(service.getSnapshot('a'), undefined);
    const pending = runner.calls.find(call => call.host === 'b');
    service.dispose();
    assert.strictEqual(pending?.options.signal?.aborted, true, 'Dispose cancels running collections.');
    const count = runner.calls.length;
    await clock.advance(60_000);
    assert.strictEqual(runner.calls.length, count, 'No timers survive dispose.');
}

async function testConfigErrorsKeepTheTimer(): Promise<void> {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    let broken = false;
    const errors: string[] = [];
    const log = { debug() {}, info() {}, warn() {}, error: (message: string) => { errors.push(message); } };
    const service = new MonitorService(runner, () => {
        if (broken) {
            throw new Error('settings exploded');
        }
        return baseConfig();
    }, log, clock);
    service.setConsumerVisible('sidebar', true);
    await clock.advance(100);
    assert.strictEqual(runner.calls.length, 1);
    broken = true;
    await clock.advance(5_000);
    assert.ok(errors.some(message => message.includes('settings exploded')), 'The failure is logged.');
    broken = false;
    await clock.advance(31_000);
    assert.ok(runner.calls.length >= 2, 'Collection resumes once the settings can be read again.');
    service.dispose();
}

async function main(): Promise<void> {
    await testIntervalsAndBatching();
    await testConfigErrorsKeepTheTimer();
    await testCustomIntervals();
    await testNoOverlapAndManualRefresh();
    await testConcurrencyLimit();
    await testBackoffAndRecovery();
    await testPauseWhenHidden();
    await testDiskSuspensionOnTimeout();
    await testHostChangesAndDispose();
    console.log('Scheduler: independent intervals, batching, no overlap, concurrency limit, backoff, pause when hidden, df isolation and dispose passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
