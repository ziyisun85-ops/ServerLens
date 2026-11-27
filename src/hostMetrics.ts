// ServerLens: CPU, memory and system information parsed from /proc and uname output.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.

/** Cumulative jiffies from the aggregate `cpu` line of /proc/stat. */
export interface CpuTimes {
    user: number;
    nice: number;
    system: number;
    idle: number;
    iowait: number;
    irq: number;
    softirq: number;
    steal: number;
    /** user..steal; guest time is already included in user and nice. */
    total: number;
}

export interface CpuUsage {
    usagePercent: number;
    userPercent: number;
    systemPercent: number;
    iowaitPercent: number;
    stealPercent: number;
}

export interface CpuInfo extends Partial<CpuUsage> {
    /** Online logical CPUs (cpuN lines in /proc/stat). */
    logicalCores?: number;
    /** CPUs available to the SSH session (nproc), lower inside cgroups or taskset. */
    availableCores?: number;
    physicalCores?: number;
    model?: string;
    load1?: number;
    load5?: number;
    load15?: number;
    runningProcesses?: number;
    totalProcesses?: number;
    /** Length of the sampling window behind usagePercent, in milliseconds. */
    windowMs?: number;
}

export interface MemoryInfo {
    totalKiB: number;
    availableKiB: number;
    usedKiB: number;
    freeKiB: number;
    buffersKiB: number;
    cachedKiB: number;
    shmemKiB: number;
    swapTotalKiB: number;
    swapUsedKiB: number;
    usedPercent: number;
    swapPercent: number;
    /** True on kernels older than 3.14, where MemAvailable is missing and is estimated. */
    availableEstimated: boolean;
}

export interface SystemInfo {
    hostname?: string;
    kernel?: string;
    arch?: string;
    os?: string;
    user?: string;
    uptimeSeconds?: number;
    cpuModel?: string;
    physicalCores?: number;
}

export interface CpuSample {
    times?: CpuTimes;
    /** Second reading taken inside the same script (first collection only). */
    times2?: CpuTimes;
    logicalCores?: number;
    availableCores?: number;
    load1?: number;
    load5?: number;
    load15?: number;
    runningProcesses?: number;
    totalProcesses?: number;
}

function finite(value: string | undefined): number | undefined {
    if (value === undefined || !value.trim()) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parses a `cpu  user nice system idle iowait irq softirq steal [guest guest_nice]` line. */
export function parseCpuTimes(line: string): CpuTimes | undefined {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'cpu' || fields.length < 5) {
        return undefined;
    }
    const values = fields.slice(1, 9).map(value => Number(value));
    if (values.some(value => !Number.isFinite(value) || value < 0)) {
        return undefined;
    }
    while (values.length < 8) {
        values.push(0);
    }
    const [user, nice, system, idle, iowait, irq, softirq, steal] = values;
    return { user, nice, system, idle, iowait, irq, softirq, steal, total: values.reduce((sum, value) => sum + value, 0) };
}

/** Usage between two samples; undefined when the counters did not advance (or were reset by a reboot). */
export function cpuUsageBetween(previous: CpuTimes, current: CpuTimes): CpuUsage | undefined {
    const total = current.total - previous.total;
    if (!(total > 0)) {
        return undefined;
    }
    const delta = (key: keyof CpuTimes) => Math.max(0, current[key] - previous[key]);
    const idle = delta('idle') + delta('iowait');
    const clamp = (value: number) => Math.min(100, Math.max(0, value));
    return {
        usagePercent: clamp((1 - idle / total) * 100),
        userPercent: clamp((delta('user') + delta('nice')) / total * 100),
        systemPercent: clamp((delta('system') + delta('irq') + delta('softirq')) / total * 100),
        iowaitPercent: clamp(delta('iowait') / total * 100),
        stealPercent: clamp(delta('steal') / total * 100)
    };
}

/** Parses the `cpu` section written by remoteScript.ts. */
export function parseCpuSection(body: string): CpuSample {
    const sample: CpuSample = {};
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        const space = line.indexOf(' ');
        const key = space < 0 ? line : line.slice(0, space);
        const value = space < 0 ? '' : line.slice(space + 1).trim();
        if (key === 'stat') {
            sample.times = parseCpuTimes(value);
        } else if (key === 'stat2') {
            sample.times2 = parseCpuTimes(value);
        } else if (key === 'ncpu') {
            const count = finite(value);
            if (count && count > 0) {
                sample.logicalCores = count;
            }
        } else if (key === 'nproc') {
            const count = finite(value);
            if (count && count > 0) {
                sample.availableCores = count;
            }
        } else if (key === 'loadavg') {
            const [one, five, fifteen, tasks] = value.split(/\s+/);
            sample.load1 = finite(one);
            sample.load5 = finite(five);
            sample.load15 = finite(fifteen);
            const match = tasks?.match(/^(\d+)\/(\d+)$/);
            if (match) {
                sample.runningProcesses = Number(match[1]);
                sample.totalProcesses = Number(match[2]);
            }
        }
    }
    return sample;
}

/** Parses /proc/meminfo lines. MemAvailable is estimated on kernels that lack it. */
export function parseMemInfo(body: string): MemoryInfo | undefined {
    const values = new Map<string, number>();
    for (const line of body.split(/\r?\n/)) {
        const match = line.trim().match(/^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?$/);
        if (match) {
            values.set(match[1], Number(match[2]));
        }
    }
    const total = values.get('MemTotal');
    if (!total || total <= 0) {
        return undefined;
    }
    const free = values.get('MemFree') || 0;
    const buffers = values.get('Buffers') || 0;
    const cached = values.get('Cached') || 0;
    const reclaimable = values.get('SReclaimable') || 0;
    const shmem = values.get('Shmem') || 0;
    const estimated = !values.has('MemAvailable');
    const available = Math.min(total, Math.max(0, estimated
        ? free + buffers + cached + reclaimable - shmem
        : values.get('MemAvailable') || 0));
    const swapTotal = values.get('SwapTotal') || 0;
    const swapFree = Math.min(swapTotal, values.get('SwapFree') || 0);
    const used = total - available;
    return {
        totalKiB: total,
        availableKiB: available,
        usedKiB: used,
        freeKiB: free,
        buffersKiB: buffers,
        cachedKiB: cached + reclaimable,
        shmemKiB: shmem,
        swapTotalKiB: swapTotal,
        swapUsedKiB: swapTotal - swapFree,
        usedPercent: used / total * 100,
        swapPercent: swapTotal > 0 ? (swapTotal - swapFree) / swapTotal * 100 : 0,
        availableEstimated: estimated
    };
}

/** Parses the `sys` section (key value lines). Empty values are dropped. */
export function parseSystemSection(body: string): SystemInfo {
    const info: SystemInfo = {};
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        const space = line.indexOf(' ');
        if (space < 0) {
            continue;
        }
        const key = line.slice(0, space);
        const value = line.slice(space + 1).trim();
        if (!value) {
            continue;
        }
        switch (key) {
            case 'hostname': info.hostname = value; break;
            case 'kernel': info.kernel = value; break;
            case 'arch': info.arch = value; break;
            case 'user': info.user = value; break;
            case 'os': info.os = value.replace(/^(["'])(.*)\1$/, '$2'); break;
            case 'uptime': {
                const seconds = finite(value);
                if (seconds !== undefined && seconds >= 0) {
                    info.uptimeSeconds = Math.round(seconds);
                }
                break;
            }
            case 'cpumodel': info.cpuModel = value.replace(/\s+/g, ' '); break;
            case 'cores': {
                const cores = finite(value);
                if (cores && cores > 0) {
                    info.physicalCores = cores;
                }
                break;
            }
        }
    }
    return info;
}
