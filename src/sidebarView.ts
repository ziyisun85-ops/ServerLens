// ServerLens: the sidebar "Monitor" view with one card per server.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import * as vscode from 'vscode';
import { composeFleet, ServerStatus } from './fleetModel';
import { MonitorService } from './monitorService';
import { StorageAnalyzer, StorageResult } from './storageAnalyzer';
import { getSidebarHtml } from './sidebarTemplate';
import { configuration, readViewSettings, uiLanguage } from './settings';
import { copyToClipboard, isValidGpuId, openGpuTerminal, serverMetadata } from './serverActions';
import { isValidSshTarget } from './sshTransport';
import { randomBytes } from 'crypto';

const COLLAPSED_KEY = 'serverlens.collapsedHosts';
/** With more servers than this, cards start collapsed until the user expands them. */
const EXPANDED_BY_DEFAULT_LIMIT = 6;

type CardModel = ServerStatus & { storage?: StorageResult; refreshing?: boolean };

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = 'serverlens.monitor';
    /** How often the webview script reported "ready" (it posts that as its last statement). */
    readyCount = 0;
    private view: vscode.WebviewView | undefined;
    private readonly posted = new Map<string, string>();
    private readonly disposables: vscode.Disposable[] = [];
    private viewDisposables: vscode.Disposable[] = [];
    private timer: NodeJS.Timeout | undefined;
    private fullPending = false;
    private lastActivityKey = '';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly monitor: MonitorService,
        private readonly storage: StorageAnalyzer
    ) {
        this.disposables.push(
            monitor.onDidChangeHost(() => this.schedule()),
            monitor.onDidChangeHosts(() => this.schedule(true)),
            monitor.onDidChangeActivity(() => this.postActivity()),
            storage.onDidChange(() => this.schedule())
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.viewDisposables.forEach(item => item.dispose());
        this.view = view;
        this.posted.clear();
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = getSidebarHtml(randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, ''));
        this.viewDisposables = [
            view.webview.onDidReceiveMessage(message => void this.handleMessage(message)),
            view.onDidChangeVisibility(() => {
                this.monitor.setConsumerVisible('sidebar', view.visible);
                if (view.visible) {
                    this.schedule(true);
                }
            }),
            view.onDidDispose(() => {
                this.monitor.removeConsumer('sidebar');
                this.view = undefined;
                this.posted.clear();
            })
        ];
        this.monitor.setConsumerVisible('sidebar', view.visible);
    }

    /** Re-sends everything, e.g. after a settings change that affects rendering. */
    refreshAll(): void {
        this.schedule(true);
    }

    async setAllCollapsed(collapsed: boolean): Promise<void> {
        const state: Record<string, boolean> = {};
        for (const host of this.monitor.hosts()) {
            state[host] = collapsed;
        }
        await this.context.globalState.update(COLLAPSED_KEY, state);
        await this.view?.webview.postMessage({ type: 'collapse', all: collapsed });
    }

    /** Shows the view with one server expanded and its details open (used after a storage scan). */
    async reveal(host: string): Promise<void> {
        const state = { ...this.context.globalState.get<Record<string, boolean>>(COLLAPSED_KEY, {}) };
        state[host] = false;
        await this.context.globalState.update(COLLAPSED_KEY, state);
        await vscode.commands.executeCommand(`${SidebarViewProvider.viewType}.focus`);
        this.schedule(true);
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.viewDisposables.forEach(item => item.dispose());
        this.disposables.forEach(item => item.dispose());
    }

    private collapsedHosts(hosts: string[]): string[] {
        const state = this.context.globalState.get<Record<string, boolean>>(COLLAPSED_KEY, {});
        const defaultCollapsed = hosts.length > EXPANDED_BY_DEFAULT_LIMIT;
        return hosts.filter(host => state[host] ?? defaultCollapsed);
    }

    private schedule(full = false): void {
        this.fullPending = this.fullPending || full;
        if (!this.view || this.timer) {
            return;
        }
        // Results from several hosts usually arrive together; send one message.
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const sendFull = this.fullPending;
            this.fullPending = false;
            void this.publish(sendFull);
        }, 100);
    }

    private cards(): CardModel[] {
        const settings = readViewSettings();
        // Only refreshes the user asked for show a spinner; background rounds stay quiet.
        const busy = new Set(this.monitor.manualHosts());
        return composeFleet(this.monitor.getSnapshots(), settings, serverMetadata(this.context)).map(server => ({
            ...server,
            storage: this.storage.get(server.host),
            refreshing: busy.has(server.host)
        }));
    }

    private async publish(full: boolean): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }
        if (full) {
            this.posted.clear();
        }
        const order = this.monitor.hosts();
        const cards = this.cards();
        // Keep the configured order but put favorites first, as the dashboard does.
        const favorites = new Set(cards.filter(card => card.metadata?.favorite).map(card => card.host));
        const sortedOrder = [...order.filter(host => favorites.has(host)), ...order.filter(host => !favorites.has(host))];
        const changed: CardModel[] = [];
        for (const card of cards) {
            const serialized = JSON.stringify(card);
            if (this.posted.get(card.host) !== serialized) {
                this.posted.set(card.host, serialized);
                changed.push(card);
            }
        }
        for (const host of Array.from(this.posted.keys())) {
            if (!order.includes(host)) {
                this.posted.delete(host);
            }
        }
        const settings = readViewSettings();
        await view.webview.postMessage({
            type: 'state',
            full,
            language: uiLanguage(),
            settings: {
                diskWarningThreshold: settings.diskWarningThreshold,
                diskCriticalThreshold: settings.diskCriticalThreshold,
                memoryWarningThreshold: settings.memoryWarningThreshold,
                temperatureWarningThreshold: settings.temperatureWarningThreshold,
                byteUnits: settings.byteUnits,
                showProcesses: settings.showProcesses
            },
            automatic: configuration().get<boolean>('autoRefresh', true),
            order: sortedOrder,
            collapsed: this.collapsedHosts(order),
            servers: changed,
            activity: this.monitor.activity()
        });
    }

    private postActivity(): void {
        // Background collection changes the activity many times per second; the view only needs to
        // know which user-requested refreshes are still running.
        const refreshing = this.monitor.manualHosts();
        const key = refreshing.join('\n');
        if (!this.view || key === this.lastActivityKey) {
            return;
        }
        this.lastActivityKey = key;
        void this.view.webview.postMessage({ type: 'activity', activity: this.monitor.activity(), refreshing });
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const payload = message as Record<string, unknown>;
        const host = isValidSshTarget(payload.host) ? payload.host : undefined;
        switch (payload.command) {
            case 'ready':
                this.readyCount += 1;
                this.lastActivityKey = '';
                this.posted.clear();
                await this.publish(true);
                break;
            case 'setCollapsed':
                if (host) {
                    const state = { ...this.context.globalState.get<Record<string, boolean>>(COLLAPSED_KEY, {}) };
                    state[host] = Boolean(payload.collapsed);
                    await this.context.globalState.update(COLLAPSED_KEY, state);
                }
                break;
            case 'refresh':
                await this.monitor.refresh(host ? [host] : undefined);
                break;
            case 'analyzeStorage':
                if (host) await vscode.commands.executeCommand('serverlens.analyzeStorage', host);
                break;
            case 'cancelStorage':
                if (host) this.storage.cancel(host);
                break;
            case 'clearStorage':
                if (host) this.storage.clear(host);
                break;
            case 'openTerminal':
                if (host && isValidGpuId(payload.uuid)) openGpuTerminal(host, payload.uuid);
                break;
            case 'copy':
                if (host && payload.kind === 'cuda' && isValidGpuId(payload.uuid)) {
                    await copyToClipboard(`export CUDA_DEVICE_ORDER=PCI_BUS_ID\nexport CUDA_VISIBLE_DEVICES=${payload.uuid}`);
                } else if (host && payload.kind === 'ssh') {
                    await copyToClipboard(`ssh ${host}`);
                }
                break;
            case 'connect':
                if (host) await vscode.commands.executeCommand('serverlens.connectSsh', host);
                break;
            case 'addServer':
                await vscode.commands.executeCommand('serverlens.addServer');
                break;
            case 'configureServers':
                await vscode.commands.executeCommand('serverlens.configureServers');
                break;
        }
    }
}
