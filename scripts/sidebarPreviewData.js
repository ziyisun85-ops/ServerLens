// Fictional sample fleet for the sidebar preview and its jsdom test (no real servers): one server
// with four GPUs and /data at 93 %, plus CPU-only, stale, offline and collapsed examples.
const GiB = 1024 * 1024; // KiB per GiB
const TiB = 1024 * GiB;
const now = Date.now();

function gpu(index, util, usedGiB, totalGiB, temp, power, processes = [], name = 'NVIDIA GeForce RTX 4090') {
    const used = Math.round(usedGiB * 1024);
    const total = Math.round(totalGiB * 1024);
    const available = processes.length === 0 && used <= 512 && util <= 10;
    return {
        index: String(index), uuid: `GPU-${name.replace(/\W/g, '').slice(-6)}-${index}`, name,
        utilization: { gpu: `${util} %`, memory: `${Math.round(util * 0.6)} %` },
        memory: { total: `${total} MiB`, used: `${used} MiB`, free: `${total - used} MiB` },
        temperature: { gpu: `${temp} C` }, power: { draw: `${power}.00 W`, limit: '450.00 W' }, fanSpeed: `${Math.round(temp * 0.6)} %`,
        processes,
        availability: { available, reasons: available ? [] : [processes.length ? `${processes.length} compute process` : `${used} MiB memory used`] }
    };
}

function process(pid, user, usedGiB, seconds, command) {
    return { pid: String(pid), user, name: command.split(' ')[0], command, elapsedSeconds: seconds, usedMemory: `${Math.round(usedGiB * 1024)} MiB` };
}

function disk(mountPoint, totalKiB, usedKiB, extra = {}) {
    const availKiB = Math.max(0, totalKiB - usedKiB);
    return {
        id: mountPoint, mountPoint, alsoMountedAt: [], pinnedPaths: [], pinned: false, source: '/dev/sda1', fsType: 'ext4', network: false,
        totalKiB, usedKiB, availKiB, usedPercent: Math.ceil(usedKiB / (usedKiB + availKiB) * 100), ...extra
    };
}

function report(disks, extra = {}) {
    return { disks, hidden: [{ mountPoint: '/dev/shm', fsType: 'tmpfs' }, { mountPoint: '/boot/efi', fsType: 'vfat' }], otherQuotas: [],
        quotaToolAvailable: true, missingPinnedPaths: [], partial: false, typesFromMounts: false, ...extra };
}

function cpu(usage, cores, load, model = 'AMD EPYC 7763 64-Core Processor') {
    return { usagePercent: usage, userPercent: usage * 0.8, systemPercent: usage * 0.15, iowaitPercent: usage * 0.05, stealPercent: 0,
        logicalCores: cores, availableCores: cores, physicalCores: cores / 2, model, load1: load, load5: load * 0.9, load15: load * 0.8, windowMs: 5000 };
}

function memory(usedGiB, totalGiB, swapUsedGiB = 0, swapTotalGiB = 8) {
    const totalKiB = totalGiB * GiB;
    const usedKiB = usedGiB * GiB;
    return { totalKiB, usedKiB, availableKiB: totalKiB - usedKiB, freeKiB: 4 * GiB, buffersKiB: GiB, cachedKiB: 40 * GiB, shmemKiB: GiB,
        swapTotalKiB: swapTotalGiB * GiB, swapUsedKiB: swapUsedGiB * GiB, usedPercent: usedKiB / totalKiB * 100,
        swapPercent: swapTotalGiB ? swapUsedGiB / swapTotalGiB * 100 : 0, availableEstimated: false };
}

const system = (os, uptime) => ({ os, kernel: '5.15.0-91-generic', arch: 'x86_64', hostname: 'node', user: 'alice', uptimeSeconds: uptime });
const updated = at => ({ gpu: at, cpu: at, memory: at, disk: at - 20000, system: at - 20000 });

const servers = [
    {
        host: 'gpu-node-1', collectedAt: now, lastSuccessAt: now, latencyMs: 46, stale: false, multiplexed: true, gpuState: 'ok', updatedAt: updated(now),
        gpus: [
            gpu(0, 12, 4.2, 24, 41, 71),
            gpu(1, 94, 21.8, 24, 77, 402, [process(4242, 'alice', 21.5, 18420, '/opt/conda/envs/llm/bin/python train.py --config configs/llama-7b.yaml'), process(4243, 'alice', 0.3, 18400, 'python -m torch.distributed.run')]),
            gpu(2, 6, 1.3, 24, 38, 60, [process(5120, 'bob', 1.1, 900, 'jupyter-lab --no-browser')]),
            gpu(3, 78, 18.6, 24, 70, 350, [process(6001, 'carol', 18.4, 7300, 'python finetune.py --lr 2e-5')])
        ],
        cpu: cpu(30, 64, 18.2), memory: memory(66, 126, 0.2), system: system('Ubuntu 22.04.4 LTS', 1203000),
        disks: report([
            disk('/data', 8 * TiB, 7.44 * TiB, { fsType: 'xfs', source: '/dev/sdb1', alsoMountedAt: ['/home/alice/data'] }),
            disk('/', 880 * GiB, 360 * GiB, { source: '/dev/nvme0n1p2' }),
            disk('/home', 1 * TiB, 300 * GiB, { fsType: 'nfs4', network: true, source: 'nas01:/export/home',
                quota: { filesystem: 'nas01:/export/home', mountPoint: '/home', usedKiB: 180 * GiB, softKiB: 500 * GiB, hardKiB: 550 * GiB, overSoftLimit: false, source: 'quota' } })
        ]),
        storage: {
            host: 'gpu-node-1', label: 'Home directory', paths: ['~'], depth: 2, state: 'done', startedAt: now - 4300, finishedAt: now - 1000,
            roots: [{ path: '~', kib: 402 * GiB, root: true }], totalKiB: 402 * GiB, omitted: 0, timedOut: false, unreadable: 2, missing: [],
            filesystem: { source: 'nas01:/export/home', totalKiB: TiB, usedKiB: 300 * GiB, availKiB: 724 * GiB, mountPoint: '/home' },
            entries: [
                { path: '~/checkpoints', kib: 212 * GiB, root: false }, { path: '~/checkpoints/llama-7b', kib: 168 * GiB, root: false },
                { path: '~/.cache', kib: 96 * GiB, root: false }, { path: '~/.cache/huggingface', kib: 81 * GiB, root: false },
                { path: '~/miniconda3', kib: 38 * GiB, root: false }, { path: '~/datasets', kib: 31 * GiB, root: false },
                { path: '~/logs', kib: 2.4 * GiB, root: false }
            ]
        }
    },
    {
        host: 'a6000-east', metadata: { alias: 'Vision Lab A', favorite: true }, collectedAt: now, lastSuccessAt: now, latencyMs: 84, stale: false,
        multiplexed: true, gpuState: 'ok', updatedAt: updated(now),
        gpus: [gpu(0, 0, 0.01, 48, 31, 22, [], 'NVIDIA RTX A6000'), gpu(1, 0, 0.01, 48, 32, 23, [], 'NVIDIA RTX A6000')],
        cpu: cpu(8, 48, 3.2, 'Intel(R) Xeon(R) Gold 6342 CPU @ 2.80GHz'), memory: memory(98, 256), system: system('Rocky Linux 9.3', 918240),
        disks: report([
            disk('/scratch', 3.5 * TiB, 2.6 * TiB, { pinned: true, pinnedPaths: ['/scratch'],
                quota: { filesystem: '/dev/sdc1', usedKiB: 520 * GiB, softKiB: 500 * GiB, hardKiB: 600 * GiB, grace: '6days', overSoftLimit: true, source: 'quota' } }),
            disk('/', 1.8 * TiB, 0.65 * TiB)
        ])
    },
    {
        host: 'cpu-node-01', collectedAt: now, lastSuccessAt: now, latencyMs: 31, stale: false, multiplexed: true, gpuState: 'missing', updatedAt: updated(now), gpus: [],
        cpu: cpu(55, 128, 70.4), memory: memory(312, 512, 2.8, 8), system: system('Debian GNU/Linux 12 (bookworm)', 4300000),
        disks: report([disk('/', 440 * GiB, 385 * GiB), disk('/data', 16 * TiB, 7.1 * TiB, { fsType: 'lustre', network: true, source: 'mds@tcp:/lustre' })])
    },
    {
        host: 'gpu-node-2', collectedAt: now, lastSuccessAt: now - 12 * 60000, latencyMs: 8000, stale: true, gpuState: 'ok', updatedAt: updated(now - 12 * 60000),
        error: 'Server is unreachable. Check its network and SSH service.', errorCategory: 'unreachable', errorDetail: 'ssh: connect to host 10.8.0.13 port 22: No route to host',
        nextRetryAt: now + 40000,
        gpus: [0, 1, 2, 3, 4, 5, 6, 7].map(index => gpu(index, 99, 44, 48, 63, 320, [process(7000 + index, 'ml-team', 43, 90000, 'torchrun pretrain.py')], 'NVIDIA L40S')),
        cpu: cpu(91, 192, 160.3), memory: memory(1700, 2015), system: system('Ubuntu 20.04.6 LTS', 2000000),
        disks: report([disk('/', 3.5 * TiB, 1.2 * TiB), disk('/mnt/nas', 200 * TiB, 181 * TiB, { fsType: 'nfs4', network: true, source: 'nas02:/pool' })])
    },
    {
        host: 'new-node', collectedAt: now, latencyMs: 1200, stale: false, gpus: [],
        error: 'SSH authentication failed. ServerLens needs key-based login without a password prompt.', errorCategory: 'authentication',
        errorDetail: 'alice@10.8.0.21: Permission denied (publickey,password).', nextRetryAt: now + 20000
    },
    {
        host: 'v100-cluster', collectedAt: now, lastSuccessAt: now, latencyMs: 71, stale: false, multiplexed: true, gpuState: 'ok', updatedAt: updated(now), slurmAvailable: true,
        gpus: [0, 1, 2, 3].map(index => gpu(index, index === 2 ? 0 : 100, index === 2 ? 0.004 : 30, 32, 60, 260, index === 2 ? [] : [process(9000 + index, 'research', 29.5, 40000, 'python train.py')], 'Tesla V100-SXM2-32GB')),
        cpu: cpu(76, 80, 61), memory: memory(380, 503), system: system('CentOS Linux 7 (Core)', 9000000),
        disks: report([disk('/', 900 * GiB, 600 * GiB), disk('/data', 60 * TiB, 41 * TiB, { fsType: 'nfs4', network: true, source: 'nas01:/export/data' })])
    }
];

module.exports = {
    servers,
    order: servers.map(server => server.host),
    settings: { diskWarningThreshold: 70, diskCriticalThreshold: 90, memoryWarningThreshold: 85, temperatureWarningThreshold: 80, byteUnits: 'iec', showProcesses: true },
    collapsed: ['v100-cluster']
};
