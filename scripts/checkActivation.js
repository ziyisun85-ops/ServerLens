// Activation smoke test with a mocked VS Code API (a real VS Code instance was not available
// for testing): every contributed command is registered, the sidebar view resolves and answers,
// settings migrate once, commands run, and deactivate releases everything.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const manifest = require('../package.json');

function createVscodeMock(state) {
    const disposable = () => ({ dispose() {} });
    class EventEmitter { constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return disposable(); }; } fire(value) { this.listeners.forEach(listener => listener(value)); } dispose() {} }
    const sectionValues = section => state.config[section] || (state.config[section] = {});
    const getConfiguration = section => ({
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(sectionValues(section), key) ? sectionValues(section)[key] : fallback,
        inspect: key => ({ globalValue: sectionValues(section)[key] }),
        update: async (key, value) => {
            if (state.failUpdates) throw new Error('Unable to write into user settings because the file has unsaved changes.');
            sectionValues(section)[key] = value;
            state.configListeners.forEach(listener => listener({ affectsConfiguration: prefix => `${section}.${key}`.startsWith(prefix) }));
        }
    });
    return {
        EventEmitter, Disposable: class { constructor(fn) { this.dispose = fn; } },
        TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
        ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } }, ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: class {
            constructor(value = '') { this.value = value; this.texts = []; }
            appendMarkdown(value) { this.value += value; return this; }
            appendText(value) { this.texts.push(value); this.value += value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, '\\$&'); return this; }
        },
        Uri: { joinPath: (...parts) => parts.join('/'), file: fsPath => ({ scheme: 'file', fsPath }) },
        TreeItemCollapsibleState: { None: 0 }, ViewColumn: { One: 1 }, ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Left: 1 },
        ProgressLocation: { Notification: 15 }, QuickPickItemKind: { Separator: -1 },
        env: { language: 'zh-cn', clipboard: { writeText: async value => { state.clipboard = value; } } },
        window: {
            createOutputChannel: () => ({ debug() {}, info: message => state.log.push(message), warn: message => state.log.push(message), error: message => state.log.push(message), show() {}, dispose() {} }),
            createStatusBarItem: () => { const item = { show() { item.visible = true; }, hide() { item.visible = false; }, dispose() {} }; state.statusBar = item; return item; },
            registerWebviewViewProvider: (id, provider) => { state.views[id] = provider; return disposable(); },
            registerTreeDataProvider: (id, provider) => { state.trees[id] = provider; return disposable(); },
            createTreeView: (id, options) => {
                state.trees[id] = options.treeDataProvider;
                const view = { visible: false, visibilityListeners: [], onDidChangeVisibility: listener => { view.visibilityListeners.push(listener); return disposable(); }, dispose() {} };
                state.treeViews[id] = view;
                return view;
            },
            createWebviewPanel: () => {
                const panel = { visible: true, title: '', webview: { html: '', postMessage: async message => state.panelMessages.push(message), onDidReceiveMessage: disposable },
                    onDidDispose: callback => { panel.disposeCallback = callback; return disposable(); }, onDidChangeViewState: disposable, reveal() {},
                    dispose() { panel.disposeCallback?.(); } };
                state.panels.push(panel);
                return panel;
            },
            showInformationMessage: async message => { state.messages.push(message); return undefined; },
            showWarningMessage: async message => { state.messages.push(message); return undefined; },
            showErrorMessage: async message => { state.messages.push(message); return undefined; },
            showInputBox: async () => undefined, showQuickPick: async () => undefined,
            setStatusBarMessage: message => { state.messages.push(message); return disposable(); },
            withProgress: async (_options, task) => task({ report() {} }, { onCancellationRequested: disposable }),
            createTerminal: () => ({ show() {}, sendText() {} }), activeTextEditor: undefined
        },
        commands: {
            registerCommand: (id, handler) => { state.commands.set(id, handler); return { dispose: () => state.commands.delete(id) }; },
            executeCommand: async (id, ...args) => { state.executed.push(id); return state.commands.get(id)?.(...args); }
        },
        workspace: { getConfiguration, onDidChangeConfiguration: listener => { state.configListeners.push(listener); return disposable(); } }
    };
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-activation-'));
    const sshConfig = path.join(directory, 'ssh_config');
    fs.writeFileSync(sshConfig, 'Host ignored-by-targets\n  HostName 127.0.0.1\n');
    const state = {
        config: { 'gpu-fleet-viewer': { targets: ['gpu-01.invalid'], refreshInterval: 7 }, serverlens: { sshConfigPath: sshConfig, autoRefresh: false, connectionReuse: false } },
        configListeners: [], commands: new Map(), executed: [], views: {}, trees: {}, treeViews: {}, panels: [], panelMessages: [], messages: [], log: [],
        failUpdates: false
    };
    const vscode = createVscodeMock(state);
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    const extension = require('../out/extension');
    Module._load = originalLoad;
    const globalStore = new Map();
    const context = {
        subscriptions: [], extensionUri: '/ext', extension: { packageJSON: manifest },
        globalState: { get: (key, fallback) => globalStore.has(key) ? globalStore.get(key) : fallback, update: async (key, value) => { globalStore.set(key, value); } }
    };
    try {
        await extension.activate(context);
        assert.deepStrictEqual(state.config.serverlens.targets, ['gpu-01.invalid'], 'GPU Fleet Viewer settings are copied on first start.');
        assert.strictEqual(state.config.serverlens.refreshInterval, 7);
        const contributed = manifest.contributes.commands.map(command => command.command).sort();
        const registered = Array.from(state.commands.keys()).sort();
        assert.deepStrictEqual(registered, contributed, 'Every contributed command is registered and nothing else.');
        assert.ok(state.views['serverlens.monitor'] && state.trees['serverlens.servers'] && state.treeViews['serverlens.servers']);
        assert.ok(manifest.contributes.views.serverlens.some(view => view.id === 'serverlens.monitor' && view.type === 'webview'));
        assert.strictEqual(state.statusBar.visible, true);

        const posted = [];
        let receive;
        const view = {
            visible: true,
            webview: { options: {}, html: '', postMessage: async message => { posted.push(message); }, onDidReceiveMessage: listener => { receive = listener; return { dispose() {} }; } },
            onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} })
        };
        state.views['serverlens.monitor'].resolveWebviewView(view);
        assert.match(view.webview.html, /Content-Security-Policy/);
        assert.ok(view.webview.options.enableScripts);
        receive({ command: 'ready' });
        await new Promise(resolve => setTimeout(resolve, 50));
        const first = posted.find(message => message.type === 'state');
        assert.ok(first && first.full, 'The view gets a full state after it loads.');
        assert.deepStrictEqual(first.order, ['gpu-01.invalid'], 'Hosts come from targets.');
        assert.strictEqual(first.language, 'zh-CN', 'The UI language follows VS Code.');

        await state.commands.get('serverlens.refresh')();
        const snapshot = first.servers[0];
        assert.strictEqual(snapshot.host, 'gpu-01.invalid');
        await new Promise(resolve => setTimeout(resolve, 200));
        const latest = posted.filter(message => message.type === 'state').at(-1);
        const host = latest.servers.find(server => server.host === 'gpu-01.invalid') || {};
        assert.ok(host.error, 'An unresolvable host is reported as an error, not a crash.');
        assert.strictEqual(host.errorCategory, 'host-not-found');

        await state.commands.get('serverlens.collapseAll')();
        assert.ok(posted.some(message => message.type === 'collapse' && message.all === true));
        await state.commands.get('serverlens.copySshCommand')({ webviewSection: 'server', host: 'gpu-01.invalid' });
        assert.strictEqual(state.clipboard, 'ssh gpu-01.invalid');
        await state.commands.get('serverlens.copySshCommand')({ host: '-oProxyCommand=evil' });
        assert.strictEqual(state.clipboard, 'ssh gpu-01.invalid', 'Context-menu arguments are validated.');
        await state.commands.get('serverlens.muteDiskAlert')({ webviewSection: 'disk', host: 'gpu-01.invalid', mount: '/data' });
        assert.ok(globalStore.get('serverlens.diskAlerts.muted')['gpu-01.invalid\u0000/data']);
        await state.commands.get('serverlens.resetDiskAlerts')();
        assert.deepStrictEqual(globalStore.get('serverlens.diskAlerts.muted'), {});
        await state.commands.get('serverlens.openDashboard')();
        assert.strictEqual(state.panels.length, 1, 'The dashboard opens.');
        await state.commands.get('serverlens.openServer')('gpu-01.invalid');
        assert.strictEqual(state.panels.length, 2, 'A per-server dashboard opens.');
        await state.commands.get('serverlens.analyzeStorage')();
        assert.ok(!state.messages.some(message => /failed/i.test(message)), 'Cancelling the storage picker does nothing.');

        await vscode.workspace.getConfiguration('serverlens').update('targets', ['gpu-02.invalid']);
        await new Promise(resolve => setTimeout(resolve, 500));
        const reconfigured = posted.filter(message => message.type === 'state').at(-1);
        assert.deepStrictEqual(reconfigured.order, ['gpu-02.invalid'], 'Changing targets updates the view.');

        await extension.deactivate();
        for (const item of context.subscriptions) item.dispose();
        assert.strictEqual(state.panels.every(panel => panel.disposeCallback), true);

        // A settings.json with unsaved edits makes config.update() reject, and hand-edited settings may
        // have the wrong type. Neither may stop activation (all commands and views must still register).
        state.failUpdates = true;
        state.commands.clear();
        state.config['gpu-fleet-viewer'] = { refreshInterval: 9 };
        state.config.serverlens = { sshConfigPath: path.join(directory, 'missing-dir', 'nope'), autoRefresh: false, connectionReuse: false,
            targets: 'not-a-list', additionalHosts: 42, hiddenMounts: 7, pinnedMounts: 'x', visibleGpus: null };
        const freshStore = new Map();
        const secondContext = { ...context, subscriptions: [], globalState: { get: (key, fallback) => freshStore.has(key) ? freshStore.get(key) : fallback, update: async (key, value) => { freshStore.set(key, value); } } };
        await extension.activate(secondContext);
        assert.deepStrictEqual(Array.from(state.commands.keys()).sort(), contributed, 'Activation completes even when migration and settings are broken.');
        assert.ok(state.log.some(line => /Could not copy settings/.test(line)), 'The migration failure is logged.');
        assert.notStrictEqual(freshStore.get('serverlens.legacySettingsMigrated'), true, 'A failed migration is retried next time.');
        await state.commands.get('serverlens.refresh')();
        state.treeViews['serverlens.servers'].visibilityListeners.forEach(listener => listener({ visible: true }));
        await extension.deactivate();
        for (const item of secondContext.subscriptions) item.dispose();
        console.log('Activation: commands registered, settings migrated, sidebar view, dashboard, context-menu commands, reconfiguration and deactivate passed.');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
