import * as vscode from 'vscode';
import { GpuServerProvider } from './serverProvider';
import { GpuStatusSummary, GpuViewPanel } from './gpuView';
import { SshConfigParser } from './sshConfig';

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await migrateLegacySettings(context);
    const serverProvider = new GpuServerProvider();
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'serverlens.openDashboard';
    statusBar.name = 'ServerLens';
    statusBar.text = '$(dashboard) ServerLens';
    statusBar.tooltip = 'Open GPU Dashboard';

    const updateStatusBarVisibility = () => {
        const visible = vscode.workspace
            .getConfiguration('serverlens')
            .get<boolean>('showStatusBar', true);
        if (visible) {
            statusBar.show();
        } else {
            statusBar.hide();
        }
    };

    const updateStatusBar = (summary: GpuStatusSummary) => {
        statusBar.text = `$(dashboard) GPU ${summary.gpusAvailable}/${summary.gpusTotal} free`;
        statusBar.tooltip = new vscode.MarkdownString(
            `**ServerLens**  \n` +
            `${summary.serversOnline}/${summary.serversTotal} servers online  \n` +
            `${summary.gpusAvailable}/${summary.gpusTotal} GPUs available  \n` +
            `${summary.memoryPercent}% aggregate memory used`
        );
    };

    const openDashboard = (host?: string) => {
        GpuViewPanel.createOrShow(context, host, host ? undefined : updateStatusBar);
    };

    context.subscriptions.push(
        statusBar,
        vscode.window.registerTreeDataProvider('serverlens.servers', serverProvider),
        vscode.commands.registerCommand('serverlens.refresh', () => {
            serverProvider.refresh();
            GpuViewPanel.refreshAll();
        }),
        vscode.commands.registerCommand('serverlens.addServer', async () => {
            const target = await vscode.window.showInputBox({
                title: 'Add GPU server',
                prompt: 'Enter an SSH config alias, IP address, hostname, or user@host',
                placeHolder: 'user@gpu-node-01',
                ignoreFocusOut: true,
                validateInput: value => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return 'Enter an SSH target.';
                    }
                    if (trimmed.startsWith('-') || !/^[A-Za-z0-9_.:@-]+$/.test(trimmed)) {
                        return 'Use only a host alias, hostname, IP address, or user@host.';
                    }
                    return undefined;
                }
            });

            if (!target) {
                return;
            }

            const config = vscode.workspace.getConfiguration('serverlens');
            const current = config.get<string[]>('additionalHosts', []);
            const updated = Array.from(new Set([...current, target.trim()]));
            await config.update('additionalHosts', updated, vscode.ConfigurationTarget.Global);
            serverProvider.refresh();

            const action = await vscode.window.showInformationMessage(
                `Added GPU server ${target.trim()}.`,
                'Open Dashboard'
            );
            if (action === 'Open Dashboard') {
                openDashboard();
            }
        }),
        vscode.commands.registerCommand('serverlens.openServer', (host: string) => openDashboard(host)),
        vscode.commands.registerCommand('serverlens.openDashboard', () => openDashboard()),
        vscode.commands.registerCommand('serverlens.findAvailableGpu', () => {
            void GpuViewPanel.showAvailableGpuQuickPick();
        }),
        vscode.commands.registerCommand('serverlens.openSettings', () => {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:ziyisun85-ops.serverlens'
            );
        }),
        vscode.commands.registerCommand('serverlens.connectSsh', (item: unknown) => {
            let host = '';
            if (typeof item === 'string') {
                host = item;
            } else if (item && typeof item === 'object' && 'host' in item) {
                host = String((item as { host: unknown }).host);
            }

            if (host) {
                void vscode.commands.executeCommand('vscode.newWindow', {
                    remoteAuthority: `ssh-remote+${host}`
                });
            }
        }),
        vscode.commands.registerCommand('serverlens.configureServers', async () => {
            const config = vscode.workspace.getConfiguration('serverlens');
            const configPath = config.get<string>('sshConfigPath') || '~/.ssh/config';
            const targets = config.get<string[]>('targets') || [];
            const additionalHosts = config.get<string[]>('additionalHosts') || [];
            const ignored = config.get<string[]>('ignoredHosts') || [];

            const allHosts = new SshConfigParser().parse(configPath);
            const configuredHosts = targets.length
                ? targets
                : allHosts.map(host => host.host);
            const candidates = Array.from(new Set([...configuredHosts, ...additionalHosts]));
            const items: vscode.QuickPickItem[] = candidates.map(host => ({
                label: host,
                picked: !ignored.includes(host)
            }));

            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: 'Select servers to show',
                title: 'Visible GPU servers'
            });

            if (selected) {
                const selectedHosts = new Set(selected.map(item => item.label));
                const newIgnored = candidates.filter(host => !selectedHosts.has(host));
                await config.update('ignoredHosts', newIgnored, vscode.ConfigurationTarget.Global);
                serverProvider.refresh();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('serverlens.showStatusBar')) {
                updateStatusBarVisibility();
            }
            if (event.affectsConfiguration('serverlens.targets') ||
                event.affectsConfiguration('serverlens.additionalHosts') ||
                event.affectsConfiguration('serverlens.ignoredHosts') ||
                event.affectsConfiguration('serverlens.sshConfigPath')) {
                serverProvider.refresh();
            }
        })
    );

    updateStatusBarVisibility();
}

export function deactivate(): void {}
