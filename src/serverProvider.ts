// Servers tree view: Dashboard entry plus one item per SSH host.
// Modified for ServerLens (2026): items show live status (online, free GPUs, fullest disk).
import * as vscode from 'vscode';
import { SshConfigParser, SshHost } from './sshConfig';

export interface ServerDescription {
    state: 'online' | 'stale' | 'offline' | 'pending';
    description: string;
    tooltip: string;
}

export class GpuServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private readonly describe?: (host: string) => ServerDescription | undefined) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const items: vscode.TreeItem[] = [];

        // Add Dashboard item
        const dashboardItem = new vscode.TreeItem('Dashboard', vscode.TreeItemCollapsibleState.None);
        dashboardItem.iconPath = new vscode.ThemeIcon('dashboard');
        dashboardItem.command = {
            command: 'serverlens.openDashboard',
            title: 'Open Dashboard'
        };
        dashboardItem.contextValue = 'dashboard';
        items.push(dashboardItem);

        const displayHosts = GpuServerProvider.getHosts();
        const serverItems = displayHosts.map(h => new ServerTreeItem(h.host, vscode.TreeItemCollapsibleState.None, this.describe?.(h.host)));

        return Promise.resolve([...items, ...serverItems]);
    }

    public static getHosts(): SshHost[] {
        const config = vscode.workspace.getConfiguration('serverlens');
        const configured = config.get<unknown>('sshConfigPath');
        const configPath = typeof configured === 'string' && configured.trim() ? configured.trim() : '~/.ssh/config';
        // Hand-edited settings may hold a string or other non-array value; ignore anything that is not a host list.
        const list = (key: string) => {
            const value = config.get<unknown>(key);
            return Array.isArray(value) ? value.filter((host): host is string => typeof host === 'string' && host.trim() !== '').map(host => host.trim()) : [];
        };
        const targets = list('targets');
        const additionalHosts = list('additionalHosts');
        const ignoredHosts = list('ignoredHosts');

        let allHosts: SshHost[] = [];
        try {
            allHosts = new SshConfigParser().parse(configPath);
        } catch {
            // An unreadable SSH config (permissions, a directory) leaves only the explicitly listed hosts.
        }

        const knownHosts = new Map(allHosts.map(host => [host.host, host]));
        let displayHosts = allHosts;
        if (targets.length > 0) {
            displayHosts = targets.map(host => knownHosts.get(host) || { host });
        }

        displayHosts = [
            ...displayHosts,
            ...additionalHosts.map(host => knownHosts.get(host) || { host })
        ];

        if (ignoredHosts.length > 0) {
            displayHosts = displayHosts.filter(h => !ignoredHosts.includes(h.host));
        }

        return Array.from(new Map(displayHosts.map(host => [host.host, host])).values());
    }
}

const STATE_COLORS: Record<ServerDescription['state'], string | undefined> = {
    online: 'testing.iconPassed',
    stale: 'editorWarning.foreground',
    offline: 'errorForeground',
    pending: undefined
};

export class ServerTreeItem extends vscode.TreeItem {
    constructor(
        public readonly host: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        status?: ServerDescription
    ) {
        super(host, collapsibleState);
        this.tooltip = status?.tooltip || `SSH Host: ${host}`;
        this.description = status?.description || '';
        this.contextValue = 'server';

        this.command = {
            command: 'serverlens.openServer',
            title: 'Open GPU View',
            arguments: [this.host]
        };

        const color = status ? STATE_COLORS[status.state] : undefined;
        this.iconPath = new vscode.ThemeIcon('server', color ? new vscode.ThemeColor(color) : undefined);
    }
}
