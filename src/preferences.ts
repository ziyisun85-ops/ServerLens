// Settings shown in the dashboard's settings dialog, with validation of what the webview sends.
// Modified for ServerLens (2026): per-metric intervals, connection reuse, storage group; AI fields removed.
export interface PreferenceField {
    key: string;
    group: string;
    label: [string, string];
    type: 'boolean' | 'number' | 'string' | 'hosts' | 'enum' | 'events' | 'gpus' | 'list';
    default: unknown;
    min?: number;
    max?: number;
    options?: string[];
    /** English and Chinese labels for enum options. */
    optionLabels?: Record<string, [string, string]>;
}

export const preferenceFields: PreferenceField[] = [
    { key: 'sshConfigPath', group: 'servers', label: ['SSH config file', 'SSH 配置文件'], type: 'string', default: '~/.ssh/config' },
    { key: 'additionalHosts', group: 'servers', label: ['Additional SSH hosts (one per line)', '额外 SSH 主机（每行一个）'], type: 'hosts', default: [] },
    { key: 'targets', group: 'servers', label: ['Monitored SSH aliases (empty = all)', '监控的 SSH 别名（留空表示全部）'], type: 'hosts', default: [] },
    { key: 'ignoredHosts', group: 'servers', label: ['Excluded SSH aliases', '排除的 SSH 别名'], type: 'hosts', default: [] },
    { key: 'visibleGpus', group: 'servers', label: ['Visible GPUs per server', '各服务器显示的 GPU'], type: 'gpus', default: {} },
    { key: 'researchUser', group: 'servers', label: ['My remote username', '我的远程用户名'], type: 'string', default: '' },
    { key: 'language', group: 'display', label: ['Language', '语言'], type: 'enum', options: ['auto', 'en', 'zh-CN'], default: 'auto' },
    { key: 'autoRefresh', group: 'refresh', label: ['Automatic refresh', '自动刷新'], type: 'boolean', default: true },
    { key: 'refreshInterval', group: 'refresh', label: ['GPU refresh interval (seconds)', 'GPU 刷新间隔（秒）'], type: 'number', min: 2, max: 300, default: 5 },
    { key: 'cpuRefreshInterval', group: 'refresh', label: ['CPU refresh interval (seconds)', 'CPU 刷新间隔（秒）'], type: 'number', min: 2, max: 300, default: 5 },
    { key: 'memoryRefreshInterval', group: 'refresh', label: ['Memory refresh interval (seconds)', '内存刷新间隔（秒）'], type: 'number', min: 2, max: 300, default: 5 },
    { key: 'diskRefreshInterval', group: 'refresh', label: ['Disk refresh interval (seconds)', '磁盘刷新间隔（秒）'], type: 'number', min: 10, max: 3600, default: 60 },
    { key: 'connectionReuse', group: 'refresh', label: ['Reuse one SSH connection per server', '每台服务器复用一个 SSH 连接'], type: 'boolean', default: true },
    { key: 'connectionIdleSeconds', group: 'refresh', label: ['Close idle connections after (seconds)', '空闲连接关闭时间（秒）'], type: 'number', min: 10, max: 3600, default: 120 },
    { key: 'sshTimeout', group: 'refresh', label: ['SSH timeout (seconds)', 'SSH 超时（秒）'], type: 'number', min: 2, max: 60, default: 8 },
    { key: 'maxConcurrentHosts', group: 'refresh', label: ['Concurrent servers', '并发查询服务器数'], type: 'number', min: 1, max: 32, default: 8 },
    { key: 'pauseWhenHidden', group: 'refresh', label: ['Pause automatic refresh while hidden', '面板隐藏时暂停自动刷新'], type: 'boolean', default: true },
    ...([
        ['compactLayout', 'Compact GPU matrix', '紧凑 GPU 矩阵'],
        ['showUtilization', 'GPU utilization', 'GPU 利用率'],
        ['showTemperature', 'Temperature', '温度'],
        ['showPower', 'Power draw', '功耗'],
        ['showFanSpeed', 'Fan speed', '风扇转速'],
        ['showProcesses', 'Process details', '进程详情'],
        ['showHostHealth', 'Server health', '服务器健康信息'],
        ['showStatusBar', 'VS Code status bar summary', 'VS Code 状态栏摘要']
    ] as const).map(([key, en, zh]) => ({ key, group: 'display', label: [en, zh] as [string, string], type: 'boolean' as const, default: true })),
    { key: 'availabilityRequireNoProcesses', group: 'availability', label: ['Require no compute processes', '要求无计算进程'], type: 'boolean', default: true },
    { key: 'availabilityMaxMemoryMiB', group: 'availability', label: ['Maximum used memory (MiB)', '最大已用显存（MiB）'], type: 'number', min: 0, max: 1048576, default: 512 },
    { key: 'availabilityMaxUtilization', group: 'availability', label: ['Maximum utilization (%)', '最大利用率（%）'], type: 'number', min: 0, max: 100, default: 10 },
    { key: 'enableSlurmIntegration', group: 'display', label: ['Detect Slurm jobs', '识别 Slurm 作业'], type: 'boolean', default: true },
    { key: 'slurmRefreshInterval', group: 'refresh', label: ['Slurm refresh interval (seconds)', 'Slurm 刷新间隔（秒）'], type: 'number', min: 5, max: 300, default: 30 },
    { key: 'enableNotifications', group: 'notifications', label: ['Notify on availability, offline servers, and warnings', '通知 GPU 释放、服务器上下线和阈值告警'], type: 'boolean', default: false },
    { key: 'notificationEvents', group: 'notifications', label: ['Notification events', '通知事件'], type: 'events', options: ['serverState','gpuAvailable','threshold'], default: ['serverState','gpuAvailable','threshold'] },
    { key: 'notificationCooldownSeconds', group: 'notifications', label: ['Notification cooldown (seconds)', '通知冷却时间（秒）'], type: 'number', min: 0, max: 3600, default: 60 },
    { key: 'memoryWarningThreshold', group: 'notifications', label: ['Memory warning (%)', '显存警告阈值（%）'], type: 'number', min: 1, max: 100, default: 85 },
    { key: 'temperatureWarningThreshold', group: 'notifications', label: ['Temperature warning (°C)', '温度警告阈值（°C）'], type: 'number', min: 1, max: 120, default: 80 },
    { key: 'powerWarningThreshold', group: 'notifications', label: ['Power warning (% of limit)', '功耗警告阈值（上限百分比）'], type: 'number', min: 1, max: 100, default: 90 },
    { key: 'diskWarningThreshold', group: 'storage', label: ['Disk warning, yellow (%)', '磁盘警告阈值，黄色（%）'], type: 'number', min: 1, max: 100, default: 70 },
    { key: 'diskCriticalThreshold', group: 'storage', label: ['Disk critical, red (%)', '磁盘严重阈值，红色（%）'], type: 'number', min: 1, max: 100, default: 90 },
    { key: 'diskAlerts', group: 'storage', label: ['Disk capacity notifications', '磁盘容量提醒'], type: 'enum', options: ['off', 'critical', 'warning'], default: 'critical',
        optionLabels: { off: ['Off', '关闭'], critical: ['At the critical threshold', '达到严重阈值时'], warning: ['At warning and critical thresholds', '达到警告和严重阈值时'] } },
    { key: 'pinnedMounts', group: 'storage', label: ['Pinned paths (one per line, host:/path for one server)', '固定显示的路径（每行一个，host:/path 仅对一台服务器）'], type: 'list', default: [] },
    { key: 'hiddenMounts', group: 'storage', label: ['Hidden mount patterns (one per line)', '隐藏的挂载点模式（每行一个）'], type: 'list', default: [] },
    { key: 'hiddenFilesystemTypes', group: 'storage', label: ['Hidden filesystem types (one per line)', '隐藏的文件系统类型（每行一个）'], type: 'list', default: [] },
    { key: 'showAllFilesystems', group: 'storage', label: ['Show system filesystems too (tmpfs, overlay…)', '同时显示系统文件系统（tmpfs、overlay 等）'], type: 'boolean', default: false },
    { key: 'showQuota', group: 'storage', label: ['Show personal disk quotas', '显示个人磁盘配额'], type: 'boolean', default: true },
    { key: 'byteUnits', group: 'storage', label: ['Size units', '容量单位'], type: 'enum', options: ['iec', 'si'], default: 'iec',
        optionLabels: { iec: ['GiB / TiB (base 1024)', 'GiB / TiB（1024 进制）'], si: ['GB / TB (base 1000)', 'GB / TB（1000 进制）'] } },
    { key: 'storagePaths', group: 'storage', label: ['Folders for Analyze Storage (path or Label=path)', '目录分析的常用目录（路径或 名称=路径）'], type: 'list', default: [] },
    { key: 'storageScanDepth', group: 'storage', label: ['Analyze Storage depth (levels)', '目录分析深度（层）'], type: 'number', min: 1, max: 4, default: 2 },
    { key: 'storageScanTimeout', group: 'storage', label: ['Analyze Storage time limit (seconds)', '目录分析时间上限（秒）'], type: 'number', min: 10, max: 600, default: 60 }
];

export function validatePreferenceChanges(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.');
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        const field = preferenceFields.find(item => item.key === key);
        if (!field) throw new Error(`Unknown setting: ${key}`);
        let valid = false;
        if (field.type === 'boolean') valid = typeof value === 'boolean';
        if (field.type === 'number') valid = typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity);
        if (field.type === 'enum') valid = typeof value === 'string' && Boolean(field.options?.includes(value));
        if (field.type === 'string') valid = typeof value === 'string' && value.length <= 2048 && !/[\r\n\0]/.test(value);
        if (field.type === 'hosts') valid = Array.isArray(value) && value.length <= 500 &&
            value.every(host => typeof host === 'string' && !host.startsWith('-') && /^[A-Za-z0-9_.:@-]+$/.test(host));
        if (field.type === 'list') valid = Array.isArray(value) && value.length <= 200 &&
            value.every(item => typeof item === 'string' && item.length <= 1024 && !Array.from(item).some(character => character.charCodeAt(0) < 32));
        if (field.type === 'events') valid = Array.isArray(value) && value.every(event => field.options?.includes(event));
        if (field.type === 'gpus') valid = Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length <= 500 &&
            Object.entries(value).every(([host, ids]) => !['__proto__','constructor','prototype'].includes(host) && !host.startsWith('-') && /^[A-Za-z0-9_.:@-]+$/.test(host) && Array.isArray(ids) && ids.length <= 128 && ids.every(id => typeof id === 'string' && /^(?:\d{1,4}|GPU-[\w-]+)$/.test(id)));
        if (!valid) throw new Error(`Invalid setting: ${key}`);
        result[key] = typeof value === 'string' ? value.trim()
            : field.type === 'list' ? (value as string[]).map(item => item.trim()).filter(Boolean) : value;
    }
    return result;
}
