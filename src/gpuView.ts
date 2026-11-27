// Dashboard panel (editor tab) showing the whole fleet or one server.
// Modified for ServerLens (2026): data now comes from the shared MonitorService instead of a
// per-panel polling loop; per-server actions moved to serverActions.ts; AI assistant removed.
import * as vscode from 'vscode';
import { GpuServerProvider } from './serverProvider';
import { aggregateUsers, composeFleet, numberValue, ServerStatus, summarizeFleet, visibleFleet } from './fleetModel';
import { getDashboardCss, getDashboardScript, getDashboardTranslation } from './webviewTemplate';
import { preferenceFields, validatePreferenceChanges } from './preferences';
import { getPreferencesHtml } from './preferencesView';
import { MonitorService } from './monitorService';
import { configuration, readViewSettings, uiLanguage } from './settings';
import {
    copyToClipboard, editServerMetadata, isValidGpuId, isValidPid, openGpuTerminal, serverMetadata, toggleFavorite
} from './serverActions';
import { isValidSshTarget } from './sshTransport';

export { GpuStatusSummary } from './fleetModel';

let panelCounter = 0;

/** Builds the decorated, visibility-filtered fleet the dashboard and quick pick work with. */
export function currentFleet(context: vscode.ExtensionContext, monitor: MonitorService, host?: string): ServerStatus[] {
    const settings = readViewSettings();
    const snapshots = monitor.getSnapshots().filter(snapshot => !host || snapshot.host === host);
    return composeFleet(snapshots, settings, serverMetadata(context));
}

export async function showAvailableGpuQuickPick(context: vscode.ExtensionContext, monitor: MonitorService): Promise<void> {
    const data = currentFleet(context, monitor);
    if (!data.some(server => server.lastSuccessAt)) {
        await vscode.window.showInformationMessage('ServerLens has no GPU data yet. Open the ServerLens view and wait for the first refresh.');
        return;
    }
    const candidates = visibleFleet(data, configuration().get<Record<string, string[]>>('visibleGpus', {}))
        .filter(server => !server.error && !server.stale && !server.duplicateOf)
        .flatMap(server => server.gpus.filter(gpu => gpu.availability.available).map(gpu => ({ server, gpu })))
        .sort((left, right) => numberValue(right.gpu.memory.free) - numberValue(left.gpu.memory.free));
    if (!candidates.length) {
        await vscode.window.showInformationMessage('No GPU currently matches your availability rules.');
        return;
    }
    const selected = await vscode.window.showQuickPick(candidates.map(item => ({
        label: `$(server) ${item.server.metadata?.alias || item.server.host} · GPU ${item.gpu.index}`,
        description: item.gpu.name,
        detail: `${item.gpu.memory.free} free · ${item.gpu.utilization.gpu} utilization`,
        item
    })), {
        title: 'Find an available GPU',
        placeHolder: 'Choose a GPU to prepare an SSH research terminal'
    });
    if (selected) {
        openGpuTerminal(selected.item.server.host, selected.item.gpu.uuid);
    }
}

export class GpuViewPanel {
    private static readonly panels = new Set<GpuViewPanel>();
    /** How often a dashboard script reported "ready" (it posts that as its last statement). */
    static readyCount = 0;
    private readonly panel: vscode.WebviewPanel;
    private readonly host: string | undefined;
    private readonly context: vscode.ExtensionContext;
    private readonly monitor: MonitorService;
    private readonly consumerId: string;
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;
    private lastData: ServerStatus[] = [];
    private publishTimer: NodeJS.Timeout | undefined;

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, monitor: MonitorService, host?: string) {
        this.panel = panel;
        this.context = context;
        this.monitor = monitor;
        this.host = host;
        this.consumerId = `dashboard:${++panelCounter}`;
        GpuViewPanel.panels.add(this);
        this.panel.webview.html = this.getWebviewContent();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.onDidChangeViewState(event => {
            this.monitor.setConsumerVisible(this.consumerId, event.webviewPanel.visible);
            if (event.webviewPanel.visible) {
                void this.publishCurrent();
            }
        }, null, this.disposables);
        this.panel.webview.onDidReceiveMessage(message => void this.handleMessage(message), null, this.disposables);
        this.disposables.push(
            this.monitor.onDidChangeHost(changed => {
                if (!this.host || changed === this.host) {
                    this.schedulePublish();
                }
            }),
            this.monitor.onDidChangeActivity(() => void this.postRefreshState()),
            this.monitor.onDidChangeHosts(() => this.schedulePublish()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('serverlens')) {
                    this.schedulePublish();
                }
            })
        );
        this.monitor.setConsumerVisible(this.consumerId, this.panel.visible);
    }

    public static createOrShow(context: vscode.ExtensionContext, monitor: MonitorService, host?: string): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
        const existing = Array.from(GpuViewPanel.panels).find(candidate => candidate.host === host);
        if (existing) {
            existing.panel.reveal(column);
            void existing.publishCurrent();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'serverlens.dashboard',
            host ? `GPU: ${host}` : 'ServerLens',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')]
            }
        );
        new GpuViewPanel(panel, context, monitor, host);
    }

    public static disposeAll(): void {
        for (const panel of Array.from(GpuViewPanel.panels)) {
            panel.panel.dispose();
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        GpuViewPanel.panels.delete(this);
        if (this.publishTimer) {
            clearTimeout(this.publishTimer);
        }
        this.monitor.removeConsumer(this.consumerId);
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object' || !('command' in message)) {
            return;
        }
        const payload = message as Record<string, unknown>;
        switch (payload.command) {
            case 'refresh':
                await this.postRefreshState();
                await this.monitor.refresh(this.host ? [this.host] : undefined);
                break;
            case 'ready':
                GpuViewPanel.readyCount += 1;
                await this.publishCurrent();
                break;
            case 'connect':
                if (isValidSshTarget(payload.host)) {
                    await vscode.commands.executeCommand('serverlens.connectSsh', payload.host);
                }
                break;
            case 'settings':
            case 'openNativeSettings':
                await vscode.commands.executeCommand('serverlens.openSettings');
                break;
            case 'configureServers':
                await vscode.commands.executeCommand('serverlens.configureServers');
                break;
            case 'addServer':
                await vscode.commands.executeCommand('serverlens.addServer');
                break;
            case 'savePreferences':
                await this.savePreferences(payload.values);
                break;
            case 'copyValue':
                await this.copyRequestedValue(payload);
                break;
            case 'openGpuTerminal':
                if (isValidSshTarget(payload.host) && isValidGpuId(payload.uuid)) {
                    openGpuTerminal(payload.host, payload.uuid);
                }
                break;
            case 'toggleFavorite':
                if (isValidSshTarget(payload.host)) {
                    await toggleFavorite(this.context, payload.host);
                    await this.publishCurrent();
                }
                break;
            case 'editServer':
                if (isValidSshTarget(payload.host) && await editServerMetadata(this.context, payload.host)) {
                    await this.publishCurrent();
                }
                break;
        }
    }

    private async savePreferences(input: unknown): Promise<void> {
        try {
            const changes = validatePreferenceChanges(input);
            const config = configuration();
            const entries = Object.entries(changes).filter(([key, value]) => JSON.stringify(config.get(key)) !== JSON.stringify(value));
            for (const [key, value] of entries) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
            }
            await this.panel.webview.postMessage({ type: 'preferencesResult', success: true, values: changes });
            await this.publishCurrent();
        } catch (error) {
            await this.panel.webview.postMessage({ type: 'preferencesResult', success: false, error: (error as Error).message });
        }
    }

    private schedulePublish(): void {
        if (this.disposed || this.publishTimer) {
            return;
        }
        // Several hosts usually finish within a few milliseconds of each other; publish once.
        this.publishTimer = setTimeout(() => {
            this.publishTimer = undefined;
            void this.publishCurrent();
        }, 120);
    }

    private refreshPayload() {
        const activity = this.monitor.activity();
        const config = configuration();
        const total = this.host ? 1 : activity.total;
        const pending = this.host ? Number(activity.running + activity.queued > 0) : activity.running + activity.queued;
        return {
            active: pending > 0,
            completed: Math.max(0, total - pending),
            total,
            automatic: config.get<boolean>('autoRefresh', true),
            intervalSeconds: Math.max(2, config.get<number>('refreshInterval', 5))
        };
    }

    private async postRefreshState(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const refresh = this.refreshPayload();
        await this.panel.webview.postMessage({
            type: 'refreshState',
            state: refresh.active ? 'refreshing' : 'idle',
            completed: refresh.completed,
            total: refresh.total,
            language: uiLanguage()
        });
    }

    private async publishCurrent(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const language = uiLanguage();
        const config = configuration();
        const settings = readViewSettings(config);
        const hosts = this.host ? [this.host] : GpuServerProvider.getHosts().map(item => item.host);
        this.lastData = currentFleet(this.context, this.monitor, this.host)
            .filter(server => hosts.includes(server.host) && (server.lastSuccessAt || server.error));
        const visible = visibleFleet(this.lastData, config.get<Record<string, string[]>>('visibleGpus', {}));
        const summary = summarizeFleet(visible, settings);
        this.panel.title = this.host ? `GPU: ${this.host}` : getDashboardTranslation(language, 'panelTitle');
        await this.panel.webview.postMessage({
            type: 'update',
            title: this.host ? `GPU: ${this.host}` : getDashboardTranslation(language, 'dashboardTitle'),
            language,
            data: visible,
            gpuCatalog: this.lastData.map(server => ({ host: server.host, label: server.metadata?.alias || server.host, gpus: server.gpus.map(g => ({ index: g.index, uuid: g.uuid, name: g.name })) })),
            users: settings.showProcesses ? aggregateUsers(visible) : [],
            settings,
            preferences: Object.fromEntries(preferenceFields.map(field => [field.key, config.get(field.key, field.default)])),
            summary,
            refresh: this.refreshPayload()
        });
    }

    private async copyRequestedValue(payload: Record<string, unknown>): Promise<void> {
        const host = payload.host;
        if (!isValidSshTarget(host)) {
            return;
        }
        const server = this.lastData.find(item => item.host === host);
        const gpu = server?.gpus.find(item => item.uuid === payload.uuid);
        const process = gpu?.processes.find(item => item.pid === payload.pid);
        let value = '';
        switch (payload.kind) {
            case 'ssh': value = `ssh ${host}`; break;
            // Values come from the server and may be pasted into a shell: copy only well-formed ones.
            case 'cuda':
                if (gpu && isValidGpuId(gpu.uuid)) value = `export CUDA_DEVICE_ORDER=PCI_BUS_ID\nexport CUDA_VISIBLE_DEVICES=${gpu.uuid}`;
                break;
            case 'pid': if (process && isValidPid(process.pid)) value = process.pid; break;
            case 'command': if (process) value = process.command; break;
        }
        await copyToClipboard(value);
    }

    private getWebviewContent(): string {
        const nonce = this.getNonce();
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <title>ServerLens</title>
            <style>${getDashboardCss()}</style>
        </head>
        <body>
            <header class="toolbar">
                <div class="product-heading"><h1 id="page-title"></h1><div class="product-meta"><span id="refresh-state" class="subtle"></span><button id="refresh-mode" class="meta-button" type="button"></button></div></div>
                <div class="toolbar-actions">
                    <button id="settings-button" class="secondary-button"></button>
                    <button id="refresh-button"></button>
                </div>
            </header>
            <section id="summary" class="summary-strip" aria-label="GPU summary"></section>
            <section class="fleet-filter-panel" aria-label="Fleet filters"><div class="fleet-controls">
                <input id="search-input" type="search" placeholder="Search servers, GPUs, users, commands, or Slurm jobs">
                <select id="status-filter" aria-label="Status filter">
                    <option value="all"></option><option value="available"></option>
                    <option value="busy"></option><option value="warning"></option><option value="offline"></option>
                </select>
                <select id="sort-select" aria-label="Sort GPUs">
                    <option value="configured"></option><option value="freeMemory"></option>
                    <option value="utilization"></option><option value="temperature"></option>
                </select>
            </div><div class="filter-secondary"><div class="resource-controls" aria-label="Resource requirements">
                <label><span id="min-memory-label"></span><input id="min-memory" type="number" min="0" max="1048576" step="1" value="0"><span>GiB</span></label>
                <label><span id="min-gpus-label"></span><input id="min-gpus" type="number" min="1" max="1024" step="1" value="1"></label>
            </div><div id="user-filters" class="user-filters" aria-label="Active users"></div>
            <div class="filter-actions"><span id="filter-results" class="subtle"></span><button id="my-tasks-button" class="secondary-button" type="button"></button><button id="reset-filters-button" class="text-button" type="button" hidden></button></div></div></section>
            <div id="dashboard-layout" class="dashboard-layout">
                <main id="content"><div class="empty-state"></div></main>
                <aside id="gpu-details" class="gpu-details" aria-labelledby="gpu-details-title" hidden></aside>
            </div>
            ${getPreferencesHtml()}
            <script nonce="${nonce}">${getDashboardScript()}</script>
        </body>
        </html>`;
    }

    private getNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let text = '';
        for (let index = 0; index < 32; index += 1) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
