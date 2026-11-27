// Renders the real sidebar webview HTML/CSS/JS with sample data and VS Code default theme colours,
// for the jsdom test (checkSidebar.js) and for screenshots in docs/screenshots.
const fs = require('fs');
const path = require('path');
const { getSidebarHtml } = require('../out/sidebarTemplate');
const sample = require('./sidebarPreviewData');

const themes = {
    dark: {
        className: 'vscode-dark',
        vars: {
            '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif', '--vscode-font-size': '13px',
            '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace', '--vscode-foreground': '#cccccc',
            '--vscode-descriptionForeground': '#9d9d9d', '--vscode-sideBar-background': '#181818', '--vscode-editor-background': '#1f1f1f',
            '--vscode-widget-border': '#313131', '--vscode-panel-border': '#2b2b2b', '--vscode-list-hoverBackground': '#2a2d2e',
            '--vscode-focusBorder': '#0078d4', '--vscode-textLink-foreground': '#4daafc', '--vscode-charts-green': '#89d185',
            '--vscode-charts-yellow': '#cca700', '--vscode-charts-red': '#f14c4c', '--vscode-charts-blue': '#3794ff',
            '--vscode-errorForeground': '#f85149', '--vscode-editorWarning-foreground': '#cca700'
        }
    },
    light: {
        className: 'vscode-light',
        vars: {
            '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif', '--vscode-font-size': '13px',
            '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace', '--vscode-foreground': '#3b3b3b',
            '--vscode-descriptionForeground': '#616161', '--vscode-sideBar-background': '#f8f8f8', '--vscode-editor-background': '#ffffff',
            '--vscode-widget-border': '#e5e5e5', '--vscode-panel-border': '#e5e5e5', '--vscode-list-hoverBackground': '#f2f2f2',
            '--vscode-focusBorder': '#005fb8', '--vscode-textLink-foreground': '#005fb8', '--vscode-charts-green': '#388a34',
            '--vscode-charts-yellow': '#bf8803', '--vscode-charts-red': '#e51400', '--vscode-charts-blue': '#1a85ff',
            '--vscode-errorForeground': '#a1260d', '--vscode-editorWarning-foreground': '#bf8803'
        }
    }
};

function render(themeName, options = {}) {
    const theme = themes[themeName];
    let html = getSidebarHtml('previewnonce');
    // Headless Chrome has a 500 px minimum viewport, so the sidebar width is fixed on <body> instead.
    const width = options.width || 340;
    const css = ':root {' + Object.entries(theme.vars).map(([name, value]) => `${name}: ${value};`).join(' ') + '}' +
        ` html { background: #808080; } body { background: var(--vscode-sideBar-background); width: ${width}px; min-height: 100vh; }`;
    html = html.replace('</head>', `<style>${css}</style></head>`).replace('<body>', `<body class="${theme.className}">`);
    html = html.replace('const vscode = acquireVsCodeApi();', `const vscode = {
        postMessage(message) { (window.__messages ||= []).push(message); },
        getState() { return window.__previewState; },
        setState(state) { window.__previewState = state; }
    };`);
    const state = { detailsOpen: options.details || [], allDisks: [], allScan: [] };
    const message = { type: 'state', full: true, language: options.language || 'en', settings: sample.settings, automatic: true,
        order: options.order || sample.order, collapsed: options.collapsed || sample.collapsed, servers: sample.servers,
        activity: { running: 0, queued: 0, total: sample.order.length } };
    html = html.replace('<script nonce="previewnonce">', `<script nonce="previewnonce">window.__previewState = ${JSON.stringify(state)};</script><script nonce="previewnonce">`);
    html = html.replace('</body>', `<script nonce="previewnonce">window.__preview = ${JSON.stringify(message)}; window.postMessage(window.__preview, '*');</script></body>`);
    return html;
}

const directory = path.join(__dirname, '..', 'preview');
fs.mkdirSync(directory, { recursive: true });
const files = {
    'sidebar-dark.html': render('dark'),
    'sidebar-light.html': render('light'),
    'sidebar-details-dark.html': render('dark', { details: ['4090-12'], order: ['4090-12'], collapsed: [] }),
    'sidebar-zh-light.html': render('light', { language: 'zh-CN' }),
    'sidebar-narrow-dark.html': render('dark', { width: 230, order: ['4090-12', 'a6000-east', 'cpu-node-01'], collapsed: [] })
};
for (const [name, html] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), html);
}
console.log(`Sidebar previews generated: ${Object.keys(files).join(', ')}`);
