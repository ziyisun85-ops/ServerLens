// ServerLens: end-to-end collection. Runs the real batched script under /bin/sh and dash
// against fixture /proc files and fake nvidia-smi/df/quota/ps binaries, then checks what
// MonitorService makes of the output.
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRunner, MonitorConfig, MonitorService } from '../monitorService';
import { DEFAULT_HIDDEN_FS_TYPES, DEFAULT_HIDDEN_MOUNT_PATTERNS } from '../diskMetrics';
import { ExecOptions, ExecResult } from '../sshTransport';

const fixtures = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');

/** Executes scripts locally instead of over SSH, pointing /proc and /etc at fixtures. */
function localRunner(shell: string, mode: string, home: string): CommandRunner & { scripts: string[] } {
    const scripts: string[] = [];
    return {
        scripts,
        exec(_host: string, script: string, options: ExecOptions): Promise<ExecResult> {
            scripts.push(script);
            const localScript = script
                .split(`'/proc/`).join(`'${fixtures}/proc/`)
                .split(`'/etc/`).join(`'${fixtures}/etc/`);
            const startedAt = Date.now();
            return new Promise((resolve, reject) => {
                const child = cp.spawn(shell, ['-s'], {
                    env: { ...process.env, PATH: `${fixtures}/bin:${process.env.PATH}`, HOME: home, FAKE_MODE: mode },
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
                child.stdout.on('data', chunk => { stdout += chunk; });
                child.stderr.on('data', chunk => { stderr += chunk; });
                child.on('error', reject);
                child.on('close', code => {
                    clearTimeout(timer);
                    resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - startedAt, multiplexed: false });
                });
                child.stdin.end(localScript);
            });
        }
    };
}

function config(overrides: Partial<MonitorConfig> = {}, pinnedPaths: string[] = []): MonitorConfig {
    return {
        hosts: ['lab-node'],
        autoRefresh: false,
        pauseWhenHidden: false,
        intervals: { gpu: 5, cpu: 5, memory: 5, disk: 60 },
        slurmIntervalSeconds: 30,
        sshTimeoutSeconds: 8,
        maxConcurrentHosts: 4,
        gpuProcesses: true,
        processOwners: true,
        slurm: false,
        quota: true,
        diskFilters: () => ({ hiddenFsTypes: DEFAULT_HIDDEN_FS_TYPES, hiddenMountPatterns: DEFAULT_HIDDEN_MOUNT_PATTERNS, pinnedPaths }),
        ...overrides
    };
}

async function runShell(shell: string, home: string): Promise<void> {
    const runner = localRunner(shell, 'normal', home);
    const service = new MonitorService(runner, () => config({}, ['~/data', '/missing/path']));
    await service.refresh();
    const snapshot = service.getSnapshot('lab-node');
    assert.ok(snapshot, `${shell}: snapshot exists`);
    assert.strictEqual(snapshot.error, undefined, `${shell}: ${snapshot.error} ${snapshot.errorDetail || ''}`);
    assert.strictEqual(snapshot.gpuState, 'ok');
    assert.strictEqual(snapshot.gpus.length, 2);
    assert.strictEqual(snapshot.gpus[1].fanSpeed, 'N/A');
    assert.strictEqual(snapshot.gpus[1].processes.length, 2);
    assert.strictEqual(snapshot.gpus[1].processes[0].user, 'alice');
    assert.strictEqual(snapshot.gpus[1].processes[1].name, 'python,worker');
    assert.strictEqual(snapshot.cpu?.logicalCores, 4);
    assert.strictEqual(snapshot.cpu?.availableCores, 4);
    assert.strictEqual(snapshot.cpu?.load1, 4.12);
    assert.strictEqual(snapshot.cpu?.physicalCores, 2, 'Physical cores come from unique (physical id, core id) pairs.');
    assert.strictEqual(snapshot.cpu?.model, 'AMD EPYC 7763 64-Core Processor');
    assert.strictEqual(snapshot.memory?.availableKiB, 63313088);
    assert.strictEqual(snapshot.system?.os, 'Ubuntu 22.04.4 LTS');
    assert.strictEqual(snapshot.system?.uptimeSeconds, 864123);
    const disks = snapshot.disks;
    assert.ok(disks, `${shell}: disk report`);
    assert.deepStrictEqual(disks.disks.map(disk => disk.mountPoint), ['/data', '/', '/home', '/mnt/lustre']);
    assert.deepStrictEqual(disks.disks[0].pinnedPaths, ['~/data'], 'A pinned path under ~ resolves to its filesystem.');
    assert.deepStrictEqual(disks.disks[0].alsoMountedAt, ['/home/alice/data link']);
    assert.strictEqual(disks.disks[0].quota?.hardKiB, 5000000);
    assert.strictEqual(disks.disks[0].quota?.overSoftLimit, true);
    assert.strictEqual(disks.disks[2].quota?.softKiB, 524288000, 'NFS quota is matched by export.');
    assert.strictEqual(disks.disks[3].quota?.source, 'lustre');
    assert.deepStrictEqual(disks.missingPinnedPaths, ['/missing/path']);
    assert.strictEqual(disks.quotaToolAvailable, true);
    assert.ok(snapshot.updatedAt?.gpu && snapshot.updatedAt.disk && snapshot.updatedAt.cpu && snapshot.updatedAt.memory);
    assert.ok(runner.scripts[0].includes('sleep 0.5'), 'The first CPU sample reads /proc/stat twice.');

    await service.refresh();
    assert.ok(!runner.scripts[1].includes('sleep 0.5'), 'Later CPU samples use the previous collection instead of sleeping.');
    service.dispose();
}

async function runModes(home: string): Promise<void> {
    // No NVIDIA driver: the server is online and shows CPU, memory and disks.
    const noSmiPath = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-nosmi-'));
    for (const tool of ['df', 'timeout', 'quota', 'lfs', 'ps', 'nproc', 'id']) {
        fs.symlinkSync(path.join(fixtures, 'bin', tool), path.join(noSmiPath, tool));
    }
    const noGpu = new MonitorService({
        exec: (_host, script) => new Promise((resolve, reject) => {
            const local = script.split(`'/proc/`).join(`'${fixtures}/proc/`).split(`'/etc/`).join(`'${fixtures}/etc/`);
            const child = cp.spawn('/bin/sh', ['-s'], { env: { ...process.env, PATH: `${noSmiPath}:/usr/bin:/bin`, HOME: home } });
            let stdout = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.on('error', reject);
            child.on('close', code => resolve({ stdout, stderr: '', exitCode: code, durationMs: 1, multiplexed: false }));
            child.stdin.end(local);
        })
    }, () => config());
    await noGpu.refresh();
    const cpuOnlySnapshot = noGpu.getSnapshot('lab-node');
    assert.strictEqual(cpuOnlySnapshot?.error, undefined);
    assert.strictEqual(cpuOnlySnapshot?.gpuState, 'missing', 'A host without nvidia-smi is CPU-only, not offline.');
    assert.ok(cpuOnlySnapshot?.memory && cpuOnlySnapshot.disks?.disks.length);
    noGpu.dispose();
    fs.rmSync(noSmiPath, { recursive: true, force: true });

    // Broken driver: GPU error is reported, the host stays online.
    const broken = new MonitorService(localRunner('/bin/sh', 'smi-broken', home), () => config());
    await broken.refresh();
    const brokenSnapshot = broken.getSnapshot('lab-node');
    assert.strictEqual(brokenSnapshot?.error, undefined);
    assert.strictEqual(brokenSnapshot?.gpuState, 'error');
    assert.ok(brokenSnapshot?.gpuError?.includes('NVIDIA driver'));
    assert.ok(brokenSnapshot?.cpu && brokenSnapshot.memory);
    broken.dispose();

    // Hung network mount: df times out, the local filesystems are still shown.
    const hung = new MonitorService(localRunner('/bin/sh', 'df-hang', home), () => config());
    await hung.refresh();
    const hungDisks = hung.getSnapshot('lab-node')?.disks;
    assert.strictEqual(hungDisks?.partial, true);
    assert.ok(hungDisks?.error?.includes('network filesystem'));
    assert.deepStrictEqual(hungDisks?.disks.map(disk => disk.mountPoint), ['/data', '/']);
    hung.dispose();

    // nvidia-smi that does not answer in time: reported, retried with a longer limit next round.
    const slowRunner = localRunner('/bin/sh', 'smi-slow', home);
    const slow = new MonitorService(slowRunner, () => config());
    await slow.refresh();
    assert.strictEqual(slow.getSnapshot('lab-node')?.gpuError, 'nvidia-smi did not respond in time.');
    assert.ok(slow.getSnapshot('lab-node')?.memory, 'A slow nvidia-smi does not hide CPU, memory and disks.');
    await slow.refresh();
    assert.ok(/SL_GTO=45$/m.test(slowRunner.scripts[1]), 'After a GPU timeout the next round allows nvidia-smi more time.');
    assert.ok(slowRunner.scripts[0].includes('timeout -k 2'), 'GNU timeout also kills commands that ignore SIGTERM.');
    slow.dispose();

    // df without -T (old busybox): types come from /proc/mounts.
    const noType = new MonitorService(localRunner('/bin/sh', 'df-notype', home), () => config());
    await noType.refresh();
    const noTypeDisks = noType.getSnapshot('lab-node')?.disks;
    assert.strictEqual(noTypeDisks?.typesFromMounts, true);
    assert.strictEqual(noTypeDisks?.disks.find(disk => disk.mountPoint === '/data')?.fsType, 'xfs');
    noType.dispose();
}

async function main(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-home-'));
    fs.mkdirSync(path.join(home, 'data'));
    try {
        const shells = ['/bin/sh', '/bin/dash', '/bin/bash'].filter(shell => fs.existsSync(shell));
        for (const shell of shells) {
            await runShell(shell, home);
        }
        await runModes(home);
        console.log(`Batched collection script parsed end-to-end under ${shells.join(', ')}; CPU-only, broken driver, hung df and df without -T handled.`);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
