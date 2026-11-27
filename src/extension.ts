// Extension entry point: wires the SSH transport, the monitor, the views and the commands.
// Modified for ServerLens (2026): shared MonitorService, sidebar cards, storage analysis,
// disk alerts, connection cleanup on deactivate; settings migrated once from GPU Fleet Viewer.
import * as vscode from 'vscode';
import { GpuServerProvider, ServerDescription } from './serverProvider';
import { GpuViewPanel, showAvailableGpuQuickPick } from './gpuView';
import { SshConfigParser } from './sshConfig';
import { isValidSshTarget, SshTransport } from './sshTransport';
import { MonitorService } from './monitorService';
import { StorageAnalyzer } from './storageAnalyzer';
import { SidebarViewProvider } from './sidebarView';
import { FleetNotifier } from './notifications';
import { runStorageAnalysis } from './storageCommand';
import { configuration, readMonitorConfig, readViewSettings } from './settings';
import { composeFleet } from './fleetModel';
import { copyToClipboard, serverMetadata } from './serverActions';
import { Logger, plainText } from './log';
import { diskAlertKey } from './alerts';

const configurationKeys = [
    'language',
    'sshConfigPath',
    'targets',
    'additionalHosts',
    'ignoredHosts',
    'autoRefresh',
    'refreshInterval',
    'sshTimeout',
    'maxConcurrentHosts',
    'pauseWhenHidden',
    'compactLayout',
    'showUtilization',
    'showTemperature',
    'showPower',
    'showFanSpeed',
    'showProcesses',
    'showHostHealth',
    'enableSlurmIntegration',
    'slurmRefreshInterval',
    'availabilityRequireNoProcesses',
    'availabilityMaxMemoryMiB',
    'availabilityMaxUtilization',
    'showStatusBar',
    'enableNotifications',
    'notificationEvents',
    'notificationCooldownSeconds',
    'memoryWarningThreshold',
    'temperatureWarningThreshold',
    'powerWarningThreshold',
    'researchUser',
    'visibleGpus'
] as const;

const LEGACY_SECTIONS = ['gpu-fleet-viewer', 'gpu-server-viewer'] as const;
const MIGRATION_FLAG = 'serverlens.legacySettingsMigrated';

/**
 * Copies user-level settings from GPU Fleet Viewer (or its predecessor GPU Server Viewer)
 * once, so users switching to ServerLens keep their host lists and thresholds.
 */
async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(MIGRATION_FLAG)) {
        return;
    }
    const current = vscode.workspace.getConfiguration('serverlens');
    for (const key of configurationKeys) {
        if (current.inspect<unknown>(key)?.globalValue !== undefined) {
            continue;
        }
        for (const section of LEGACY_SECTIONS) {
            const oldValue = vscode.workspace.getConfiguration(section).inspect<unknown>(key)?.globalValue;
            if (oldValue !== undefined) {
                await current.update(key, oldValue, vscode.ConfigurationTarget.Global);
                break;
            }
        }
    }
    await context.globalState.update(MIGRATION_FLAG, true);
}

/** Settings whose change should trigger an immediate collection rather than waiting for the next round. */
const DATA_KEYS = [
    'sshConfigPath', 'targets', 'additionalHosts', 'ignoredHosts', 'showProcesses', 'enableSlurmIntegration',
    'availabilityRequireNoProcesses', 'researchUser', 'showQuota', 'pinnedMounts', 'hiddenMounts',
    'hiddenFilesystemTypes', 'showAllFilesystems', 'connectionReuse'
];

let transport: SshTransport | undefined;
let monitor: MonitorService | undefined;
let storage: StorageAnalyzer | undefined;

/** Accepts a host string, a Servers tree item, or a webview context-menu argument ({ host }). */
function hostFrom(item: unknown): string | undefined {
    if (typeof item === 'string') {
        return isValidSshTarget(item) ? item : undefined;
    }
    if (item && typeof item === 'object' && 'host' in item) {
        const host = (item as { host: unknown }).host;
        return isValidSshTarget(host) ? host : undefined;
    }
    return undefined;
}

function createLogger(channel: vscode.LogOutputChannel): Logger {
    return {
        debug: message => channel.debug(message),
        info: message => channel.info(message),
        warn: message => channel.warn(message),
        error: message => channel.error(message)
    };
}

/** Returned by activate() only when SERVERLENS_TEST=1, for the tests that run inside a real VS Code. */
export interface ServerLensTestApi {
    hosts(): string[];
    snapshot(host: string): { error?: string; errorCategory?: string; lastSuccessAt?: number } | undefined;
    sidebarReadyCount(): number;
    dashboardReadyCount(): number;
}

export async function activate(context: vscode.ExtensionContext): Promise<ServerLensTestApi | undefined> {
    const channel = vscode.window.createOutputChannel('ServerLens', { log: true });
    const log = createLogger(channel);
    try {
        await migrateLegacySettings(context);
    } catch (error) {
        // settings.json may have unsaved edits or syntax errors; ServerLens works without the migration
        // and tries again on the next start.
        log.warn(`Could not copy settings from GPU Fleet Viewer: ${(error as Error).message}`);
    }

    // Parsing ~/.ssh/config is cheap but runs on every scheduling round; keep it for a few seconds.
    let hostCache: { at: number; hosts: string[] } | undefined;
    const hosts = () => {
        if (!hostCache || Date.now() - hostCache.at > 5000) {
            let list: string[] = hostCache?.hosts || [];
            try {
                list = GpuServerProvider.getHosts().map(host => host.host);
            } catch (error) {
                log.warn(`Could not read the server list: ${(error as Error).message}`);
            }
            hostCache = { at: Date.now(), hosts: list };
        }
        return hostCache.hosts;
    };

    transport = new SshTransport(() => {
        const config = configuration();
        return {
            sshConfigPath: config.get<string>('sshConfigPath'),
            connectionReuse: config.get<boolean>('connectionReuse', true),
            controlPersistSeconds: config.get<number>('connectionIdleSeconds', 120)
        };
    }, log);
    monitor = new MonitorService(transport, () => readMonitorConfig(hosts()), log);
    const activeMonitor = monitor;
    storage = new StorageAnalyzer(transport, () => {
        const config = configuration();
        const scan = { depth: config.get<number>('storageScanDepth', 2), timeoutSeconds: config.get<number>('storageScanTimeout', 60) };
        return {
            depth: Math.max(1, Math.min(4, scan.depth)),
            timeoutSeconds: Math.max(10, Math.min(600, scan.timeoutSeconds)),
            sshTimeoutSeconds: Math.max(2, Math.min(60, config.get<number>('sshTimeout', 8)))
        };
    });
    const activeStorage = storage;
    const describeHost = (host: string): ServerDescription | undefined => {
        const snapshot = activeMonitor.getSnapshot(host);
        if (!snapshot) {
            return undefined;
        }
        const [server] = composeFleet([snapshot], readViewSettings(), serverMetadata(context));
        if (server.error) {
            const state = server.lastSuccessAt ? 'stale' : 'offline';
            return { state, description: state === 'stale' ? 'stale' : 'offline', tooltip: `${host}: ${server.error}` };
        }
        if (!server.lastSuccessAt) {
            return { state: 'pending', description: '', tooltip: `${host}: connecting…` };
        }
        const parts: string[] = [];
        if (server.gpus.length) {
            parts.push(`${server.gpus.filter(gpu => gpu.availability.available).length}/${server.gpus.length} GPU free`);
        }
        const top = server.disks?.disks.reduce<typeof server.disks.disks[number] | undefined>((worst, disk) => !worst || disk.usedPercent > worst.usedPercent ? disk : worst, undefined);
        if (top) {
            parts.push(`${top.mountPoint} ${top.usedPercent}%`);
        }
        return { state: 'online', description: parts.join(' · '), tooltip: `${host}\n${parts.join('\n')}` };
    };

    const serverProvider = new GpuServerProvider(describeHost);
    const sidebar = new SidebarViewProvider(context, activeMonitor, activeStorage);
    // A visible Servers tree also keeps data fresh, not only the Monitor view or a dashboard.
    const serversView = vscode.window.createTreeView('serverlens.servers', { treeDataProvider: serverProvider });
    const notifier = new FleetNotifier(context, activeMonitor, log);
    let treeTimer: NodeJS.Timeout | undefined;
    const refreshTree = () => {
        if (!treeTimer) {
            treeTimer = setTimeout(() => { treeTimer = undefined; serverProvider.refresh(); }, 1000);
        }
    };
    const openDashboard = (host?: string) => GpuViewPanel.createOrShow(context, activeMonitor, host);
    let configTimer: NodeJS.Timeout | undefined;
    let pendingRefresh = false;

    context.subscriptions.push(
        channel,
        sidebar,
        notifier,
        vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar),
        serversView,
        serversView.onDidChangeVisibility(event => activeMonitor.setConsumerVisible('servers', event.visible)),
        activeMonitor.onDidChangeHost(refreshTree),
        activeMonitor.onDidChangeHosts(() => serverProvider.refresh()),
        vscode.commands.registerCommand('serverlens.refresh', async () => {
            serverProvider.refresh();
            await activeMonitor.refresh();
        }),
        vscode.commands.registerCommand('serverlens.refreshServer', async (item: unknown) => {
            const host = hostFrom(item);
            if (host) {
                await activeMonitor.refresh([host]);
            }
        }),
        vscode.commands.registerCommand('serverlens.collapseAll', () => sidebar.setAllCollapsed(true)),
        vscode.commands.registerCommand('serverlens.expandAll', () => sidebar.setAllCollapsed(false)),
        vscode.commands.registerCommand('serverlens.analyzeStorage', (item: unknown) =>
            runStorageAnalysis(activeMonitor, activeStorage, host => sidebar.reveal(host), hostFrom(item))),
        vscode.commands.registerCommand('serverlens.copySshCommand', async (item: unknown) => {
            const host = hostFrom(item);
            if (host) {
                await copyToClipboard(`ssh ${host}`);
            }
        }),
        vscode.commands.registerCommand('serverlens.muteDiskAlert', async (item: unknown) => {
            const host = hostFrom(item);
            const mount = item && typeof item === 'object' && 'mount' in item ? String((item as { mount: unknown }).mount) : '';
            if (host && mount.startsWith('/')) {
                await notifier.tracker.mute([diskAlertKey(host, mount)]);
                void vscode.window.showInformationMessage(`Disk alerts muted for ${plainText(mount)} on ${host}.`);
            }
        }),
        vscode.commands.registerCommand('serverlens.resetDiskAlerts', async () => {
            const count = await notifier.tracker.reset();
            void vscode.window.showInformationMessage(`Disk alerts reset (${count} muted disk${count === 1 ? '' : 's'} restored).`);
        }),
        vscode.commands.registerCommand('serverlens.showLog', () => channel.show()),
        vscode.commands.registerCommand('serverlens.addServer', async () => {
            const target = await vscode.window.showInputBox({
                title: 'Add server',
                prompt: 'Enter an SSH config alias, IP address, hostname, or user@host',
                placeHolder: 'user@gpu-node-01',
                ignoreFocusOut: true,
                validateInput: value => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return 'Enter an SSH target.';
                    }
                    if (!isValidSshTarget(trimmed)) {
                        return 'Use only a host alias, hostname, IP address, or user@host.';
                    }
                    return undefined;
                }
            });
            if (!target) {
                return;
            }
            const config = configuration();
            const current = config.get<string[]>('additionalHosts', []);
            await config.update('additionalHosts', Array.from(new Set([...current, target.trim()])), vscode.ConfigurationTarget.Global);
            serverProvider.refresh();
            const action = await vscode.window.showInformationMessage(`Added server ${target.trim()}.`, 'Open Dashboard');
            if (action === 'Open Dashboard') {
                openDashboard();
            }
        }),
        vscode.commands.registerCommand('serverlens.openServer', (item: unknown) => {
            const host = hostFrom(item);
            if (host) {
                openDashboard(host);
            }
        }),
        vscode.commands.registerCommand('serverlens.openDashboard', () => openDashboard()),
        vscode.commands.registerCommand('serverlens.findAvailableGpu', () => showAvailableGpuQuickPick(context, activeMonitor)),
        vscode.commands.registerCommand('serverlens.openSettings', () => {
            void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ziyisun85-ops.serverlens');
        }),
        vscode.commands.registerCommand('serverlens.connectSsh', (item: unknown) => {
            const host = hostFrom(item);
            if (host) {
                void vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${host}` });
            }
        }),
        vscode.commands.registerCommand('serverlens.configureServers', async () => {
            const config = configuration();
            const configPath = config.get<string>('sshConfigPath') || '~/.ssh/config';
            const targets = config.get<string[]>('targets') || [];
            const additionalHosts = config.get<string[]>('additionalHosts') || [];
            const ignored = config.get<string[]>('ignoredHosts') || [];
            const allHosts = new SshConfigParser().parse(configPath);
            const configuredHosts = targets.length ? targets : allHosts.map(host => host.host);
            const candidates = Array.from(new Set([...configuredHosts, ...additionalHosts]));
            const items: vscode.QuickPickItem[] = candidates.map(host => ({ label: host, picked: !ignored.includes(host) }));
            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: 'Select servers to show',
                title: 'Visible servers'
            });
            if (selected) {
                const selectedHosts = new Set(selected.map(item => item.label));
                await config.update('ignoredHosts', candidates.filter(host => !selectedHosts.has(host)), vscode.ConfigurationTarget.Global);
                serverProvider.refresh();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('serverlens')) {
                return;
            }
            pendingRefresh = pendingRefresh || DATA_KEYS.some(key => event.affectsConfiguration(`serverlens.${key}`));
            if (event.affectsConfiguration('serverlens.showStatusBar')) {
                notifier.updateVisibility();
            }
            // Saving several settings at once fires one event per key; react once.
            if (configTimer) {
                clearTimeout(configTimer);
            }
            configTimer = setTimeout(() => {
                configTimer = undefined;
                hostCache = undefined;
                activeMonitor.reconfigure();
                if (pendingRefresh) {
                    pendingRefresh = false;
                    void activeMonitor.refresh();
                }
                serverProvider.refresh();
                sidebar.refreshAll();
                notifier.scheduleStatus();
            }, 300);
        }),
        {
            dispose: () => {
                if (configTimer) {
                    clearTimeout(configTimer);
                }
                if (treeTimer) {
                    clearTimeout(treeTimer);
                }
            }
        }
    );
    activeMonitor.setConsumerVisible('servers', serversView.visible);
    // Starts background collection when it is allowed without a visible view (pauseWhenHidden off).
    activeMonitor.reconfigure();
    log.info(`ServerLens ${context.extension.packageJSON.version} activated; ${hosts().length} server(s) configured.`);
    if (process.env.SERVERLENS_TEST === '1') {
        return {
            hosts: () => activeMonitor.hosts(),
            snapshot: host => activeMonitor.getSnapshot(host),
            sidebarReadyCount: () => sidebar.readyCount,
            dashboardReadyCount: () => GpuViewPanel.readyCount
        };
    }
    return undefined;

}

export async function deactivate(): Promise<void> {
    monitor?.dispose();
    storage?.dispose();
    GpuViewPanel.disposeAll();
    await transport?.dispose();
    monitor = undefined;
    storage = undefined;
    transport = undefined;
}
