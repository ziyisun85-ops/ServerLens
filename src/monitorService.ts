// ServerLens: the only place that schedules SSH collection. Each host has its own due time
// per metric; metrics that are due together run in one batched script over one connection.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import { EventEmitter } from 'events';
import { GpuMonitor } from './gpuMonitor';
import { CpuInfo, CpuTimes, cpuUsageBetween, parseCpuSection, parseMemInfo, parseSystemSection } from './hostMetrics';
import {
    buildDiskReport, DiskFilters, DiskReport, parseDf, parseLustreQuota, parsePinnedDf, parseProcMounts, parseQuota
} from './diskMetrics';
import { buildCollectScript, CollectRequest, newNonce, ScriptSection, splitScriptOutput } from './remoteScript';
import { ExecOptions, ExecResult, SshError } from './sshTransport';
import { MetricKind, ServerErrorCategory, ServerSnapshotData } from './fleetModel';
import { Logger, nullLogger } from './log';

export type CollectMetric = MetricKind | 'slurm';

/** A host's latest data before GPU availability rules are applied (see composeFleet). */
export type HostSnapshot = ServerSnapshotData;

export interface MonitorConfig {
    hosts: string[];
    autoRefresh: boolean;
    pauseWhenHidden: boolean;
    /** Seconds between collections of each metric. */
    intervals: Record<'gpu' | 'cpu' | 'memory' | 'disk', number>;
    slurmIntervalSeconds: number;
    sshTimeoutSeconds: number;
    maxConcurrentHosts: number;
    gpuProcesses: boolean;
    processOwners: boolean;
    slurm: boolean;
    quota: boolean;
    diskFilters(host: string): DiskFilters;
}

/** The part of SshTransport the service needs; tests provide a fake. */
export interface CommandRunner {
    exec(host: string, script: string, options: ExecOptions): Promise<ExecResult>;
}

export interface Clock {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
    },
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout)
};

const METRICS: CollectMetric[] = ['gpu', 'cpu', 'memory', 'disk', 'system', 'slurm'];
const MIN_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const DISK_SUSPEND_MS = 10 * 60_000;
const CPU_SAMPLE_MAX_AGE_MS = 5 * 60_000;

interface HostState {
    host: string;
    snapshot: HostSnapshot;
    due: Record<CollectMetric, number>;
    previousCpu?: { times: CpuTimes; at: number };
    running: boolean;
    queued: boolean;
    pendingForce: boolean;
    failures: number;
    nextRetryAt: number;
    diskSuspendedUntil: number;
    abort?: AbortController;
    waiters: (() => void)[];
}

interface Job {
    state: HostState;
    metrics: Set<CollectMetric>;
    force: boolean;
}

export interface MonitorActivity {
    running: number;
    queued: number;
    total: number;
}

function errorCategory(error: unknown): ServerErrorCategory {
    if (error instanceof SshError) {
        return error.kind as ServerErrorCategory;
    }
    return 'unknown';
}

function emptySnapshot(host: string): HostSnapshot {
    return { host, gpus: [], collectedAt: 0, latencyMs: 0, stale: false, updatedAt: {} };
}

export class MonitorService {
    private readonly states = new Map<string, HostState>();
    private readonly events = new EventEmitter();
    private readonly gpuParser = new GpuMonitor();
    private readonly consumers = new Map<string, boolean>();
    private readonly queue: Job[] = [];
    private timer: unknown;
    private active = 0;
    private disposed = false;
    private order: string[] = [];

    constructor(
        private readonly runner: CommandRunner,
        private readonly config: () => MonitorConfig,
        private readonly log: Logger = nullLogger,
        private readonly clock: Clock = systemClock
    ) {
        this.syncHosts();
    }

    /** Fires with the host whose snapshot changed. */
    onDidChangeHost(listener: (host: string) => void): { dispose(): void } {
        this.events.on('host', listener);
        return { dispose: () => this.events.off('host', listener) };
    }

    /** Fires when collections start or finish, for progress indicators. */
    onDidChangeActivity(listener: (activity: MonitorActivity) => void): { dispose(): void } {
        this.events.on('activity', listener);
        return { dispose: () => this.events.off('activity', listener) };
    }

    /** Fires when the configured host list changes. */
    onDidChangeHosts(listener: (hosts: string[]) => void): { dispose(): void } {
        this.events.on('hosts', listener);
        return { dispose: () => this.events.off('hosts', listener) };
    }

    hosts(): string[] {
        return [...this.order];
    }

    getSnapshot(host: string): HostSnapshot | undefined {
        return this.states.get(host)?.snapshot;
    }

    getSnapshots(): HostSnapshot[] {
        return this.order.map(host => this.states.get(host)?.snapshot).filter((item): item is HostSnapshot => Boolean(item));
    }

    activity(): MonitorActivity {
        return { running: this.active, queued: this.queue.length, total: this.order.length };
    }

    /** Hosts that are collecting or waiting for a slot. */
    busyHosts(): string[] {
        return this.order.filter(host => {
            const state = this.states.get(host);
            return Boolean(state && (state.running || state.queued));
        });
    }

    /** Views report their visibility; with pauseWhenHidden, nothing runs while all are hidden. */
    setConsumerVisible(id: string, visible: boolean): void {
        const before = this.isActive();
        this.consumers.set(id, visible);
        if (!before && this.isActive()) {
            this.log.debug('Automatic refresh resumed.');
        }
        this.schedule();
    }

    removeConsumer(id: string): void {
        this.consumers.delete(id);
        this.schedule();
    }

    /** Re-reads the host list and schedule settings (call after configuration changes). */
    reconfigure(): void {
        this.syncHosts();
        this.schedule();
    }

    /**
     * Collects every metric now for the given hosts (default: all), bypassing failure backoff.
     * A host that is already collecting runs once more right after; requests never overlap.
     */
    refresh(hosts?: string[]): Promise<void> {
        this.syncHosts();
        const targets = (hosts || this.order).map(host => this.states.get(host)).filter((state): state is HostState => Boolean(state));
        const waits = targets.map(state => new Promise<void>(resolve => {
            state.waiters.push(resolve);
            const queuedJob = this.queue.find(job => job.state === state);
            if (queuedJob) {
                queuedJob.metrics = new Set(METRICS);
                queuedJob.force = true;
            } else if (state.running) {
                state.pendingForce = true;
            } else {
                this.enqueue(state, new Set(METRICS), true);
            }
        }));
        this.pump();
        return Promise.all(waits).then(() => undefined);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.clock.clearTimeout(this.timer);
        this.queue.length = 0;
        for (const state of this.states.values()) {
            state.abort?.abort();
            state.waiters.splice(0).forEach(resolve => resolve());
        }
        this.events.removeAllListeners();
    }

    private isActive(): boolean {
        const config = this.config();
        if (!config.autoRefresh) {
            return false;
        }
        if (!config.pauseWhenHidden) {
            return true;
        }
        return Array.from(this.consumers.values()).some(Boolean);
    }

    private syncHosts(): void {
        const hosts = Array.from(new Set(this.config().hosts));
        const changed = hosts.length !== this.order.length || hosts.some((host, index) => host !== this.order[index]);
        for (const host of hosts) {
            if (!this.states.has(host)) {
                this.states.set(host, {
                    host,
                    snapshot: emptySnapshot(host),
                    due: { gpu: 0, cpu: 0, memory: 0, disk: 0, system: 0, slurm: 0 },
                    running: false,
                    queued: false,
                    pendingForce: false,
                    failures: 0,
                    nextRetryAt: 0,
                    diskSuspendedUntil: 0,
                    waiters: []
                });
            }
        }
        for (const [host, state] of this.states) {
            if (!hosts.includes(host)) {
                state.abort?.abort();
                state.waiters.splice(0).forEach(resolve => resolve());
                this.states.delete(host);
            }
        }
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            if (!this.states.has(this.queue[index].state.host)) {
                this.queue.splice(index, 1);
            }
        }
        this.order = hosts;
        if (changed) {
            this.events.emit('hosts', [...hosts]);
        }
    }

    private intervalMs(metric: CollectMetric, config: MonitorConfig): number {
        const seconds = (value: number, minimum: number) => Math.max(minimum, Number.isFinite(value) ? value : minimum) * 1000;
        switch (metric) {
            case 'gpu': return seconds(config.intervals.gpu, 2);
            case 'cpu': return seconds(config.intervals.cpu, 2);
            case 'memory': return seconds(config.intervals.memory, 2);
            case 'disk': return seconds(config.intervals.disk, 10);
            case 'system': return Math.max(seconds(config.intervals.disk, 10), 60_000);
            case 'slurm': return seconds(config.slurmIntervalSeconds, 5);
        }
    }

    private dueMetrics(state: HostState, now: number, config: MonitorConfig): Set<CollectMetric> {
        const fastest = Math.min(this.intervalMs('gpu', config), this.intervalMs('cpu', config), this.intervalMs('memory', config));
        const horizon = now + Math.min(2500, fastest / 2);
        const due = new Set<CollectMetric>();
        for (const metric of METRICS) {
            if (state.due[metric] <= horizon) {
                due.add(metric);
            }
        }
        if (now < state.diskSuspendedUntil) {
            due.delete('disk');
        }
        if (!config.slurm) {
            due.delete('slurm');
        }
        // Slurm data only makes sense together with the GPU processes it annotates.
        if (!due.has('gpu')) {
            due.delete('slurm');
        }
        if (due.size === 1 && due.has('system')) {
            // System facts change rarely; wait for the next real collection instead of a dedicated round trip.
            return new Set();
        }
        return due;
    }

    private nextWake(state: HostState): number {
        let wake = Infinity;
        for (const metric of ['gpu', 'cpu', 'memory', 'disk'] as const) {
            if (metric === 'disk' && this.clock.now() < state.diskSuspendedUntil) {
                wake = Math.min(wake, state.diskSuspendedUntil);
                continue;
            }
            wake = Math.min(wake, state.due[metric]);
        }
        return Math.max(wake, state.nextRetryAt);
    }

    private schedule(): void {
        this.clock.clearTimeout(this.timer);
        this.timer = undefined;
        if (this.disposed || !this.isActive()) {
            return;
        }
        const now = this.clock.now();
        let next = Infinity;
        for (const state of this.states.values()) {
            if (!state.running && !state.queued) {
                next = Math.min(next, this.nextWake(state));
            }
        }
        if (next === Infinity) {
            return;
        }
        const delay = Math.min(60_000, Math.max(50, next - now));
        this.timer = this.clock.setTimeout(() => this.tick(), delay);
    }

    private tick(): void {
        this.timer = undefined;
        if (this.disposed) {
            return;
        }
        this.syncHosts();
        if (this.isActive()) {
            const config = this.config();
            const now = this.clock.now();
            for (const host of this.order) {
                const state = this.states.get(host);
                if (!state || state.running || state.queued || state.nextRetryAt > now) {
                    continue;
                }
                const metrics = this.dueMetrics(state, now, config);
                if (metrics.size) {
                    this.enqueue(state, metrics, false);
                }
            }
            this.pump();
        }
        this.schedule();
    }

    private enqueue(state: HostState, metrics: Set<CollectMetric>, force: boolean): void {
        state.queued = true;
        this.queue.push({ state, metrics, force });
        this.emitActivity();
    }

    private pump(): void {
        if (this.disposed) {
            return;
        }
        const limit = Math.max(1, Math.min(32, Math.round(this.config().maxConcurrentHosts) || 1));
        while (this.active < limit && this.queue.length) {
            const job = this.queue.shift() as Job;
            if (!this.states.has(job.state.host)) {
                continue;
            }
            this.active += 1;
            job.state.queued = false;
            job.state.running = true;
            this.emitActivity();
            void this.collect(job).finally(() => {
                this.active -= 1;
                job.state.running = false;
                if (job.state.pendingForce && !this.disposed && this.states.has(job.state.host)) {
                    job.state.pendingForce = false;
                    this.enqueue(job.state, new Set(METRICS), true);
                } else {
                    job.state.waiters.splice(0).forEach(resolve => resolve());
                }
                this.emitActivity();
                this.pump();
                this.schedule();
            });
        }
    }

    private emitActivity(): void {
        this.events.emit('activity', this.activity());
    }

    private buildRequest(state: HostState, metrics: Set<CollectMetric>, config: MonitorConfig, now: number): CollectRequest {
        const filters = config.diskFilters(state.host);
        const gpu = metrics.has('gpu');
        return {
            gpu,
            gpuProcesses: gpu && (config.gpuProcesses || config.processOwners),
            processOwners: gpu && config.processOwners,
            slurm: gpu && metrics.has('slurm') && config.slurm,
            cpu: metrics.has('cpu'),
            cpuDoubleSample: metrics.has('cpu') && (!state.previousCpu || now - state.previousCpu.at > CPU_SAMPLE_MAX_AGE_MS),
            memory: metrics.has('memory'),
            system: metrics.has('system'),
            disk: metrics.has('disk'),
            pinnedPaths: metrics.has('disk') ? filters.pinnedPaths : [],
            quota: metrics.has('disk') && config.quota,
            commandTimeoutSeconds: Math.max(3, Math.min(30, config.sshTimeoutSeconds))
        };
    }

    private async collect(job: Job): Promise<void> {
        const { state } = job;
        const config = this.config();
        const startedAt = this.clock.now();
        const request = this.buildRequest(state, job.metrics, config, startedAt);
        const nonce = newNonce();
        const script = buildCollectScript(request, nonce);
        const abort = new AbortController();
        state.abort = abort;
        const sshTimeout = Math.max(2, Math.min(60, config.sshTimeoutSeconds));
        try {
            const result = await this.runner.exec(state.host, script, {
                timeoutMs: (sshTimeout + request.commandTimeoutSeconds * 3) * 1000,
                connectTimeoutSeconds: sshTimeout,
                signal: abort.signal
            });
            if (this.disposed || !this.states.has(state.host)) {
                return;
            }
            const output = splitScriptOutput(result.stdout, nonce);
            if (!output.complete) {
                throw new SshError('The server returned incomplete output. Is /bin/sh available?', 'incomplete',
                    (result.stderr || output.preamble).slice(0, 400), result.exitCode);
            }
            if (output.preamble) {
                this.log.debug(`${state.host}: ignored ${output.preamble.length} characters printed by the login shell.`);
            }
            const finishedAt = this.clock.now();
            this.applySections(state, request, output.sections, config, finishedAt);
            state.failures = 0;
            state.nextRetryAt = 0;
            const snapshot = state.snapshot;
            snapshot.error = undefined;
            snapshot.errorDetail = undefined;
            snapshot.errorCategory = undefined;
            snapshot.nextRetryAt = undefined;
            snapshot.stale = false;
            snapshot.collectedAt = finishedAt;
            snapshot.lastSuccessAt = finishedAt;
            snapshot.latencyMs = result.durationMs;
            snapshot.multiplexed = result.multiplexed;
            for (const metric of job.metrics) {
                state.due[metric] = finishedAt + this.intervalMs(metric, config);
            }
            this.log.debug(`${state.host}: collected ${Array.from(job.metrics).join(',')} in ${result.durationMs} ms`);
        } catch (error) {
            if (this.disposed || !this.states.has(state.host)) {
                return;
            }
            const now = this.clock.now();
            const cancelled = error instanceof SshError && error.kind === 'cancelled';
            if (!cancelled) {
                state.failures += 1;
                const base = Math.max(MIN_BACKOFF_MS, this.intervalMs('gpu', config));
                state.nextRetryAt = now + Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(state.failures - 1, 8));
                if (error instanceof SshError && error.kind === 'timeout' && request.disk) {
                    // Most often a hung network mount: keep GPU/CPU/memory flowing without df for a while.
                    state.diskSuspendedUntil = now + DISK_SUSPEND_MS;
                }
            }
            const snapshot = state.snapshot;
            snapshot.error = error instanceof Error ? error.message : String(error);
            snapshot.errorDetail = error instanceof SshError ? error.detail : undefined;
            snapshot.errorCategory = errorCategory(error);
            snapshot.nextRetryAt = cancelled ? undefined : state.nextRetryAt;
            snapshot.collectedAt = now;
            snapshot.latencyMs = now - startedAt;
            snapshot.stale = Boolean(snapshot.lastSuccessAt);
            this.log.info(`${state.host}: ${snapshot.errorCategory}: ${snapshot.error}`);
        } finally {
            if (state.abort === abort) {
                state.abort = undefined;
            }
            if (!this.disposed && this.states.has(state.host)) {
                this.events.emit('host', state.host);
            }
        }
    }

    private applySections(state: HostState, request: CollectRequest, sections: Map<string, ScriptSection>, config: MonitorConfig, now: number): void {
        const snapshot = state.snapshot;
        const updatedAt = { ...(snapshot.updatedAt || {}) };
        if (request.gpu) {
            const gpu = this.gpuParser.parseGpuSections(sections);
            snapshot.gpuState = gpu.state;
            snapshot.gpuError = gpu.error;
            if (gpu.state === 'ok' || gpu.state === 'missing') {
                const previousSlurm = new Map(snapshot.gpus.flatMap(item => item.processes).filter(item => item.slurm).map(item => [item.pid, item.slurm]));
                snapshot.gpus = gpu.gpus;
                if (request.slurm) {
                    snapshot.slurmAvailable = gpu.slurmAvailable;
                } else if (config.slurm) {
                    // Slurm refreshes less often than GPUs; carry job names over between its samples.
                    for (const process of snapshot.gpus.flatMap(item => item.processes)) {
                        process.slurm = process.slurm || previousSlurm.get(process.pid);
                    }
                } else {
                    snapshot.slurmAvailable = false;
                }
                updatedAt.gpu = now;
            }
        }
        if (request.system) {
            const system = parseSystemSection(sections.get('sys')?.body || '');
            if (Object.keys(system).length) {
                snapshot.system = system;
                updatedAt.system = now;
            }
        }
        if (request.cpu) {
            const section = sections.get('cpu');
            const sample = parseCpuSection(section?.body || '');
            const cpu: CpuInfo = {
                logicalCores: sample.logicalCores,
                availableCores: sample.availableCores,
                physicalCores: snapshot.system?.physicalCores,
                model: snapshot.system?.cpuModel,
                load1: sample.load1,
                load5: sample.load5,
                load15: sample.load15,
                runningProcesses: sample.runningProcesses,
                totalProcesses: sample.totalProcesses
            };
            let usage;
            if (sample.times && sample.times2) {
                usage = cpuUsageBetween(sample.times, sample.times2);
                cpu.windowMs = 500;
            } else if (sample.times && state.previousCpu) {
                usage = cpuUsageBetween(state.previousCpu.times, sample.times);
                cpu.windowMs = now - state.previousCpu.at;
            }
            if (sample.times) {
                state.previousCpu = { times: sample.times2 || sample.times, at: now };
            }
            if (sample.times || sample.load1 !== undefined) {
                snapshot.cpu = { ...cpu, ...(usage || {}) };
                updatedAt.cpu = now;
            }
        }
        if (request.memory) {
            const memory = parseMemInfo(sections.get('mem')?.body || '');
            if (memory) {
                snapshot.memory = memory;
                updatedAt.memory = now;
            }
        }
        if (request.disk) {
            const report = this.parseDisk(state.host, sections, request, config);
            if (report) {
                if (report.error && snapshot.disks && !report.disks.length) {
                    snapshot.disks = { ...snapshot.disks, error: report.error };
                } else {
                    snapshot.disks = report;
                    updatedAt.disk = now;
                }
            }
            state.diskSuspendedUntil = 0;
        }
        snapshot.updatedAt = updatedAt;
    }

    private parseDisk(host: string, sections: Map<string, ScriptSection>, request: CollectRequest, config: MonitorConfig): DiskReport | undefined {
        const df = sections.get('df');
        if (!df) {
            return undefined;
        }
        const filters = config.diskFilters(host);
        const lines = df.body.split(/\r?\n/);
        const partial = lines.some(line => line.trim() === '#timeout');
        const typesFromMounts = lines.some(line => line.trim() === '#notype');
        let mounts = parseDf(df.body, !typesFromMounts);
        if (typesFromMounts) {
            const types = parseProcMounts(sections.get('mounts')?.body || '');
            mounts = mounts.map(mount => ({ ...mount, fsType: types.get(mount.mountPoint)?.fsType }));
        }
        const pinned = parsePinnedDf(sections.get('dfpin')?.body || '', request.pinnedPaths);
        const quotaSection = sections.get('quota');
        const lustreSection = sections.get('lustre');
        const quotas = [
            ...(quotaSection && quotaSection.exitCode !== 127 ? parseQuota(quotaSection.body) : []),
            ...(lustreSection ? parseLustreQuota(lustreSection.body) : [])
        ];
        const report = buildDiskReport({
            mounts,
            pinned: pinned.resolved,
            missingPinned: pinned.missing,
            quotas,
            quotaToolAvailable: Boolean((quotaSection && quotaSection.exitCode !== 127) || lustreSection?.body.includes('#mount ')),
            partial,
            typesFromMounts,
            filters
        });
        if (!mounts.length) {
            report.error = df.exitCode === 124
                ? 'df did not respond in time. A network filesystem may be unreachable.'
                : 'df returned no filesystems.';
        } else if (partial) {
            report.error = 'df timed out; only local filesystems are shown. A network filesystem may be unreachable.';
        }
        return report;
    }
}
