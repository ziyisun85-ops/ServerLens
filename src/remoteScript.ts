// ServerLens: builds the POSIX sh scripts that run on monitored hosts and splits their output.
// Everything here is read-only and needs no root, agent or extra packages on the server.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import { randomBytes } from 'crypto';

export const GPU_QUERY_FIELDS = [
    'index', 'uuid', 'name', 'utilization.gpu', 'utilization.memory',
    'memory.total', 'memory.free', 'memory.used', 'temperature.gpu',
    'power.draw', 'power.limit', 'fan.speed'
].join(',');

export interface CollectRequest {
    gpu: boolean;
    /** List compute processes (needed for availability rules and the process view). */
    gpuProcesses: boolean;
    /** Resolve process owners, runtimes and commands with ps. */
    processOwners: boolean;
    slurm: boolean;
    cpu: boolean;
    /** Read /proc/stat twice ~0.5 s apart so the first CPU usage needs no previous sample. */
    cpuDoubleSample: boolean;
    memory: boolean;
    system: boolean;
    disk: boolean;
    /** Paths the user pinned; each is resolved to its filesystem with `df <path>`. */
    pinnedPaths: string[];
    quota: boolean;
    /** Per-command limit applied with `timeout` when the host has it. */
    commandTimeoutSeconds: number;
}

/** Locations that tests replace with fixture directories. */
export interface ScriptRoots {
    proc: string;
    etc: string;
}

const DEFAULT_ROOTS: ScriptRoots = { proc: '/proc', etc: '/etc' };

export function newNonce(): string {
    return randomBytes(8).toString('hex');
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Validates a user-supplied remote path: absolute or relative to ~, single line, bounded length. */
export function validateRemotePath(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Path must be text.');
    }
    const path = value.trim();
    if (!path || path.length > 1024 || /[\0\r\n]/.test(path)) {
        throw new Error('Enter a single-line path up to 1024 characters.');
    }
    if (!(path.startsWith('/') || path === '~' || path.startsWith('~/'))) {
        throw new Error('Use an absolute path (/data/...) or a path under your home directory (~/...).');
    }
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Quotes a validated path for sh, expanding a leading ~ to $HOME and nothing else. */
export function shellPath(path: string): string {
    if (path === '~') {
        return '"$HOME"';
    }
    if (path.startsWith('~/')) {
        return `"$HOME"${shellQuote(path.slice(1))}`;
    }
    return shellQuote(path);
}

function marker(nonce: string, text: string): string {
    return `@@SL:${nonce}:${text}@@`;
}

const PRELUDE = (nonce: string, timeoutSeconds: number) => `SL_N=${nonce}
SL_TO=${Math.max(2, Math.round(timeoutSeconds))}
LC_ALL=C
LANG=C
export LC_ALL LANG
sl_begin() { printf '\\n@@SL:%s:begin %s@@\\n' "$SL_N" "$1"; }
sl_end() { printf '\\n@@SL:%s:end %s %s@@\\n' "$SL_N" "$1" "$2"; }
sl_have() { command -v "$1" >/dev/null 2>&1; }
if sl_have timeout && timeout 5 true >/dev/null 2>&1; then
  sl_t() { timeout "$@"; }
else
  sl_t() { shift; "$@"; }
fi`;

function gpuSection(request: CollectRequest): string {
    const lines = [
        `sl_begin gpu`,
        `SL_SMI=`,
        `if sl_have nvidia-smi; then SL_SMI=nvidia-smi; else for c in /usr/bin/nvidia-smi /usr/local/nvidia/bin/nvidia-smi /usr/local/bin/nvidia-smi; do if [ -x "$c" ]; then SL_SMI=$c; break; fi; done; fi`,
        `if [ -n "$SL_SMI" ]; then sl_t "$SL_TO" "$SL_SMI" --query-gpu=${GPU_QUERY_FIELDS} --format=csv,noheader,nounits 2>&1; sl_rc=$?; else sl_rc=127; fi`,
        `sl_end gpu $sl_rc`,
        `sl_gpu_rc=$sl_rc`
    ];
    if (request.gpuProcesses || request.processOwners) {
        lines.push(
            `sl_begin gpuproc`,
            `sl_procs=`,
            `sl_rc=127`,
            `if [ "$sl_gpu_rc" = 0 ]; then sl_procs=$(sl_t "$SL_TO" "$SL_SMI" --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null); sl_rc=$?; printf '%s\\n' "$sl_procs"; fi`,
            `sl_end gpuproc $sl_rc`
        );
    }
    if (request.processOwners) {
        lines.push(
            `sl_begin procinfo`,
            `sl_pids=$(printf '%s\\n' "$sl_procs" | cut -d, -f2 | tr -d ' ' | grep -E '^[0-9]+$' | sort -u | paste -sd, -)`,
            `sl_rc=0`,
            `if [ -n "$sl_pids" ]; then ps -o pid= -o user= -o etimes= -o lstart= -o args= -p "$sl_pids" 2>/dev/null; sl_rc=$?; fi`,
            `sl_end procinfo $sl_rc`
        );
    }
    if (request.slurm) {
        lines.push(
            `sl_begin slurmpids`,
            `if sl_have scontrol; then printf 'available\\n'; sl_t "$SL_TO" scontrol listpids 2>/dev/null | awk 'NR > 1 && $1 ~ /^[0-9]+$/ {print $1 "|" $2}'; fi`,
            `sl_end slurmpids 0`,
            `sl_begin slurmjobs`,
            `if sl_have squeue; then sl_t "$SL_TO" squeue -h -o '%A|%j|%T' 2>/dev/null; fi`,
            `sl_end slurmjobs 0`
        );
    }
    return lines.join('\n');
}

function cpuSection(request: CollectRequest, roots: ScriptRoots): string {
    const stat = `${roots.proc}/stat`;
    const lines = [
        `sl_begin cpu`,
        `awk '/^cpu / {print "stat " $0} /^cpu[0-9]/ {n++} END {print "ncpu " n+0}' ${shellQuote(stat)} 2>/dev/null`
    ];
    if (request.cpuDoubleSample) {
        lines.push(
            `sleep 0.5 2>/dev/null || sleep 1`,
            `awk '/^cpu / {print "stat2 " $0}' ${shellQuote(stat)} 2>/dev/null`
        );
    }
    lines.push(
        `printf 'loadavg %s\\n' "$(cat ${shellQuote(`${roots.proc}/loadavg`)} 2>/dev/null)"`,
        `printf 'nproc %s\\n' "$(nproc 2>/dev/null)"`,
        `sl_end cpu 0`
    );
    return lines.join('\n');
}

function memorySection(roots: ScriptRoots): string {
    return [
        `sl_begin mem`,
        `grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|Shmem|SwapTotal|SwapFree):' ${shellQuote(`${roots.proc}/meminfo`)} 2>/dev/null`,
        `sl_end mem $?`
    ].join('\n');
}

function systemSection(roots: ScriptRoots): string {
    const cpuinfo = shellQuote(`${roots.proc}/cpuinfo`);
    return [
        `sl_begin sys`,
        `printf 'hostname %s\\n' "$(uname -n 2>/dev/null)"`,
        `printf 'kernel %s\\n' "$(uname -r 2>/dev/null)"`,
        `printf 'arch %s\\n' "$(uname -m 2>/dev/null)"`,
        `printf 'user %s\\n' "$(id -un 2>/dev/null)"`,
        `printf 'os %s\\n' "$(sed -n 's/^PRETTY_NAME=//p' ${shellQuote(`${roots.etc}/os-release`)} 2>/dev/null | head -n 1)"`,
        `printf 'uptime %s\\n' "$(cut -d' ' -f1 ${shellQuote(`${roots.proc}/uptime`)} 2>/dev/null)"`,
        `printf 'cpumodel %s\\n' "$(grep -m1 -E '^(model name|Model|Hardware|cpu model)[[:space:]]*:' ${cpuinfo} 2>/dev/null | cut -d: -f2-)"`,
        `printf 'cores %s\\n' "$(awk -F: '/^physical id/ {p=$2} /^core id/ {c[p ":" $2]=1} END {n=0; for (k in c) n++; print n}' ${cpuinfo} 2>/dev/null)"`,
        `sl_end sys 0`
    ].join('\n');
}

function diskSection(request: CollectRequest, roots: ScriptRoots): string {
    const lines = [
        `sl_begin df`,
        `sl_out=$(sl_t "$SL_TO" df -P -k -T 2>/dev/null); sl_rc=$?`,
        // A hung network mount stalls df for every filesystem; fall back to local ones.
        `if [ "$sl_rc" = 124 ]; then printf '#timeout\\n'; sl_out=$(sl_t "$SL_TO" df -P -k -T -l 2>/dev/null); sl_rc=$?; fi`,
        `sl_notype=`,
        `if [ -z "$sl_out" ]; then sl_notype=1; printf '#notype\\n'; sl_out=$(sl_t "$SL_TO" df -P -k 2>/dev/null); sl_rc=$?; fi`,
        `printf '%s\\n' "$sl_out"`,
        `sl_end df $sl_rc`,
        `if [ -n "$sl_notype" ]; then sl_begin mounts; cat ${shellQuote(`${roots.proc}/mounts`)} 2>/dev/null; sl_end mounts $?; fi`
    ];
    if (request.pinnedPaths.length) {
        lines.push(
            `sl_begin dfpin`,
            `sl_i=0`,
            `for sl_p in ${request.pinnedPaths.map(shellPath).join(' ')}; do`,
            `  if [ -e "$sl_p" ]; then printf '#path %s %s\\n' "$sl_i" "$sl_p"; sl_t "$SL_TO" df -P -k -T "$sl_p" 2>/dev/null | tail -n 1; else printf '#missing %s %s\\n' "$sl_i" "$sl_p"; fi`,
            `  sl_i=$((sl_i + 1))`,
            `done`,
            `sl_end dfpin 0`
        );
    }
    if (request.quota) {
        lines.push(
            `sl_begin quota`,
            `sl_rc=127`,
            `if sl_have quota; then`,
            `  sl_q=$(sl_t "$SL_TO" quota -v -w 2>&1); sl_rc=$?`,
            `  case "$sl_q" in *"nvalid option"*|*"nrecognized option"*|*"sage:"*) sl_q=$(sl_t "$SL_TO" quota -v 2>&1); sl_rc=$?;; esac`,
            `  printf '%s\\n' "$sl_q"`,
            `fi`,
            `sl_end quota $sl_rc`,
            `sl_begin lustre`,
            `if sl_have lfs; then for sl_m in $(awk '$3 == "lustre" {print $2}' ${shellQuote(`${roots.proc}/mounts`)} 2>/dev/null); do printf '#mount %s\\n' "$sl_m"; sl_t "$SL_TO" lfs quota -u "$(id -un)" "$sl_m" 2>&1; done; fi`,
            `sl_end lustre 0`
        );
    }
    return lines.join('\n');
}

/** Builds one script that collects every requested metric in a single SSH round trip. */
export function buildCollectScript(request: CollectRequest, nonce: string, roots: ScriptRoots = DEFAULT_ROOTS): string {
    const sections: string[] = [];
    if (request.gpu) {
        sections.push(gpuSection(request));
    }
    if (request.cpu) {
        sections.push(cpuSection(request, roots));
    }
    if (request.memory) {
        sections.push(memorySection(roots));
    }
    if (request.system) {
        sections.push(systemSection(roots));
    }
    if (request.disk) {
        sections.push(diskSection(request, roots));
    }
    // The whole body is parsed before it runs, and its stdin is /dev/null, so no command
    // can consume the rest of the script from `sh -s`.
    return `${PRELUDE(nonce, request.commandTimeoutSeconds)}
sl_main() {
:
${sections.join('\n')}
}
sl_main </dev/null
printf '\\n${marker(nonce, 'done')}\\n'
`;
}

export interface ScriptSection {
    body: string;
    /** Exit code recorded by the section, undefined if the section did not finish. */
    exitCode?: number;
}

export interface ScriptOutput {
    sections: Map<string, ScriptSection>;
    complete: boolean;
    /** Text printed before the first marker, for example by a noisy ~/.bashrc. */
    preamble: string;
}

/** Splits script output at the nonce markers; text that does not carry the nonce is never trusted as a marker. */
export function splitScriptOutput(output: string, nonce: string): ScriptOutput {
    const sections = new Map<string, ScriptSection>();
    const prefix = `@@SL:${nonce}:`;
    let current: { name: string; lines: string[] } | undefined;
    const preamble: string[] = [];
    let complete = false;
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith(prefix) && line.endsWith('@@')) {
            const content = line.slice(prefix.length, -2);
            const begin = content.match(/^begin (\S+)$/);
            const end = content.match(/^end (\S+) (-?\d+)?$/) || content.match(/^end (\S+)$/);
            if (begin) {
                current = { name: begin[1], lines: [] };
            } else if (end && current && end[1] === current.name) {
                sections.set(current.name, {
                    body: current.lines.join('\n').trim(),
                    exitCode: end[2] === undefined ? undefined : Number(end[2])
                });
                current = undefined;
            } else if (content === 'done') {
                complete = true;
            }
            continue;
        }
        if (current) {
            current.lines.push(rawLine);
        } else if (!complete && line) {
            preamble.push(line);
        }
    }
    if (current) {
        sections.set(current.name, { body: current.lines.join('\n').trim() });
    }
    return { sections, complete, preamble: preamble.join('\n') };
}

/** Stops a storage scan (see storageAnalyzer.ts), but only if the PID still runs du. */
export function buildStopScanScript(pid: number): string {
    const safePid = Math.trunc(pid);
    if (!Number.isFinite(safePid) || safePid <= 1) {
        throw new Error('Invalid process id.');
    }
    return `sl_p=${safePid}
if [ -r /proc/$sl_p/cmdline ] && tr '\\000' ' ' </proc/$sl_p/cmdline | grep -qw du; then kill -TERM "$sl_p" 2>/dev/null; fi
exit 0
`;
}
