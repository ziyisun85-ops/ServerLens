// ServerLens: status bar summary and notifications (disk capacity, GPU transitions).
// The status bar and GPU notifications come from GPU Fleet Viewer and now work without the dashboard open.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import * as vscode from 'vscode';
import { DiskAlert, DiskAlertTracker, GpuTransitionTracker } from './alerts';
import { composeFleet, ServerStatus, summarizeFleet, visibleFleet } from './fleetModel';
import { MonitorService } from './monitorService';
import { configuration, diskAlertSettings, readViewSettings } from './settings';
import { serverMetadata } from './serverActions';
import { formatBytes } from './format';
import { Logger } from './log';

const SNOOZE_MS = 24 * 60 * 60 * 1000;

export class FleetNotifier implements vscode.Disposable {
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private readonly diskTracker: DiskAlertTracker;
    private readonly gpuTracker = new GpuTransitionTracker();
    private readonly pendingDiskAlerts: DiskAlert[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private statusTimer: NodeJS.Timeout | undefined;
    private alertTimer: NodeJS.Timeout | undefined;

    constructor(private readonly context: vscode.ExtensionContext, private readonly monitor: MonitorService, private readonly log: Logger) {
        this.diskTracker = new DiskAlertTracker(context.globalState);
        this.statusBar.name = 'ServerLens';
        this.statusBar.command = 'serverlens.monitor.focus';
        this.statusBar.text = '$(server) ServerLens';
        this.disposables.push(this.statusBar, monitor.onDidChangeHost(host => void this.onHost(host)));
        this.updateVisibility();
    }

    get tracker(): DiskAlertTracker {
        return this.diskTracker;
    }

    updateVisibility(): void {
        if (configuration().get<boolean>('showStatusBar', true)) {
            this.statusBar.show();
        } else {
            this.statusBar.hide();
        }
    }

    private composed(): ServerStatus[] {
        return composeFleet(this.monitor.getSnapshots(), readViewSettings(), serverMetadata(this.context));
    }

    private async onHost(host: string): Promise<void> {
        this.scheduleStatus();
        const server = this.composed().find(item => item.host === host);
        if (!server) {
            return;
        }
        const config = configuration();
        const disk = diskAlertSettings(config);
        try {
            const alerts = await this.diskTracker.evaluate(server, disk.level, disk.warning, disk.critical);
            if (alerts.length) {
                this.pendingDiskAlerts.push(...alerts);
                this.scheduleDiskNotification();
            }
        } catch (error) {
            this.log.warn(`Disk alert evaluation failed: ${(error as Error).message}`);
        }
        const settings = readViewSettings(config);
        const messages = this.gpuTracker.evaluate(server, {
            enabled: config.get<boolean>('enableNotifications', false),
            events: new Set(config.get<string[]>('notificationEvents', ['serverState', 'gpuAvailable', 'threshold'])),
            cooldownMs: Math.max(0, config.get<number>('notificationCooldownSeconds', 60)) * 1000,
            memoryWarningThreshold: settings.memoryWarningThreshold,
            temperatureWarningThreshold: settings.temperatureWarningThreshold,
            powerWarningThreshold: settings.powerWarningThreshold
        });
        if (messages.length) {
            void vscode.window.showWarningMessage(`ServerLens — ${messages.slice(0, 4).join(' · ')}`);
        }
    }

    private scheduleDiskNotification(): void {
        if (this.alertTimer) {
            return;
        }
        // Collect alerts from hosts that finish around the same time into one notification.
        this.alertTimer = setTimeout(() => {
            this.alertTimer = undefined;
            const alerts = this.pendingDiskAlerts.splice(0);
            if (alerts.length) {
                void this.showDiskNotification(alerts);
            }
        }, 1500);
    }

    private async showDiskNotification(alerts: DiskAlert[]): Promise<void> {
        const units = readViewSettings().byteUnits;
        const describe = (alert: DiskAlert) => `${alert.label} ${alert.mountPoint} ${alert.usedPercent}% (${formatBytes(alert.availKiB * 1024, units)} free)`;
        const critical = alerts.some(alert => alert.level === 'critical');
        const text = alerts.length === 1
            ? `ServerLens: ${describe(alerts[0])} is ${critical ? 'almost full' : 'filling up'}.`
            : `ServerLens: ${alerts.length} disks are ${critical ? 'almost full' : 'filling up'}: ${alerts.slice(0, 3).map(describe).join('; ')}${alerts.length > 3 ? '; …' : ''}`;
        const show = critical ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const choice = await show(text, 'Show', 'Snooze 24 h', alerts.length === 1 ? 'Mute this disk' : 'Mute these disks');
        if (choice === 'Show') {
            await vscode.commands.executeCommand('serverlens.monitor.focus');
        } else if (choice === 'Snooze 24 h') {
            await this.diskTracker.snooze(alerts.map(alert => alert.key), SNOOZE_MS);
        } else if (choice?.startsWith('Mute')) {
            await this.diskTracker.mute(alerts.map(alert => alert.key));
            void vscode.window.showInformationMessage('Muted. Run "ServerLens: Reset Disk Alerts" to undo.');
        }
    }

    scheduleStatus(): void {
        if (this.statusTimer) {
            return;
        }
        this.statusTimer = setTimeout(() => {
            this.statusTimer = undefined;
            this.updateStatus();
        }, 500);
    }

    private updateStatus(): void {
        const settings = readViewSettings();
        const data = visibleFleet(this.composed().filter(server => server.lastSuccessAt || server.error), configuration().get<Record<string, string[]>>('visibleGpus', {}));
        const summary = summarizeFleet(data, settings);
        const fullDisks = data.filter(server => !server.error).flatMap(server => (server.disks?.disks || [])
            .filter(disk => disk.usedPercent >= settings.diskCriticalThreshold).map(disk => `${server.metadata?.alias || server.host} ${disk.mountPoint} ${disk.usedPercent}%`));
        const gpuText = summary.gpusTotal ? `GPU ${summary.gpusAvailable}/${summary.gpusTotal} free` : `${summary.serversOnline}/${summary.serversTotal} online`;
        this.statusBar.text = `$(server) ${gpuText}${fullDisks.length ? ` $(warning) ${fullDisks.length}` : ''}`;
        const tooltip = new vscode.MarkdownString(
            `**ServerLens**  \n${summary.serversOnline}/${summary.serversTotal} servers online  \n` +
            (summary.gpusTotal ? `${summary.gpusAvailable}/${summary.gpusTotal} GPUs available · ${summary.memoryPercent}% GPU memory used  \n` : '') +
            (fullDisks.length ? `Disks ≥ ${settings.diskCriticalThreshold}%: ${fullDisks.slice(0, 5).join(', ')}${fullDisks.length > 5 ? ', …' : ''}` : 'No disk above the critical threshold')
        );
        this.statusBar.tooltip = tooltip;
    }

    dispose(): void {
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
        }
        if (this.alertTimer) {
            clearTimeout(this.alertTimer);
        }
        this.disposables.forEach(item => item.dispose());
    }
}
