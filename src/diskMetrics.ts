// ServerLens: filesystem capacity and quota parsing (df, /proc/mounts, quota, lfs quota).
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import { percentCeil } from './format';

export interface RawMount {
    source: string;
    fsType?: string;
    totalKiB: number;
    usedKiB: number;
    availKiB: number;
    mountPoint: string;
}

export interface QuotaInfo {
    /** Device or export as printed by quota (e.g. /dev/sdb1, nas:/export), or the Lustre mount. */
    filesystem: string;
    mountPoint?: string;
    usedKiB: number;
    softKiB?: number;
    hardKiB?: number;
    grace?: string;
    filesUsed?: number;
    filesSoft?: number;
    filesHard?: number;
    overSoftLimit: boolean;
    source: 'quota' | 'lustre';
}

export interface DiskInfo {
    /** Stable key: the displayed mount point. */
    id: string;
    mountPoint: string;
    /** Other mount points of the same filesystem (bind mounts, btrfs subvolumes, repeated NFS mounts). */
    alsoMountedAt: string[];
    /** Pinned paths that live on this filesystem. */
    pinnedPaths: string[];
    pinned: boolean;
    source: string;
    fsType: string;
    network: boolean;
    totalKiB: number;
    usedKiB: number;
    availKiB: number;
    /** used / (used + available), rounded up like df's Use% column. */
    usedPercent: number;
    quota?: QuotaInfo;
}

export interface DiskReport {
    disks: DiskInfo[];
    /** Filesystems hidden by type or mount pattern (still counted for transparency). */
    hidden: { mountPoint: string; fsType: string }[];
    /** Quotas that could not be matched to a displayed filesystem. */
    otherQuotas: QuotaInfo[];
    /** quota or lfs was found on the host. */
    quotaToolAvailable: boolean;
    missingPinnedPaths: string[];
    /** df hung (usually a stale network mount); only local filesystems were read. */
    partial: boolean;
    /** df -T is not supported; types were read from /proc/mounts. */
    typesFromMounts: boolean;
    error?: string;
}

export interface DiskFilters {
    hiddenFsTypes: string[];
    hiddenMountPatterns: string[];
    pinnedPaths: string[];
}

export const DEFAULT_HIDDEN_FS_TYPES = [
    'tmpfs', 'devtmpfs', 'devfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue', 'hugetlbfs',
    'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'autofs', 'binfmt_misc',
    'rpc_pipefs', 'nsfs', 'overlay', 'aufs', 'squashfs', 'efivarfs', 'ramfs', 'selinuxfs', 'iso9660',
    'udf', 'nfsd', 'fuse.lxcfs', 'fuse.gvfsd-fuse', 'fuse.portal', 'fuse.snapfuse', 'zram'
];

export const DEFAULT_HIDDEN_MOUNT_PATTERNS = [
    '/proc', '/proc/*', '/sys', '/sys/*', '/dev', '/dev/*', '/run', '/run/*', '/boot', '/boot/*',
    '/snap/*', '/var/snap/*', '/var/lib/docker/*', '/var/lib/containers/*', '/var/lib/kubelet/*', '/etc/*'
];

const NETWORK_FS = /^(nfs|nfs4|cifs|smb3|smbfs|lustre|gpfs|beegfs|ceph|cephfs|glusterfs|9p|afs|davfs|panfs|wekafs|juicefs|fuse\.(glusterfs|sshfs|s3fs|rclone|juicefs|ceph-fuse|cephfs|gcsfuse|goofys|mountpoint-s3|alluxio|davfs2))$/i;

export function isNetworkFs(fsType: string, source = ''): boolean {
    return NETWORK_FS.test(fsType) || /^[^/\s]+:\//.test(source) || source.startsWith('//');
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some(pattern => globToRegExp(pattern).test(value));
}

/**
 * Settings entries are either global ("/data", "tmpfs") or scoped to one SSH host
 * ("gpu-01:/data"). Returns the entries that apply to `host`.
 */
export function entriesForHost(entries: string[], host: string): string[] {
    const result: string[] = [];
    for (const raw of entries) {
        const entry = raw.trim();
        if (!entry) {
            continue;
        }
        const scoped = entry.match(/^([A-Za-z0-9_.@-]+):([/~*].*)$/);
        if (scoped) {
            if (scoped[1] === host) {
                result.push(scoped[2]);
            }
        } else {
            result.push(entry);
        }
    }
    return result;
}

const DF_WITH_TYPE = /^(.+?)\s+(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+%|-)\s+(\/.*)$/;
const DF_WITHOUT_TYPE = /^(.+?)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+%|-)\s+(\/.*)$/;

/** Parses `df -P -k [-T]` output. Mount points may contain spaces; header lines are skipped. */
export function parseDf(body: string, withType = true): RawMount[] {
    const mounts: RawMount[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim() || /^Filesystem\s/.test(line) || line.startsWith('#')) {
            continue;
        }
        const match = withType ? line.match(DF_WITH_TYPE) : line.match(DF_WITHOUT_TYPE);
        if (!match) {
            continue;
        }
        const offset = withType ? 1 : 0;
        const total = Number(match[2 + offset]);
        const used = Number(match[3 + offset]);
        const avail = Number(match[4 + offset]);
        if (![total, used, avail].every(Number.isFinite)) {
            continue;
        }
        mounts.push({
            source: match[1].trim(),
            fsType: withType ? match[2] : undefined,
            totalKiB: total,
            usedKiB: used,
            availKiB: Math.max(0, avail),
            mountPoint: match[withType ? 7 : 6]
        });
    }
    return mounts;
}

function decodeMountField(value: string): string {
    return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Parses /proc/mounts into mount point → {source, type}. Later entries win (they shadow earlier ones). */
export function parseProcMounts(body: string): Map<string, { source: string; fsType: string }> {
    const result = new Map<string, { source: string; fsType: string }>();
    for (const line of body.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length >= 3) {
            result.set(decodeMountField(fields[1]), { source: decodeMountField(fields[0]), fsType: fields[2] });
        }
    }
    return result;
}

export interface PinnedResolution {
    /** The path as configured, e.g. "~/data". */
    path: string;
    /** The path after $HOME expansion on the host. */
    resolvedPath: string;
    mount?: RawMount;
}

/**
 * Parses the dfpin section: "#path <index> <expanded path>" followed by its df line, or
 * "#missing <index> <expanded path>". `configured` maps indexes back to the settings entries.
 */
export function parsePinnedDf(body: string, configured: string[]): { resolved: PinnedResolution[]; missing: string[] } {
    const resolved: PinnedResolution[] = [];
    const missing: string[] = [];
    let current: PinnedResolution | undefined;
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        const tagged = line.match(/^#(path|missing) (\d+) (.*)$/);
        if (tagged) {
            const path = configured[Number(tagged[2])] ?? tagged[3];
            if (tagged[1] === 'path') {
                current = { path, resolvedPath: tagged[3] };
                resolved.push(current);
            } else {
                missing.push(path);
                current = undefined;
            }
        } else if (current && line && !current.mount) {
            current.mount = parseDf(line, true)[0];
        }
    }
    return { resolved, missing };
}

function numberOrUndefined(token: string | undefined): number | undefined {
    if (token === undefined) {
        return undefined;
    }
    const value = Number(token.replace(/\*$/, ''));
    return Number.isFinite(value) ? value : undefined;
}

function isNumeric(token: string | undefined): boolean {
    return token !== undefined && /^\d+\*?$/.test(token);
}

/** Reads "blocks quota limit [grace] files quota limit [grace]" after the filesystem column. */
function parseQuotaNumbers(filesystem: string, tokens: string[], source: QuotaInfo['source']): QuotaInfo | undefined {
    if (!isNumeric(tokens[0])) {
        return undefined;
    }
    const used = numberOrUndefined(tokens[0]) || 0;
    const soft = numberOrUndefined(tokens[1]);
    const hard = numberOrUndefined(tokens[2]);
    let index = 3;
    let grace: string | undefined;
    if (tokens[index] !== undefined && !isNumeric(tokens[index])) {
        grace = tokens[index] === '-' ? undefined : tokens[index];
        index += 1;
    }
    const filesUsed = numberOrUndefined(tokens[index]);
    const filesSoft = numberOrUndefined(tokens[index + 1]);
    const filesHard = numberOrUndefined(tokens[index + 2]);
    return {
        filesystem,
        usedKiB: used,
        softKiB: soft || undefined,
        hardKiB: hard || undefined,
        grace,
        filesUsed,
        filesSoft: filesSoft || undefined,
        filesHard: filesHard || undefined,
        overSoftLimit: tokens[0].endsWith('*') || Boolean(soft && used > soft),
        source
    };
}

/**
 * Parses `quota -v [-w]` and `lfs quota` output, including lines wrapped after a long
 * filesystem name. Only filesystems with a block limit are returned.
 */
export function parseQuota(body: string, source: QuotaInfo['source'] = 'quota', lustreMount?: string): QuotaInfo[] {
    const quotas: QuotaInfo[] = [];
    let pendingFilesystem: string | undefined;
    let mount = lustreMount;
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (line.startsWith('#mount ')) {
            mount = line.slice(7);
            continue;
        }
        if (/^Disk quotas for/i.test(line) || /^Filesystem\s/i.test(line)) {
            pendingFilesystem = undefined;
            continue;
        }
        const tokens = line.split(/\s+/);
        let quota: QuotaInfo | undefined;
        if (pendingFilesystem && isNumeric(tokens[0])) {
            quota = parseQuotaNumbers(pendingFilesystem, tokens, source);
        } else if (tokens.length === 1 && !isNumeric(tokens[0])) {
            pendingFilesystem = tokens[0];
            continue;
        } else if (tokens.length >= 4) {
            quota = parseQuotaNumbers(tokens[0], tokens.slice(1), source);
        }
        pendingFilesystem = undefined;
        if (quota && (quota.softKiB || quota.hardKiB)) {
            if (source === 'lustre' && mount) {
                quota.mountPoint = mount;
            }
            quotas.push(quota);
        }
    }
    return quotas;
}

/** Parses the lustre section, which repeats "#mount <path>" before each lfs quota output. */
export function parseLustreQuota(body: string): QuotaInfo[] {
    return parseQuota(body, 'lustre');
}

function pathDepth(path: string): number {
    return path === '/' ? 0 : path.split('/').filter(Boolean).length;
}

function chooseDisplayMount(mounts: string[], pinnedMounts: Set<string>): string {
    return [...mounts].sort((left, right) =>
        Number(pinnedMounts.has(right)) - Number(pinnedMounts.has(left)) ||
        pathDepth(left) - pathDepth(right) ||
        left.length - right.length ||
        left.localeCompare(right)
    )[0];
}

export interface DiskReportInput {
    mounts: RawMount[];
    pinned: PinnedResolution[];
    missingPinned: string[];
    quotas: QuotaInfo[];
    quotaToolAvailable: boolean;
    partial: boolean;
    typesFromMounts: boolean;
    filters: DiskFilters;
}

/**
 * Turns raw df rows into the filesystems worth showing: pseudo filesystems are hidden,
 * several mount points of one filesystem are merged, pinned paths are attached and quotas
 * are matched by device. Pinned filesystems come first, the rest by usage.
 */
export function buildDiskReport(input: DiskReportInput): DiskReport {
    const mounts = [...input.mounts];
    for (const pin of input.pinned) {
        if (pin.mount && !mounts.some(mount => mount.mountPoint === pin.mount?.mountPoint)) {
            mounts.push(pin.mount);
        }
    }
    const pinnedByMount = new Map<string, string[]>();
    for (const pin of input.pinned) {
        if (pin.mount) {
            pinnedByMount.set(pin.mount.mountPoint, [...(pinnedByMount.get(pin.mount.mountPoint) || []), pin.path]);
        }
    }
    const groups = new Map<string, RawMount[]>();
    for (const mount of mounts) {
        if (mount.totalKiB <= 0 && !pinnedByMount.has(mount.mountPoint)) {
            continue;
        }
        const key = [mount.source, mount.totalKiB, mount.usedKiB, mount.availKiB].join('\u0000');
        groups.set(key, [...(groups.get(key) || []), mount]);
    }

    const disks: DiskInfo[] = [];
    const hidden: DiskReport['hidden'] = [];
    const pinnedMounts = new Set(pinnedByMount.keys());
    for (const group of groups.values()) {
        const mountPoints = Array.from(new Set(group.map(mount => mount.mountPoint)));
        const display = chooseDisplayMount(mountPoints, pinnedMounts);
        const first = group[0];
        const fsType = group.find(mount => mount.fsType)?.fsType || 'unknown';
        const pinnedPaths = mountPoints.flatMap(mountPoint => pinnedByMount.get(mountPoint) || []);
        const pinned = pinnedPaths.length > 0;
        const typeHidden = matchesAny(fsType, input.filters.hiddenFsTypes);
        const visibleMounts = mountPoints.filter(mountPoint => !matchesAny(mountPoint, input.filters.hiddenMountPatterns));
        if (!pinned && (typeHidden || !visibleMounts.length)) {
            hidden.push({ mountPoint: display, fsType });
            continue;
        }
        const shown = pinned ? display : chooseDisplayMount(visibleMounts, pinnedMounts);
        const usable = first.usedKiB + first.availKiB;
        disks.push({
            id: shown,
            mountPoint: shown,
            alsoMountedAt: mountPoints.filter(mountPoint => mountPoint !== shown).sort(),
            pinnedPaths,
            pinned,
            source: first.source,
            fsType,
            network: isNetworkFs(fsType, first.source),
            totalKiB: first.totalKiB,
            usedKiB: first.usedKiB,
            availKiB: first.availKiB,
            usedPercent: usable > 0 ? percentCeil(first.usedKiB / usable * 100) : 0
        });
    }

    const otherQuotas: QuotaInfo[] = [];
    for (const quota of input.quotas) {
        const disk = disks.find(item =>
            (quota.mountPoint && (item.mountPoint === quota.mountPoint || item.alsoMountedAt.includes(quota.mountPoint))) ||
            item.source === quota.filesystem);
        if (disk && !disk.quota) {
            disk.quota = { ...quota, mountPoint: disk.mountPoint };
        } else {
            otherQuotas.push(quota);
        }
    }

    const pinOrder = (disk: DiskInfo) => Math.min(...disk.pinnedPaths.map(path => input.filters.pinnedPaths.indexOf(path)).filter(index => index >= 0), 1e6);
    disks.sort((left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        (left.pinned && right.pinned ? pinOrder(left) - pinOrder(right) : 0) ||
        right.usedPercent - left.usedPercent ||
        left.mountPoint.localeCompare(right.mountPoint));

    return {
        disks,
        hidden,
        otherQuotas,
        quotaToolAvailable: input.quotaToolAvailable,
        missingPinnedPaths: input.missingPinned,
        partial: input.partial,
        typesFromMounts: input.typesFromMounts
    };
}
