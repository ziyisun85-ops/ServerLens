// ServerLens: per-server actions shared by the dashboard and the sidebar (moved out of gpuView.ts).
// Based on GPU Fleet Viewer's dashboard actions; modified for ServerLens (2026).
import * as os from 'os';
import * as vscode from 'vscode';
import { ServerMetadata } from './fleetModel';
import { sshConfigArguments } from './sshConfig';
import { isValidSshTarget } from './sshTransport';
import { configuration } from './settings';

export const METADATA_KEY = 'serverlens.serverMetadata';

export function isValidGpuId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value);
}

export function isValidPid(value: unknown): value is string {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value);
}

export function serverMetadata(context: vscode.ExtensionContext): Record<string, ServerMetadata> {
    return context.globalState.get<Record<string, ServerMetadata>>(METADATA_KEY, {});
}

export async function toggleFavorite(context: vscode.ExtensionContext, host: string): Promise<void> {
    const metadata = { ...serverMetadata(context) };
    metadata[host] = { ...metadata[host], favorite: !metadata[host]?.favorite };
    await context.globalState.update(METADATA_KEY, metadata);
}

/** Asks for a display name and group. Returns false when the user cancels. */
export async function editServerMetadata(context: vscode.ExtensionContext, host: string): Promise<boolean> {
    const metadata = { ...serverMetadata(context) };
    const alias = await vscode.window.showInputBox({
        title: `Display name for ${host}`,
        value: metadata[host]?.alias || '',
        placeHolder: 'Optional server alias'
    });
    if (alias === undefined) {
        return false;
    }
    const group = await vscode.window.showInputBox({
        title: `Group for ${host}`,
        value: metadata[host]?.group || '',
        placeHolder: 'e.g. Lab A, A6000, Personal'
    });
    if (group === undefined) {
        return false;
    }
    metadata[host] = { ...metadata[host], alias: alias.trim() || undefined, group: group.trim() || undefined };
    await context.globalState.update(METADATA_KEY, metadata);
    return true;
}

/** Prepares (but does not run) an SSH command that pins CUDA to one GPU. */
export function openGpuTerminal(host: string, uuid: string): void {
    if (!isValidSshTarget(host) || !isValidGpuId(uuid)) {
        return;
    }
    // A file: cwd keeps the terminal on this machine in Remote-SSH/WSL/container windows, where the
    // SSH alias and keys from the local ~/.ssh/config are available.
    const terminal = vscode.window.createTerminal({ name: `GPU ${host}`, cwd: vscode.Uri.file(os.homedir()) });
    terminal.show();
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const configArgs = sshConfigArguments(configuration().get<string>('sshConfigPath'));
    const command = `ssh ${configArgs.map(quote).join(' ')} -t ${host} 'export CUDA_DEVICE_ORDER=PCI_BUS_ID; export CUDA_VISIBLE_DEVICES=${uuid}; exec "$SHELL" -l'`;
    terminal.sendText(command, false);
}

export async function copyToClipboard(value: string): Promise<void> {
    if (value) {
        await vscode.env.clipboard.writeText(value);
        void vscode.window.setStatusBarMessage('$(check) Copied', 2000);
    }
}
