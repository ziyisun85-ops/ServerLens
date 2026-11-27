// GPU data collection: parses nvidia-smi, ps and Slurm output collected by remoteScript.ts.
// Modified for ServerLens (2026): SSH execution moved to sshTransport.ts and the batched
// collection script; added missing-GPU detection and section-based parsing.
import { ScriptSection } from './remoteScript';

export interface SlurmJobInfo {
    id: string;
    name: string;
    state: string;
}

export interface GpuProcessInfo {
    pid: string;
    user: string;
    name: string;
    command: string;
    elapsedSeconds: number;
    startIdentity?: string;
    usedMemory: string;
    slurm?: SlurmJobInfo;
}

export interface GpuInfo {
    index: string;
    uuid: string;
    name: string;
    utilization: { gpu: string; memory: string };
    memory: { total: string; free: string; used: string };
    temperature: { gpu: string };
    power: { draw: string; limit: string };
    fanSpeed: string;
    processes: GpuProcessInfo[];
}

interface ProcessDetails {
    user: string;
    elapsedSeconds: number;
    command: string;
    startIdentity?: string;
}

export type GpuState = 'ok' | 'missing' | 'error' | 'unknown';

export interface GpuCollection {
    state: GpuState;
    gpus: GpuInfo[];
    /** nvidia-smi output when it failed, e.g. a driver/library mismatch. */
    error?: string;
    slurmAvailable: boolean;
}

export class GpuMonitor {
    /**
     * Interprets the gpu, gpuproc, procinfo and slurm sections of one collection.
     * A host without nvidia-smi is reported as 'missing', not as an error, so CPU,
     * memory and disks still show for CPU-only servers.
     */
    public parseGpuSections(sections: Map<string, ScriptSection>): GpuCollection {
        const gpuSection = sections.get('gpu');
        if (!gpuSection) {
            return { state: 'unknown', gpus: [], slurmAvailable: false };
        }
        if (gpuSection.exitCode === 127) {
            return { state: 'missing', gpus: [], slurmAvailable: false };
        }
        if (gpuSection.exitCode !== 0) {
            const reason = gpuSection.exitCode === 124
                ? 'nvidia-smi did not respond in time.'
                : gpuSection.body.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).join(' ') ||
                    `nvidia-smi exited with code ${gpuSection.exitCode ?? 'unknown'}.`;
            return { state: 'error', gpus: [], error: reason.slice(0, 400), slurmAvailable: false };
        }
        const details = this.parseProcessDetails(sections.get('procinfo')?.body || '');
        const slurm = this.parseSlurm(sections.get('slurmpids')?.body || '', sections.get('slurmjobs')?.body || '');
        const gpus = this.parseNvidiaSmiQuery(gpuSection.body, sections.get('gpuproc')?.body || '', details);
        for (const gpu of gpus) {
            for (const process of gpu.processes) {
                const jobId = slurm.pidToJob.get(process.pid);
                if (jobId) {
                    process.slurm = slurm.jobs.get(jobId) || { id: jobId, name: 'N/A', state: 'N/A' };
                }
            }
        }
        return { state: 'ok', gpus, slurmAvailable: slurm.available };
    }

    public parseNvidiaSmiQuery(
        gpuOutput: string,
        processOutput = '',
        details: Map<string, string | ProcessDetails> = new Map()
    ): GpuInfo[] {
        const processesByUuid = new Map<string, GpuProcessInfo[]>();
        for (const line of processOutput.split(/\r?\n/).filter(Boolean)) {
            const [uuid, pid, processName, usedMemory] = this.parseCsvLine(line);
            if (!uuid || !pid) {
                continue;
            }
            const rawDetails = details.get(pid);
            const processDetails = typeof rawDetails === 'string'
                ? { user: rawDetails, elapsedSeconds: 0, command: processName || 'unknown' }
                : rawDetails;
            const processes = processesByUuid.get(uuid) || [];
            processes.push({
                pid,
                user: processDetails?.user || 'unknown',
                name: processName || 'unknown',
                command: processDetails?.command || processName || 'unknown',
                elapsedSeconds: processDetails?.elapsedSeconds || 0,
                startIdentity: processDetails?.startIdentity,
                usedMemory: this.withUnit(usedMemory, 'MiB')
            });
            processesByUuid.set(uuid, processes);
        }

        return gpuOutput.split(/\r?\n/).filter(line => /^\s*\d+\s*,/.test(line)).map(line => {
            const values = this.parseCsvLine(line);
            const [index, uuid, name, gpuUtilization, memoryUtilization, memoryTotal,
                memoryFree, memoryUsed, temperature, powerDraw, powerLimit, fanSpeed] = values;
            return {
                index: this.value(index),
                uuid: this.value(uuid),
                name: this.value(name, 'Unknown GPU'),
                utilization: {
                    gpu: this.withUnit(gpuUtilization, '%'),
                    memory: this.withUnit(memoryUtilization, '%')
                },
                memory: {
                    total: this.withUnit(memoryTotal, 'MiB'),
                    free: this.withUnit(memoryFree, 'MiB'),
                    used: this.withUnit(memoryUsed, 'MiB')
                },
                temperature: { gpu: this.withUnit(temperature, 'C') },
                power: {
                    draw: this.withUnit(powerDraw, 'W'),
                    limit: this.withUnit(powerLimit, 'W')
                },
                fanSpeed: this.withUnit(fanSpeed, '%'),
                processes: processesByUuid.get(uuid) || []
            };
        });
    }

    public parseProcessDetails(output: string): Map<string, ProcessDetails> {
        const details = new Map<string, ProcessDetails>();
        for (const line of output.split(/\r?\n/)) {
            const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
            if (match) {
                const started = match[4].match(/^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
                details.set(match[1], {
                    user: match[2],
                    elapsedSeconds: Number.parseInt(match[3], 10) || 0,
                    command: started ? started[2] : match[4],
                    startIdentity: started?.[1]
                });
            }
        }
        return details;
    }

    public parseSlurm(pidOutput: string, jobOutput: string): {
        available: boolean;
        pidToJob: Map<string, string>;
        jobs: Map<string, SlurmJobInfo>;
    } {
        const pidToJob = new Map<string, string>();
        for (const line of pidOutput.split(/\r?\n/)) {
            const match = line.trim().match(/^(\d+)\|([^|\s]+)$/);
            if (match) {
                pidToJob.set(match[1], match[2]);
            }
        }
        const jobs = new Map<string, SlurmJobInfo>();
        for (const line of jobOutput.split(/\r?\n/)) {
            const [id, name, state] = line.trim().split('|');
            if (id) {
                jobs.set(id, { id, name: name || 'N/A', state: state || 'N/A' });
            }
        }
        return { available: pidOutput.split(/\r?\n/).includes('available'), pidToJob, jobs };
    }

    private parseCsvLine(line: string): string[] {
        const values: string[] = [];
        let value = '';
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index];
            if (character === '"') {
                if (quoted && line[index + 1] === '"') {
                    value += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (character === ',' && !quoted) {
                values.push(value.trim());
                value = '';
            } else {
                value += character;
            }
        }
        values.push(value.trim());
        return values;
    }

    private withUnit(value: unknown, unit: string): string {
        const normalized = this.value(value);
        return normalized === 'N/A' ? normalized : `${normalized} ${unit}`;
    }

    private value(value: unknown, fallback = 'N/A'): string {
        if (typeof value === 'string' && value.trim()) {
            const normalized = value.trim();
            // nvidia-smi prints [N/A], [Not Supported], [Unknown Error] and similar placeholders.
            return /^\[.*\]$/.test(normalized) || /^N\/A$/i.test(normalized) ? 'N/A' : normalized;
        }
        if (typeof value === 'number') {
            return value.toString();
        }
        return fallback;
    }
}
