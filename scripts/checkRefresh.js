// Dashboard panel integration with the shared MonitorService.
// Rewritten for ServerLens (2026) from GPU Fleet Viewer's refresh test: the panel's own polling loop
// moved to MonitorService, which scheduler_test covers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-refresh-'));
    const sshConfig = path.join(directory, 'ssh_config');
    fs.writeFileSync(sshConfig, 'Host lab-node\n');
    const values = new Map([['autoRefresh', false], ['sshConfigPath', sshConfig]]);
    const listeners = new Set();
    const terminalCommands = [];
    const configuration = {
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: async (key, value) => {
            values.set(key, value);
            for (const listener of listeners) listener({ affectsConfiguration: prefix => ('serverlens.' + key).startsWith(prefix) });
        }
    };
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return {
            window: { createTerminal: () => ({ show() {}, sendText: (command, execute) => terminalCommands.push({ command, execute }) }), setStatusBarMessage() {} },
            TreeItem: class {}, ThemeIcon: class {}, ThemeColor: class {}, EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
            TreeItemCollapsibleState: { None: 0 }, ConfigurationTarget: { Global: 1 }, env: { language: 'en', clipboard: { writeText: async () => undefined } },
            workspace: {
                getConfiguration: () => configuration,
                onDidChangeConfiguration: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }
            }
        };
        return originalLoad.call(this, request, parent, isMain);
    };
    const { GpuViewPanel } = require('../out/gpuView');
    const { MonitorService } = require('../out/monitorService');
    const { readMonitorConfig } = require('../out/settings');
    Module._load = originalLoad;

    let execs = 0;
    let release;
    const runner = {
        exec: async (_host, script) => {
            execs++;
            if (release === null) await new Promise(resolve => { release = resolve; });
            const nonce = script.match(/^SL_N=([0-9a-f]+)$/m)[1];
            const sections = Array.from(script.matchAll(/^sl_begin (\w+)$/gm)).map(match => match[1]);
            const bodies = {
                gpu: '0, GPU-demo-0, Research GPU, 0, 0, 24576, 24576, 0, 30, 20, 200, 20\n1, GPU-demo-1, Research GPU, 0, 0, 24576, 24576, 0, 30, 20, 200, 20',
                mem: 'MemTotal: 1000 kB\nMemAvailable: 500 kB', cpu: 'stat cpu 1 0 1 8 0 0 0 0\nncpu 4',
                df: 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 950 50 95% /data'
            };
            const stdout = sections.map(name => `@@SL:${nonce}:begin ${name}@@\n${bodies[name] || ''}\n@@SL:${nonce}:end ${name} 0@@`).join('\n') + `\n@@SL:${nonce}:done@@\n`;
            return { stdout, stderr: '', exitCode: 0, durationMs: 3, multiplexed: true };
        }
    };
    const monitor = new MonitorService(runner, () => readMonitorConfig(['lab-node'], configuration));
    const consumers = [];
    const setConsumer = monitor.setConsumerVisible.bind(monitor);
    monitor.setConsumerVisible = (id, visible) => { consumers.push([id, visible]); setConsumer(id, visible); };
    const messages = [];
    let visibility;
    let disposePanel;
    const disposable = () => ({ dispose() {} });
    const webviewPanel = {
        visible: true, title: '',
        webview: { postMessage: async message => { messages.push(message); }, onDidReceiveMessage: disposable },
        onDidDispose: callback => { disposePanel = callback; return disposable(); },
        onDidChangeViewState: callback => { visibility = callback; return disposable(); },
        reveal() {}, dispose() { disposePanel(); }
    };
    const context = { globalState: { get: (_key, fallback) => fallback, update: async () => undefined }, extensionUri: {} };
    const panel = new GpuViewPanel(webviewPanel, context, monitor);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const lastUpdate = () => messages.filter(message => message.type === 'update').at(-1);
    try {
        assert.deepStrictEqual(consumers.at(-1).slice(1), [true], 'A visible dashboard counts as a consumer of monitoring data.');
        await panel.handleMessage({ command: 'refresh' });
        await wait(200);
        assert.strictEqual(execs, 1);
        const update = lastUpdate();
        assert.strictEqual(update.data.length, 1);
        assert.strictEqual(update.data[0].gpus.length, 2);
        assert.strictEqual(update.data[0].disks.disks[0].usedPercent, 95, 'Disk data reaches the dashboard.');
        assert.strictEqual(update.summary.gpusAvailable, 2);

        release = null;
        const clicks = [panel.handleMessage({ command: 'refresh' })];
        await wait(10);
        clicks.push(panel.handleMessage({ command: 'refresh' }), panel.handleMessage({ command: 'refresh' }));
        await wait(10);
        release();
        release = undefined;
        await Promise.all(clicks);
        assert.strictEqual(execs, 3, 'Clicks during a collection queue exactly one more collection.');
        assert.ok(messages.some(message => message.type === 'refreshState' && message.state === 'refreshing'));

        await panel.handleMessage({ command: 'savePreferences', values: { showPower: false } });
        await wait(200);
        assert.strictEqual(execs, 3, 'A display-only setting does not query SSH.');
        assert.strictEqual(lastUpdate().settings.showPower, false);
        await panel.handleMessage({ command: 'savePreferences', values: { visibleGpus: { 'lab-node': ['1'] } } });
        await wait(200);
        const scoped = lastUpdate();
        assert.strictEqual(scoped.data[0].gpus.length, 1);
        assert.strictEqual(scoped.summary.gpusTotal, 1, 'Summary uses the same GPU scope as the dashboard.');
        assert.strictEqual(scoped.gpuCatalog[0].gpus.length, 2, 'Settings still offer hidden GPUs.');
        assert.strictEqual(execs, 3);
        await panel.handleMessage({ command: 'savePreferences', values: { refreshInterval: 1 } }).catch(() => undefined);
        assert.ok(messages.some(message => message.type === 'preferencesResult' && message.success === false), 'Out-of-range values are rejected.');

        await panel.handleMessage({ command: 'openGpuTerminal', host: 'lab-node', uuid: 'GPU-demo-1' });
        assert.ok(terminalCommands[0].command.includes('-F') && terminalCommands[0].command.includes(sshConfig), 'Prepared terminals honour the SSH config.');
        assert.ok(terminalCommands[0].command.includes('CUDA_VISIBLE_DEVICES=GPU-demo-1'));
        assert.strictEqual(terminalCommands[0].execute, false, 'Research commands are never executed automatically.');
        await panel.handleMessage({ command: 'openGpuTerminal', host: '-oProxyCommand=x', uuid: 'GPU-demo-1' });
        assert.strictEqual(terminalCommands.length, 1, 'Invalid hosts are ignored.');

        webviewPanel.visible = false;
        visibility({ webviewPanel });
        assert.deepStrictEqual(consumers.at(-1).slice(1), [false], 'Hiding the dashboard stops it from keeping refresh alive.');
        panel.dispose();
        assert.strictEqual(monitor.consumers.has(consumers[0][0]), false, 'Disposing the dashboard removes it as a consumer.');
        console.log('Dashboard uses the shared monitor: one collection per refresh burst, display-only settings, GPU scope, terminals and visibility passed.');
    } finally {
        monitor.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
