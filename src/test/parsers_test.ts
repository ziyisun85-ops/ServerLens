// ServerLens: unit tests for the CPU, memory, disk, quota, GPU and script-output parsers.
import * as assert from 'assert';
import { cpuUsageBetween, parseCpuSection, parseCpuTimes, parseMemInfo, parseSystemSection } from '../hostMetrics';
import {
    buildDiskReport, DEFAULT_HIDDEN_FS_TYPES, DEFAULT_HIDDEN_MOUNT_PATTERNS, entriesForHost, isNetworkFs,
    parseDf, parsePinnedDf, parseProcMounts, parseQuota, parseLustreQuota
} from '../diskMetrics';
import { formatBytePair, formatBytes, formatDurationSeconds, percentCeil, usageLevel } from '../format';
import { shellPath, shellQuote, splitScriptOutput, validateRemotePath, buildStopScanScript } from '../remoteScript';
import { GpuMonitor } from '../gpuMonitor';
import { plainText } from '../log';
import { normalizeSshConfigPath, resolveSshConfigPath, SshConfigParser, sshConfigArguments } from '../sshConfig';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const filters = { hiddenFsTypes: DEFAULT_HIDDEN_FS_TYPES, hiddenMountPatterns: DEFAULT_HIDDEN_MOUNT_PATTERNS, pinnedPaths: [] as string[] };

function testCpu(): void {
    const first = parseCpuTimes('cpu  100 0 50 800 50 0 0 0 0 0');
    const second = parseCpuTimes('cpu  160 0 70 900 70 0 0 0 0 0');
    assert.ok(first && second);
    const usage = cpuUsageBetween(first, second);
    assert.ok(usage);
    // Δtotal = 60+20+100+20 = 200; Δidle(all) = 100+20 = 120 → 40 % busy.
    assert.strictEqual(Math.round(usage.usagePercent), 40);
    assert.strictEqual(Math.round(usage.iowaitPercent), 10);
    assert.strictEqual(cpuUsageBetween(second, first), undefined, 'Counters that go backwards (reboot) give no usage.');
    assert.strictEqual(parseCpuTimes('cpu0 1 2 3 4'), undefined, 'Only the aggregate line is used.');
    const old = parseCpuTimes('cpu 10 20 30 40');
    assert.strictEqual(old?.steal, 0, 'Old kernels with four fields still parse.');
    const idleStart = parseCpuTimes('cpu 0 0 0 0 0 0 0 0');
    const stolen = parseCpuTimes('cpu 50 0 0 30 0 0 0 20');
    assert.ok(idleStart && stolen);
    assert.strictEqual(Math.round(cpuUsageBetween(idleStart, stolen)?.stealPercent || 0), 20);

    const sample = parseCpuSection([
        'stat cpu  4705 356 584 3699176 23060 0 277 0 0 0',
        'ncpu 64', 'loadavg 4.12 3.80 3.55 3/1234 56789', 'nproc 16', 'garbage line'
    ].join('\n'));
    assert.strictEqual(sample.logicalCores, 64);
    assert.strictEqual(sample.availableCores, 16, 'nproc reflects cgroup/taskset limits.');
    assert.strictEqual(sample.load1, 4.12);
    assert.strictEqual(sample.totalProcesses, 1234);
    const empty = parseCpuSection('nproc \nloadavg ');
    assert.strictEqual(empty.availableCores, undefined);
    assert.strictEqual(empty.load1, undefined);
}

function testMemory(): void {
    const memory = parseMemInfo([
        'MemTotal:       131900452 kB', 'MemFree:         2048000 kB', 'MemAvailable:   63313088 kB',
        'Buffers:          512000 kB', 'Cached:         58000000 kB', 'Shmem:            900000 kB',
        'SReclaimable:    3000000 kB', 'SwapTotal:       8388604 kB', 'SwapFree:        6291452 kB'
    ].join('\n'));
    assert.ok(memory);
    assert.strictEqual(memory.availableKiB, 63313088, 'MemAvailable is used as-is; page cache is not counted as used.');
    assert.strictEqual(memory.usedKiB, 131900452 - 63313088);
    assert.strictEqual(Math.round(memory.usedPercent), 52);
    assert.strictEqual(memory.swapUsedKiB, 8388604 - 6291452);
    assert.strictEqual(Math.round(memory.swapPercent), 25);
    assert.strictEqual(memory.availableEstimated, false);
    const oldKernel = parseMemInfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 50 kB\nShmem: 100 kB');
    assert.strictEqual(oldKernel?.availableKiB, 400, 'Without MemAvailable: free + buffers + cached + reclaimable - shmem.');
    assert.strictEqual(oldKernel?.availableEstimated, true);
    assert.strictEqual(oldKernel?.swapPercent, 0);
    assert.strictEqual(parseMemInfo('MemFree: 5 kB'), undefined);
    assert.strictEqual(parseMemInfo(''), undefined);
}

function testSystem(): void {
    const system = parseSystemSection([
        'hostname gpu-01', 'kernel 5.15.0-91-generic', 'arch x86_64', 'user alice', 'os "Ubuntu 22.04.4 LTS"',
        'uptime 864123.45', 'cpumodel  AMD EPYC 7763 64-Core Processor', 'cores 128', 'cpumodel', 'os '
    ].join('\n'));
    assert.strictEqual(system.os, 'Ubuntu 22.04.4 LTS');
    assert.strictEqual(system.uptimeSeconds, 864123);
    assert.strictEqual(system.cpuModel, 'AMD EPYC 7763 64-Core Processor');
    assert.strictEqual(system.physicalCores, 128);
    assert.strictEqual(parseSystemSection('cores 0').physicalCores, undefined, 'ARM cpuinfo without core ids gives no count.');
}

const DF_OUTPUT = `Filesystem            Type     1024-blocks       Used  Available Capacity Mounted on
udev                  devtmpfs    65826704          0   65826704       0% /dev
/dev/nvme0n1p2        ext4      1921724676  576517402 1247525036      32% /
tmpfs                 tmpfs       65858148      12000   65846148       1% /dev/shm
/dev/sda1             xfs       7811937280 7265104872  546832408      94% /data
/dev/sda1             xfs       7811937280 7265104872  546832408      94% /home/alice/data link
/dev/loop3            squashfs       65536      65536          0     100% /snap/core20/2318
overlay               overlay   1921724676  576517402 1247525036      32% /var/lib/docker/overlay2/abc/merged
10.0.0.5:/export/home nfs4     52428800000 15728640000 36700160000      30% /home
nas01:/export/projects nfs4    52428800000 15728640000 36700160000      30% /mnt/projects
nas01:/export/projects nfs4    52428800000 15728640000 36700160000      30% /mnt/projects-again
lustre@tcp:/scratch   lustre   107374182400 21474836480 85899345920      20% /mnt/lustre
/dev/sdb1             ext4       1000000     960000          0     100% /scratch/full
/dev/sdc1             ext4             0          0          0        - /empty
/dev/mapper/vg-root   ext4      100000000   95000000   -2000000     100% /reserved`;

function testDisks(): void {
    const mounts = parseDf(DF_OUTPUT);
    assert.strictEqual(mounts.length, 14);
    const spaced = mounts.find(mount => mount.mountPoint === '/home/alice/data link');
    assert.ok(spaced, 'Mount points with spaces stay intact.');
    assert.strictEqual(spaced?.fsType, 'xfs');
    assert.strictEqual(mounts.find(mount => mount.mountPoint === '/reserved')?.availKiB, 0, 'Negative availability is clamped.');

    const report = buildDiskReport({
        mounts, pinned: [], missingPinned: [], quotas: [], quotaToolAvailable: false,
        partial: false, typesFromMounts: false, filters
    });
    const shown = report.disks.map(disk => disk.mountPoint);
    assert.ok(!shown.includes('/dev') && !shown.includes('/dev/shm') && !shown.some(mount => mount.startsWith('/snap')),
        'Pseudo filesystems are hidden by type.');
    assert.ok(!shown.some(mount => mount.startsWith('/var/lib/docker')), 'Container layers are hidden.');
    assert.ok(!shown.includes('/empty'), 'Zero-size filesystems are skipped.');
    const data = report.disks.find(disk => disk.mountPoint === '/data');
    assert.ok(data, '/data is shown once.');
    assert.deepStrictEqual(data?.alsoMountedAt, ['/home/alice/data link'], 'A bind mount of the same filesystem is merged.');
    assert.strictEqual(data?.usedPercent, 94, 'Use% matches df (used / (used + available), rounded up).');
    const projects = report.disks.filter(disk => disk.source === 'nas01:/export/projects');
    assert.strictEqual(projects.length, 1, 'The same NFS export mounted twice is shown once.');
    assert.strictEqual(projects[0].mountPoint, '/mnt/projects');
    assert.strictEqual(report.disks.find(disk => disk.mountPoint === '/home')?.network, true);
    assert.strictEqual(report.disks.find(disk => disk.mountPoint === '/mnt/lustre')?.network, true);
    assert.strictEqual(report.disks.find(disk => disk.mountPoint === '/')?.network, false);
    assert.deepStrictEqual(shown.slice(0, 3), ['/reserved', '/scratch/full', '/data'], 'Unpinned filesystems are sorted by usage.');
    assert.deepStrictEqual(report.hidden.map(item => item.mountPoint).sort(),
        ['/dev', '/dev/shm', '/snap/core20/2318', '/var/lib/docker/overlay2/abc/merged'], 'Hidden filesystems are listed for transparency.');

    const pinned = parsePinnedDf([
        '#path 0 /home/alice/datasets',
        '/dev/nvme0n1p2        ext4      1921724676  576517402 1247525036      32% /',
        '#missing 1 /data/old', '#path 2 /data/alice',
        '/dev/sda1             xfs       7811937280 7265104872  546832408      94% /data',
        '#path 3 /run/user/1000', '/dev/shm tmpfs 100 10 90 10% /run/user/1000'
    ].join('\n'), ['~/datasets', '/data/old', '/data/alice', '/run/user/1000']);
    assert.deepStrictEqual(pinned.missing, ['/data/old'], 'Missing pinned paths keep their configured spelling.');
    const pinnedReport = buildDiskReport({
        mounts, pinned: pinned.resolved, missingPinned: pinned.missing, quotas: [], quotaToolAvailable: false,
        partial: false, typesFromMounts: false, filters: { ...filters, pinnedPaths: ['~/datasets', '/data/old', '/data/alice', '/run/user/1000'] }
    });
    assert.deepStrictEqual(pinnedReport.disks.slice(0, 3).map(disk => disk.mountPoint), ['/', '/data', '/run/user/1000'],
        'Pinned filesystems come first in settings order, even hidden tmpfs.');
    assert.deepStrictEqual(pinnedReport.disks[0].pinnedPaths, ['~/datasets']);
    assert.strictEqual(pinnedReport.disks.filter(disk => disk.mountPoint === '/').length, 1, 'A pinned directory on / does not duplicate /.');

    const scoped = entriesForHost(['/data', 'gpu-01:/scratch', 'gpu-02:/other', ' ', 'gpu-01:tmpfs-not-a-path'], 'gpu-01');
    assert.deepStrictEqual(scoped, ['/data', '/scratch', 'gpu-01:tmpfs-not-a-path']);
    assert.strictEqual(isNetworkFs('fuse.sshfs'), true);
    assert.strictEqual(isNetworkFs('ext4', '//winserver/share'), true);

    const noType = parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100 50 50 50% /', false);
    assert.strictEqual(noType[0].fsType, undefined);
    const types = parseProcMounts('/dev/vda1 / ext4 rw 0 0\n//nas/share /mnt/my\\040share cifs rw 0 0');
    assert.strictEqual(types.get('/mnt/my share')?.fsType, 'cifs', 'Octal escapes in /proc/mounts are decoded.');
}

function testQuota(): void {
    const quotas = parseQuota(`Disk quotas for user alice (uid 1001):
     Filesystem  blocks   quota   limit   grace   files   quota   limit   grace
      /dev/sda1 4194304* 4000000 5000000  6days    1234       0       0
nas01.example.org:/export/home
                 314572800  524288000 576716800           20480       0       0
 /dev/nvme0n1p2       12       0       0              3       0       0`);
    assert.strictEqual(quotas.length, 2, 'Filesystems without limits are ignored.');
    assert.deepStrictEqual(
        { fs: quotas[0].filesystem, used: quotas[0].usedKiB, soft: quotas[0].softKiB, hard: quotas[0].hardKiB, grace: quotas[0].grace, over: quotas[0].overSoftLimit },
        { fs: '/dev/sda1', used: 4194304, soft: 4000000, hard: 5000000, grace: '6days', over: true });
    assert.strictEqual(quotas[1].filesystem, 'nas01.example.org:/export/home', 'Wrapped lines after long names are joined.');
    assert.strictEqual(quotas[1].filesUsed, 20480);
    assert.strictEqual(quotas[1].overSoftLimit, false);
    assert.deepStrictEqual(parseQuota('Disk quotas for user bob (uid 1002): none'), []);
    const lustre = parseLustreQuota(`#mount /mnt/lustre
Disk quotas for usr alice (uid 1001):
     Filesystem  kbytes   quota   limit   grace   files   quota   limit   grace
    /mnt/lustre  123456       0 1000000       -     123       0       0       -`);
    assert.strictEqual(lustre.length, 1);
    assert.strictEqual(lustre[0].mountPoint, '/mnt/lustre');
    assert.strictEqual(lustre[0].hardKiB, 1000000);
    assert.strictEqual(lustre[0].grace, undefined);

    const mounts = parseDf(DF_OUTPUT);
    const report = buildDiskReport({
        mounts, pinned: [], missingPinned: [], quotas: [...quotas, ...lustre], quotaToolAvailable: true,
        partial: false, typesFromMounts: false, filters
    });
    assert.strictEqual(report.disks.find(disk => disk.mountPoint === '/data')?.quota?.hardKiB, 5000000, 'Quota is matched to its filesystem by device.');
    assert.strictEqual(report.disks.find(disk => disk.mountPoint === '/mnt/lustre')?.quota?.source, 'lustre');
    assert.strictEqual(report.otherQuotas.length, 1, 'A quota for a filesystem that is not shown is still reported.');
}

function testFormatting(): void {
    assert.strictEqual(formatBytes(7.44 * 1024 ** 4), '7.44 TiB');
    assert.strictEqual(formatBytes(560 * 1024 ** 3), '560 GiB');
    assert.strictEqual(formatBytes(24 * 1024 ** 3), '24 GiB');
    assert.strictEqual(formatBytes(4.2 * 1024 ** 3), '4.2 GiB');
    assert.strictEqual(formatBytes(1000 * 1024 ** 3), '0.977 TiB', 'Values switch unit before four digits.');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(8e12, 'si'), '8 TB');
    assert.strictEqual(formatBytes(Number.NaN), '—');
    assert.strictEqual(formatBytePair(7.44 * 1024 ** 4, 8 * 1024 ** 4), '7.44 / 8 TiB');
    assert.strictEqual(formatBytePair(300 * 1024 ** 3, 1024 ** 4), '300 GiB / 1 TiB');
    assert.strictEqual(percentCeil(89.1), 90);
    assert.strictEqual(percentCeil(90), 90);
    assert.strictEqual(percentCeil(-3), 0);
    assert.strictEqual(usageLevel(69, 70, 90), 'ok');
    assert.strictEqual(usageLevel(70, 70, 90), 'warning');
    assert.strictEqual(usageLevel(89, 70, 90), 'warning');
    assert.strictEqual(usageLevel(90, 70, 90), 'critical');
    assert.strictEqual(formatDurationSeconds(90061), '1d 1h');
    assert.strictEqual(formatDurationSeconds(42), '42s');
}

function testScriptHelpers(): void {
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
    assert.strictEqual(shellPath('~'), '"$HOME"');
    assert.strictEqual(shellPath('~/a b'), `"$HOME"'/a b'`);
    assert.strictEqual(shellPath('/data/$(rm -rf ~)'), `'/data/$(rm -rf ~)'`, 'Paths are never expanded by the shell.');
    assert.strictEqual(validateRemotePath(' /data/ '), '/data');
    assert.throws(() => validateRemotePath('relative/path'));
    assert.throws(() => validateRemotePath('/data\nrm -rf /'));
    assert.throws(() => validateRemotePath('~alice/x'), 'Other users\' home shortcuts are not expanded.');
    assert.throws(() => buildStopScanScript(1));
    assert.ok(buildStopScanScript(4242).includes('sl_p=4242'));

    const nonce = 'f00d';
    const output = splitScriptOutput([
        'Welcome to the lab cluster!',
        '@@SL:f00d:begin gpu@@', 'row', '@@SL:beef:end gpu 0@@', '@@SL:f00d:end gpu 0@@',
        '@@SL:f00d:begin cpu@@', 'stat cpu 1 2 3 4', '@@SL:f00d:end cpu @@',
        '@@SL:f00d:begin df@@', 'partial'
    ].join('\n'), nonce);
    assert.strictEqual(output.preamble, 'Welcome to the lab cluster!', 'Login-shell noise is kept out of the sections.');
    assert.strictEqual(output.sections.get('gpu')?.body, 'row\n@@SL:beef:end gpu 0@@', 'Markers with another nonce are plain text.');
    assert.strictEqual(output.sections.get('gpu')?.exitCode, 0);
    assert.strictEqual(output.sections.get('cpu')?.exitCode, undefined);
    assert.strictEqual(output.sections.get('df')?.exitCode, undefined, 'An unfinished section has no exit code.');
    assert.strictEqual(output.complete, false);
    assert.strictEqual(splitScriptOutput('@@SL:f00d:done@@', nonce).complete, true);
}

function testGpu(): void {
    const monitor = new GpuMonitor();
    const sections = (entries: Record<string, { body: string; exitCode?: number }>) => new Map(Object.entries(entries));
    assert.strictEqual(monitor.parseGpuSections(sections({ gpu: { body: '', exitCode: 127 } })).state, 'missing');
    const broken = monitor.parseGpuSections(sections({ gpu: { body: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.", exitCode: 9 } }));
    assert.strictEqual(broken.state, 'error');
    assert.ok(broken.error?.includes('NVIDIA driver'));
    assert.strictEqual(monitor.parseGpuSections(sections({ gpu: { body: '', exitCode: 124 } })).error, 'nvidia-smi did not respond in time.');
    const ok = monitor.parseGpuSections(sections({
        gpu: { body: 'Warning: persistence mode is disabled\n0, GPU-a, NVIDIA H100 80GB HBM3, 5, 1, 81559, 81000, 559, 35, [N/A], [Not Supported], [N/A]', exitCode: 0 },
        gpuproc: { body: 'GPU-a, 77, python, 500', exitCode: 0 },
        procinfo: { body: ' 77 carol 65 Thu Nov 27 20:00:00 2026 python eval.py', exitCode: 0 }
    }));
    assert.strictEqual(ok.state, 'ok');
    assert.strictEqual(ok.gpus.length, 1, 'Non-CSV warning lines are ignored.');
    assert.strictEqual(ok.gpus[0].power.draw, 'N/A');
    assert.strictEqual(ok.gpus[0].power.limit, 'N/A', '[Not Supported] is treated as unavailable.');
    assert.strictEqual(ok.gpus[0].processes[0].user, 'carol');
    assert.strictEqual(ok.gpus[0].processes[0].command, 'python eval.py');
}

function testSafeText(): void {
    // VS Code turns [label](command:...) in notification text into a clickable link.
    const linkPattern = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)/;
    const mount = '/home/m/[Show details](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%5Cn%22%7D)';
    assert.ok(linkPattern.test(mount));
    assert.ok(!linkPattern.test(plainText(mount)), 'Remote text cannot form a notification link.');
    assert.strictEqual(plainText(mount).replace(/\u200b/g, ''), mount, 'The visible text is unchanged.');
    assert.strictEqual(plainText('/data'), '/data');

    const home = os.homedir();
    assert.strictEqual(resolveSshConfigPath('~/.ssh/lab'), path.join(home, '.ssh', 'lab'));
    assert.strictEqual(resolveSshConfigPath('~\\.ssh\\lab'), path.join(home, '\\.ssh\\lab'), 'A Windows-style ~\\ prefix is expanded too.');
    assert.strictEqual(resolveSshConfigPath('~'), home);
    assert.strictEqual(resolveSshConfigPath('~alice/cfg'), '~alice/cfg', 'Other users\' ~name is left alone.');
    assert.deepStrictEqual(sshConfigArguments('~/.ssh/config'), [], 'The default config needs no -F.');
    assert.deepStrictEqual(sshConfigArguments(path.join(home, '.ssh', 'config')), []);
    assert.deepStrictEqual(sshConfigArguments('~/.ssh/lab'), ['-F', path.join(home, '.ssh', 'lab')], 'ssh -F gets an expanded path.');
    assert.deepStrictEqual(sshConfigArguments(undefined), []);
    // Every reader of the setting sees the same value: trimmed, default when empty or not a string.
    assert.strictEqual(normalizeSshConfigPath('  ~/.ssh/lab  '), '~/.ssh/lab');
    assert.strictEqual(normalizeSshConfigPath(42), '~/.ssh/config');
    assert.strictEqual(normalizeSshConfigPath('   '), '~/.ssh/config');
    assert.deepStrictEqual(sshConfigArguments(' ~/.ssh/lab '), ['-F', path.join(home, '.ssh', 'lab')]);
    assert.deepStrictEqual(sshConfigArguments(['not', 'a', 'path']), []);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-sshcfg-'));
    try {
        const file = path.join(directory, 'lab_config');
        fs.writeFileSync(file, 'Host lab-a lab-b\n  HostName 10.0.0.1\n');
        assert.deepStrictEqual(new SshConfigParser().parse(`  ${file}  `).map(host => host.host), ['lab-a', 'lab-b'],
            'The parser trims the path exactly like ssh -F does.');
        assert.deepStrictEqual(sshConfigArguments(`  ${file}  `), ['-F', file]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

testCpu();
testSafeText();
testMemory();
testSystem();
testDisks();
testQuota();
testFormatting();
testScriptHelpers();
testGpu();
console.log('CPU, memory, disk, quota, formatting, script-output and GPU parsers passed.');
