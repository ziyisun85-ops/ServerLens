// ServerLens: checks that run inside a real VS Code extension host (see runTest.ts).
// They cover what the mocked tests cannot: activation, contributed commands, the sidebar and
// dashboard webviews loading their scripts under the real Content-Security-Policy, command
// arguments in the shapes VS Code passes them, and reacting to settings changes.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ServerLensTestApi as TestApi } from '../../../extension';

// out/test/vscode/suite is four levels below the repository root.
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8')) as { publisher: string; name: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const HOST = 'serverlens-ci';

async function waitFor<T>(what: string, check: () => T | undefined | false | null, timeoutMs = 30000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = check();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function update(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('serverlens').update(key, value, vscode.ConfigurationTarget.Global);
}

export async function run(): Promise<void> {
    const failures: string[] = [];
    const step = async (name: string, body: () => Promise<void>) => {
        try {
            await body();
            console.log(`  ✓ ${name}`);
        } catch (error) {
            const message = error instanceof Error ? error.stack || error.message : String(error);
            console.error(`  ✗ ${name}: ${message}`);
            failures.push(name);
        }
    };
    console.log(`ServerLens extension tests in VS Code ${vscode.version}`);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is installed in the test instance`);
    let api: TestApi | undefined;

    await step('activates on its own after startup (onStartupFinished)', async () => {
        await waitFor('startup activation', () => extension.isActive);
    });

    await step('activates without errors', async () => {
        api = await extension.activate() as TestApi | undefined;
        assert.ok(extension.isActive);
        assert.ok(api && typeof api.hosts === 'function', 'test API is exported when SERVERLENS_TEST=1');
    });
    if (!api) {
        throw new Error('Activation failed; skipping the remaining checks.');
    }
    const testApi = api;

    await step('registers every contributed command', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const contributed = (extension.packageJSON.contributes.commands as { command: string }[]).map(item => item.command);
        const missing = contributed.filter(command => !registered.has(command));
        assert.deepStrictEqual(missing, []);
    });

    const scratch = process.env.SERVERLENS_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-'));
    const sshConfig = path.join(scratch, 'ssh_config');
    // Port 9 (discard) on localhost is closed on CI runners, so ssh fails fast with "Connection refused".
    fs.writeFileSync(sshConfig, `Host ${HOST}\n  HostName 127.0.0.1\n  Port 9\n  ConnectTimeout 3\n`);

    await step('picks up hosts from the configured SSH config', async () => {
        await update('autoRefresh', false);
        // With no targets set, the host list can only come from parsing this file.
        await update('sshConfigPath', `  ${sshConfig}  `);
        await waitFor('the host list from the parsed SSH config', () => testApi.hosts().join(',') === HOST);
    });

    await step('reports an unreachable server as an error instead of failing', async () => {
        await vscode.commands.executeCommand('serverlens.refresh');
        const snapshot = await waitFor('a failed snapshot', () => testApi.snapshot(HOST)?.error ? testApi.snapshot(HOST) : undefined);
        assert.ok(['refused', 'unreachable', 'timeout', 'connection-closed'].includes(String(snapshot?.errorCategory)),
            `unexpected error category ${snapshot?.errorCategory}: ${snapshot?.error}`);
        assert.strictEqual(snapshot?.lastSuccessAt, undefined);
    });

    await step('sidebar webview loads its script under the real CSP', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.serverlens');
        await vscode.commands.executeCommand('serverlens.monitor.focus');
        await waitFor('the sidebar webview to send "ready"', () => testApi.sidebarReadyCount() > 0);
    });

    await step('dashboard webview loads its script under the real CSP', async () => {
        const before = testApi.dashboardReadyCount();
        await vscode.commands.executeCommand('serverlens.openDashboard');
        await waitFor('the dashboard webview to send "ready"', () => testApi.dashboardReadyCount() > before);
    });

    await step('per-server commands accept a host string, a tree item and a webview context object', async () => {
        const before = testApi.dashboardReadyCount();
        await vscode.commands.executeCommand('serverlens.openServer', HOST);
        await waitFor('the per-server dashboard', () => testApi.dashboardReadyCount() > before);
        await vscode.commands.executeCommand('serverlens.refreshServer', { host: HOST, contextValue: 'server' });
        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand('serverlens.copySshCommand', { webview: 'serverlens.monitor', webviewSection: 'server', host: HOST });
        assert.strictEqual(await vscode.env.clipboard.readText(), `ssh ${HOST}`);
        await vscode.commands.executeCommand('serverlens.copySshCommand', { webview: 'serverlens.monitor', host: '-oProxyCommand=touch /tmp/x' });
        assert.strictEqual(await vscode.env.clipboard.readText(), `ssh ${HOST}`, 'invalid hosts are ignored');
        await vscode.commands.executeCommand('serverlens.muteDiskAlert', { webview: 'serverlens.monitor', webviewSection: 'disk', host: HOST, mount: '/data' });
        await vscode.commands.executeCommand('serverlens.resetDiskAlerts');
    });

    await step('reacts to settings changes', async () => {
        await update('targets', ['another-ci-host']);
        await waitFor('the new host list', () => testApi.hosts().join(',') === 'another-ci-host');
        await update('targets', undefined);
        await update('sshConfigPath', undefined);
        await update('autoRefresh', undefined);
    });

    if (failures.length) {
        throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
    }
}
