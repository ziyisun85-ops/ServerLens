// Manual integration check against real servers (not part of npm test).
// Usage: node scripts/integration.js <host> [<host>...] [--du <host>]
// Runs read-only collection twice per host through the real ssh client and the user's
// SSH config, prints a summary without process commands or user names, and optionally
// runs one Home-directory scan (depth 1, 30 s limit, low priority).
const cp = require('child_process');
const path = require('path');
const { SshTransport } = require('../out/sshTransport');
const { MonitorService } = require('../out/monitorService');
const { StorageAnalyzer } = require('../out/storageAnalyzer');
const { DEFAULT_HIDDEN_FS_TYPES, DEFAULT_HIDDEN_MOUNT_PATTERNS } = require('../out/diskMetrics');

const hosts = [];
let duHost;
for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--du') {
        duHost = process.argv[++index];
    } else {
        hosts.push(process.argv[index]);
    }
}
if (!hosts.length) {
    console.error('usage: node scripts/integration.js <host> [...] [--du <host>]');
    process.exit(2);
}
const log = { debug: () => undefined, info: message => console.log('  [info]', message), warn: message => console.log('  [warn]', message), error: message => console.log('  [error]', message) };
const transport = new SshTransport(() => ({ connectionReuse: true, controlPersistSeconds: 30 }), log);
const config = () => ({
    hosts, autoRefresh: false, pauseWhenHidden: false, intervals: { gpu: 5, cpu: 5, memory: 5, disk: 60 }, slurmIntervalSeconds: 30,
    sshTimeoutSeconds: 10, maxConcurrentHosts: 2, gpuProcesses: true, processOwners: true, slurm: true, quota: true,
    diskFilters: () => ({ hiddenFsTypes: DEFAULT_HIDDEN_FS_TYPES, hiddenMountPatterns: DEFAULT_HIDDEN_MOUNT_PATTERNS, pinnedPaths: ['~'] })
});
const monitor = new MonitorService(transport, config, log);

function summarize(snapshot) {
    const gpus = snapshot.gpus;
    const models = Array.from(new Set(gpus.map(gpu => gpu.name)));
    return {
        error: snapshot.error ? `${snapshot.errorCategory}: ${snapshot.error}` : undefined,
        latencyMs: snapshot.latencyMs,
        sharedConnection: snapshot.multiplexed,
        gpuState: snapshot.gpuState,
        gpuError: snapshot.gpuError,
        gpus: `${gpus.length} × ${models.join(', ')}`,
        gpuProcesses: gpus.reduce((sum, gpu) => sum + gpu.processes.length, 0),
        processOwnersResolved: gpus.flatMap(gpu => gpu.processes).filter(process => process.user !== 'unknown').length,
        cpu: snapshot.cpu && {
            usage: snapshot.cpu.usagePercent === undefined ? undefined : snapshot.cpu.usagePercent.toFixed(1) + '%',
            iowait: snapshot.cpu.iowaitPercent === undefined ? undefined : snapshot.cpu.iowaitPercent.toFixed(1) + '%',
            logical: snapshot.cpu.logicalCores, physical: snapshot.cpu.physicalCores, usable: snapshot.cpu.availableCores,
            load: [snapshot.cpu.load1, snapshot.cpu.load5, snapshot.cpu.load15].join(' / '), windowMs: snapshot.cpu.windowMs, model: snapshot.cpu.model
        },
        memory: snapshot.memory && { used: snapshot.memory.usedPercent.toFixed(1) + '%', totalGiB: (snapshot.memory.totalKiB / 1048576).toFixed(1),
            availableGiB: (snapshot.memory.availableKiB / 1048576).toFixed(1), estimated: snapshot.memory.availableEstimated, swap: snapshot.memory.swapPercent.toFixed(1) + '%' },
        system: snapshot.system && { os: snapshot.system.os, kernel: snapshot.system.kernel, uptimeDays: Math.round((snapshot.system.uptimeSeconds || 0) / 86400) },
        disks: snapshot.disks && snapshot.disks.disks.map(disk => `${disk.mountPoint} [${disk.fsType}${disk.network ? ', network' : ''}${disk.pinned ? ', pinned ' + disk.pinnedPaths.join(',') : ''}] ${disk.usedPercent}%` +
            (disk.alsoMountedAt.length ? ` (+${disk.alsoMountedAt.length} more mount points)` : '') + (disk.quota ? ` quota ${Math.round(disk.quota.usedKiB / 1048576)}/${Math.round((disk.quota.hardKiB || disk.quota.softKiB) / 1048576)} GiB` : '')),
        hiddenFilesystems: snapshot.disks && snapshot.disks.hidden.length,
        quotaTool: snapshot.disks && snapshot.disks.quotaToolAvailable,
        otherQuotas: snapshot.disks && snapshot.disks.otherQuotas.length,
        diskNote: snapshot.disks && snapshot.disks.error
    };
}

function masterCheck(host) {
    const directory = transport.controlDirectory();
    const result = cp.spawnSync('ssh', ['-o', `ControlPath=${path.join(directory, '%C')}`, '-O', 'check', host], { encoding: 'utf8' });
    return (result.stderr || result.stdout).trim();
}

async function main() {
    for (let round = 1; round <= 2; round += 1) {
        const startedAt = Date.now();
        await monitor.refresh();
        console.log(`\n=== Round ${round} (${Date.now() - startedAt} ms for ${hosts.length} host(s))`);
        for (const snapshot of monitor.getSnapshots()) {
            console.log(snapshot.host, JSON.stringify(summarize(snapshot), null, 2));
        }
        if (round === 1) {
            for (const host of hosts) console.log(`ControlMaster check ${host}:`, masterCheck(host));
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    if (duHost) {
        const storage = new StorageAnalyzer(transport, () => ({ depth: 1, timeoutSeconds: 30, sshTimeoutSeconds: 10 }));
        const result = await storage.analyze(duHost, { label: 'Home directory', paths: ['~'], depth: 1 });
        console.log(`\n=== Storage scan on ${duHost}: ${result.state} in ${result.finishedAt - result.startedAt} ms, total ${(result.totalKiB / 1048576).toFixed(2)} GiB,` +
            ` ${result.entries.length} folders, timedOut=${result.timedOut}, unreadable=${result.unreadable}, error=${result.error || '-'}`);
        console.log('Largest five (sizes only):', result.entries.slice(0, 5).map(entry => (entry.kib / 1048576).toFixed(2) + ' GiB').join(', '));
    }
    monitor.dispose();
    await transport.dispose();
    for (const host of hosts) console.log(`After dispose, ControlMaster check ${host}:`, masterCheck(host));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
