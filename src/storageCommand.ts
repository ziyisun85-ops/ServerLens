// ServerLens: the "Analyze Storage" command (choose server and folders, run with progress).
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import * as vscode from 'vscode';
import { parseStoragePathSetting, StorageAnalyzer, StorageTarget, STORAGE_PRESETS } from './storageAnalyzer';
import { MonitorService } from './monitorService';
import { validateRemotePath } from './remoteScript';
import { storageSettings } from './settings';
import { formatBytes } from './format';
import { plainText } from './log';

interface TargetItem extends vscode.QuickPickItem {
    target?: StorageTarget;
    custom?: boolean;
}

async function pickHost(monitor: MonitorService): Promise<string | undefined> {
    const items = monitor.getSnapshots().map(snapshot => ({
        label: snapshot.host,
        description: snapshot.error ? snapshot.errorCategory || 'offline' : snapshot.lastSuccessAt ? '' : 'not connected yet'
    }));
    if (!items.length) {
        void vscode.window.showInformationMessage('No servers are configured.');
        return undefined;
    }
    return (await vscode.window.showQuickPick(items, { title: 'Analyze storage: choose a server' }))?.label;
}

async function pickTarget(host: string): Promise<StorageTarget | undefined> {
    const settings = storageSettings();
    const configured = parseStoragePathSetting(settings.paths);
    const items: TargetItem[] = [
        ...STORAGE_PRESETS.map(target => ({ label: target.label, description: target.paths.join('  '), target })),
        ...(configured.length ? [{ label: 'Configured folders', kind: vscode.QuickPickItemKind.Separator } as TargetItem] : []),
        ...configured.map(target => ({ label: target.label, description: target.paths.join('  '), target })),
        { label: 'Custom path…', description: 'Projects, datasets, checkpoints, logs…', custom: true }
    ];
    const choice = await vscode.window.showQuickPick(items, {
        title: `Analyze storage on ${host}`,
        placeHolder: 'Choose what to measure. The scan is read-only, low priority and time-limited.'
    });
    if (!choice) {
        return undefined;
    }
    if (!choice.custom) {
        return choice.target;
    }
    const path = await vscode.window.showInputBox({
        title: `Analyze storage on ${host}`,
        prompt: 'Absolute path or a path under your home directory',
        placeHolder: '~/projects or /data/<user>/checkpoints',
        ignoreFocusOut: true,
        validateInput: value => {
            try {
                validateRemotePath(value);
                return undefined;
            } catch (error) {
                return (error as Error).message;
            }
        }
    });
    return path ? { label: validateRemotePath(path), paths: [validateRemotePath(path)] } : undefined;
}

/** Interactive flow behind serverlens.analyzeStorage. Results appear in the server's card. */
export async function runStorageAnalysis(
    monitor: MonitorService,
    analyzer: StorageAnalyzer,
    revealHost: (host: string) => Promise<void>,
    requestedHost?: string
): Promise<void> {
    const host = requestedHost || await pickHost(monitor);
    if (!host) {
        return;
    }
    if (analyzer.isRunning(host)) {
        void vscode.window.showInformationMessage(`A storage scan is already running on ${host}.`);
        return;
    }
    const target = await pickTarget(host);
    if (!target) {
        return;
    }
    await revealHost(host);
    const settings = storageSettings();
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `ServerLens: measuring ${target.label} on ${host}`,
        cancellable: true
    }, async (progress, token) => {
        progress.report({ message: `depth ${target.depth || settings.depth}, up to ${settings.timeoutSeconds} s` });
        const cancel = token.onCancellationRequested(() => analyzer.cancel(host));
        try {
            return await analyzer.analyze(host, target);
        } finally {
            cancel.dispose();
        }
    });
    if (result.state === 'error') {
        void vscode.window.showWarningMessage(`Storage scan on ${host} failed: ${plainText(result.error || 'unknown error')}`);
    } else if (result.state === 'done') {
        const top = result.entries[0];
        // Status bar text expands $(icon) syntax; remote folder names must not inject icons.
        const largest = top ? `, largest ${top.path.replace(/\$\(/g, '$\u200b(')}` : '';
        void vscode.window.setStatusBarMessage(`$(folder) ${target.label} on ${host}: ${formatBytes(result.totalKiB * 1024)}${largest}`, 8000);
    }
}
