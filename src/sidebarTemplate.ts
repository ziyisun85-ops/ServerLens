// ServerLens: HTML, CSS and script for the sidebar server cards (a WebviewView).
// Reuses the dashboard's keyed DOM patching, Lucide icons and translation files.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import en = require('./locales/en.json');
import zhCN = require('./locales/zh-CN.json');
import lineIcons = require('./lineIcons.json');
import { sharedDomHelpers, sharedFormatHelpers } from './webviewShared';

const translations = { en, 'zh-CN': zhCN };

export function getSidebarHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>ServerLens</title>
    <style>${getSidebarCss()}</style>
</head>
<body>
    <header class="topbar" id="topbar"><span id="fleet-summary" class="fleet-summary"></span><span id="refresh-state" class="refresh-state"></span></header>
    <main id="cards" aria-live="off"></main>
    <section id="empty" class="empty" hidden></section>
    <script nonce="${nonce}">${getSidebarScript()}</script>
</body>
</html>`;
}

export function getSidebarCss(): string {
    return `
        :root { color-scheme: light dark; --gap: 6px; --ok: var(--vscode-charts-green, #3fb950); --warn: var(--vscode-charts-yellow, #d29922);
            --crit: var(--vscode-charts-red, #f85149); --info: var(--vscode-charts-blue, #3794ff); --muted: var(--vscode-descriptionForeground);
            --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35))); --track: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        body { margin: 0; padding: 0 8px 16px; color: var(--vscode-foreground); background: transparent; font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px); line-height: 1.4; }
        button { font: inherit; color: inherit; background: transparent; border: 0; padding: 0; cursor: pointer; }
        button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 3px; }
        .icon { display: inline-flex; width: 14px; height: 14px; flex: 0 0 14px; align-items: center; justify-content: center; }
        .icon svg { width: 100%; height: 100%; stroke-width: 1.8; }
        .topbar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; gap: 8px;
            padding: 6px 2px; background: var(--vscode-sideBar-background); color: var(--muted); font-size: 11px; }
        .fleet-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fleet-summary .warn { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .refresh-state { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
        .refresh-state.busy .icon { animation: spin 1.1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 50% { opacity: .35; } }
        .card { container-type: inline-size; container-name: card; margin: 0 0 8px; border: 1px solid var(--border); border-radius: 6px;
            background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 92%, var(--vscode-foreground) 4%); overflow: hidden; }
        .vscode-high-contrast .card, .vscode-high-contrast-light .card { border-color: var(--vscode-contrastBorder, var(--border)); }
        .card-head { display: flex; align-items: center; gap: 4px; min-height: 30px; padding: 3px 4px 3px 2px; }
        .card-toggle { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 3px 4px; border-radius: 4px; text-align: left; }
        .card-toggle:hover, .icon-button:hover, .text-button:hover { background: var(--vscode-list-hoverBackground); }
        .chevron { transition: transform .15s ease; color: var(--muted); }
        .card:not(.collapsed) .chevron { transform: rotate(90deg); }
        .dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--muted); }
        .state-online .dot { background: var(--ok); }
        .state-stale .dot { background: var(--warn); }
        .state-offline .dot { background: var(--crit); }
        .state-pending .dot { background: var(--info); animation: pulse 1.4s ease-in-out infinite; }
        .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .state-label { margin-left: auto; padding-left: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
        .state-offline .state-label { color: var(--vscode-errorForeground, var(--crit)); }
        .state-stale .state-label { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .icon-button { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 22px; border-radius: 4px; color: var(--muted); }
        .icon-button:hover { color: var(--vscode-foreground); }
        .card.refreshing .icon-button.refresh .icon { animation: spin 1.1s linear infinite; }
        .sub { padding: 0 10px 4px 34px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .collapsed-line { padding: 0 10px 6px 34px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .collapsed-line .critical { color: var(--vscode-errorForeground, var(--crit)); }
        .collapsed-line .warning { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .body { padding: 0 10px 8px 12px; }
        .section { margin-top: 6px; }
        .section-title { display: flex; align-items: center; gap: 5px; margin: 8px 0 3px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
        .row { display: grid; grid-template-columns: 4.4em 2.9em minmax(28px, 1fr) auto; align-items: center; gap: 6px; min-height: 19px;
            font-size: 12px; font-variant-numeric: tabular-nums; }
        .row + .row { margin-top: 1px; }
        .row-label { display: flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; }
        .row-label .avail { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: .5; }
        .row-label .avail.on { background: var(--ok); opacity: 1; }
        .pct { text-align: right; white-space: nowrap; }
        .aside { color: var(--muted); font-size: 11px; white-space: nowrap; text-align: right; }
        .aside.warning { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .meter { display: block; height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
        .fill { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--meter, var(--info)); transition: width .35s ease; }
        .lv-ok { --meter: var(--ok); }
        .lv-warning { --meter: var(--warn); }
        .lv-critical { --meter: var(--crit); }
        .lv-neutral { --meter: var(--info); }
        .stale-data .row, .stale-data .disk { opacity: .62; }
        .note { margin: 3px 0; color: var(--muted); font-size: 11px; }
        .note.warning { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .note.error { color: var(--vscode-errorForeground, var(--crit)); }
        .disk { margin: 5px 0 0; }
        .disk-line { display: grid; grid-template-columns: minmax(0, 1fr) minmax(40px, 38%) 2.9em; align-items: center; gap: 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
        .mount { display: flex; align-items: center; gap: 4px; min-width: 0; }
        .mount-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mount .icon { width: 11px; height: 11px; flex-basis: 11px; color: var(--muted); }
        .disk-detail { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
        .disk-detail .critical { color: var(--vscode-errorForeground, var(--crit)); }
        .quota { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; margin-top: 1px; font-size: 11px; color: var(--muted); }
        .quota.warning { color: var(--vscode-editorWarning-foreground, var(--warn)); }
        .quota.critical { color: var(--vscode-errorForeground, var(--crit)); }
        .text-button { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px; margin: 2px 0; border-radius: 3px;
            color: var(--vscode-textLink-foreground, var(--info)); font-size: 11px; }
        .banner { display: grid; gap: 2px; margin: 0 10px 6px 12px; padding: 5px 8px; border-left: 3px solid var(--crit); border-radius: 3px;
            background: color-mix(in srgb, var(--crit) 10%, transparent); font-size: 11.5px; }
        .state-stale .banner { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
        .banner-title { font-weight: 600; overflow-wrap: anywhere; }
        .banner-meta { color: var(--muted); font-size: 11px; }
        .banner-actions { display: flex; gap: 8px; }
        details.details { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 4px; }
        details.details > summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; color: var(--muted); font-size: 11px; padding: 2px 0; }
        details.details > summary::-webkit-details-marker { display: none; }
        details.details > summary .icon { transition: transform .15s ease; width: 12px; height: 12px; }
        details.details[open] > summary .icon { transform: rotate(90deg); }
        .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 1px 8px; margin: 2px 0 4px; font-size: 11px; }
        .kv dt { color: var(--muted); }
        .kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
        .gpu-detail { margin: 4px 0 6px; font-size: 11px; }
        .gpu-detail-title { display: flex; justify-content: space-between; gap: 6px; font-weight: 600; }
        .gpu-detail-title span:last-child { color: var(--muted); font-weight: 400; white-space: nowrap; }
        .process { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 6px; padding: 2px 0 2px 8px; border-left: 2px solid var(--border); margin-top: 2px; }
        .process-command { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted);
            font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
        .actions { display: flex; flex-wrap: wrap; gap: 2px 8px; }
        .scan-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 6px; margin-top: 3px; font-size: 11px; font-variant-numeric: tabular-nums; }
        .scan-entry .meter { grid-column: 1 / -1; height: 3px; }
        .scan-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .empty { padding: 16px 4px; color: var(--muted); }
        .empty h2 { margin: 0 0 6px; font-size: 13px; color: var(--vscode-foreground); }
        .empty .actions { margin-top: 8px; }
        @container card (max-width: 250px) {
            .row { grid-template-columns: 3.9em 2.7em minmax(20px, 1fr); }
            .row .aside { grid-column: 2 / -1; text-align: left; margin-top: -2px; }
            .disk-line { grid-template-columns: minmax(0, 1fr) 2.9em; }
            .disk-line .meter { grid-column: 1 / -1; grid-row: 2; }
            .sub, .collapsed-line { padding-left: 12px; }
        }
        @container card (max-width: 190px) { .state-label { display: none; } }
        @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
    `;
}

export function getSidebarScript(): string {
    return `
        const vscode = acquireVsCodeApi();
        const translations = ${JSON.stringify(translations)};
        const icons = ${JSON.stringify(lineIcons)};
        ${sharedDomHelpers()}
        ${sharedFormatHelpers()}
        const cardsRoot = document.getElementById('cards');
        const emptyRoot = document.getElementById('empty');
        const summaryRoot = document.getElementById('fleet-summary');
        const refreshRoot = document.getElementById('refresh-state');
        const saved = (vscode.getState && vscode.getState()) || {};
        const detailsOpen = new Set(saved.detailsOpen || []);
        const allDisks = new Set(saved.allDisks || []);
        const allScan = new Set(saved.allScan || []);
        let language = 'en';
        let settings = { diskWarningThreshold: 70, diskCriticalThreshold: 90, memoryWarningThreshold: 85, temperatureWarningThreshold: 80, byteUnits: 'iec', showProcesses: true };
        let order = [];
        const servers = new Map();
        let collapsed = new Set();
        let activity = { running: 0, queued: 0, total: 0 };
        let automatic = true;
        let received = false;

        function t(key) { return (translations[language] && translations[language][key]) || translations.en[key] || key; }
        function icon(name) {
            const element = document.createElement('span');
            element.className = 'icon';
            element.setAttribute('aria-hidden', 'true');
            element.innerHTML = icons[name] || '';
            return element;
        }
        // Spinners run only for refreshes the user asked for. Each one turns at least once and stops at
        // the end of a turn (the CSS animation period), so it never snaps back mid-rotation.
        const SPIN_PERIOD = 1100;
        const spins = new Map();
        let spinTimer;
        let spinTimerAt = Infinity;
        function scheduleSpinRender(at) {
            if (at >= spinTimerAt) return;
            clearTimeout(spinTimer);
            spinTimerAt = at;
            spinTimer = setTimeout(() => { spinTimerAt = Infinity; render(); }, Math.max(0, at - performance.now()));
        }
        function spinning(key, active) {
            const now = performance.now();
            const spin = spins.get(key);
            if (active) {
                if (!spin) spins.set(key, { start: now, stopAt: undefined });
                else spin.stopAt = undefined;
                return true;
            }
            if (!spin) return false;
            if (spin.stopAt === undefined) {
                spin.stopAt = spin.start + Math.max(1, Math.ceil((now - spin.start) / SPIN_PERIOD)) * SPIN_PERIOD;
            }
            if (now >= spin.stopAt - 20) {
                spins.delete(key);
                return false;
            }
            scheduleSpinRender(spin.stopAt);
            return true;
        }
        const refreshIcon = icon('refresh-cw');
        const refreshText = document.createTextNode('');
        refreshRoot.replaceChildren(refreshIcon, refreshText);
        function saveState() {
            if (vscode.setState) vscode.setState({ detailsOpen: Array.from(detailsOpen), allDisks: Array.from(allDisks), allScan: Array.from(allScan) });
        }
        function post(message) { vscode.postMessage(message); }
        function kib(value) { return formatBytes(Number(value || 0) * 1024, settings.byteUnits); }
        function kibPair(used, total) { return formatBytePair(Number(used || 0) * 1024, Number(total || 0) * 1024, settings.byteUnits); }
        function num(value) { const parsed = Number.parseFloat(String(value === undefined ? '' : value).replace(/[^0-9.-]/g, '')); return Number.isFinite(parsed) ? parsed : 0; }
        function mib(value) { return formatBytes(num(value) * 1048576, settings.byteUnits); }
        function mibPair(used, total) { return formatBytePair(num(used) * 1048576, num(total) * 1048576, settings.byteUnits); }
        function clock(timestamp) { return timestamp ? new Date(timestamp).toLocaleTimeString() : t('sb_never'); }
        function pct(value) { return Math.round(Math.max(0, Math.min(100, Number(value) || 0))) + '%'; }
        function meter(percent, level, label) {
            const track = node('span', 'meter lv-' + level);
            track.setAttribute('role', 'meter');
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', '100');
            track.setAttribute('aria-valuenow', String(Math.round(Number(percent) || 0)));
            if (label) track.setAttribute('aria-label', label);
            const fill = node('span', 'fill');
            fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
            track.append(fill);
            return track;
        }
        function textButton(label, handler, iconName, title) {
            const element = node('button', 'text-button');
            element.type = 'button';
            if (iconName) element.append(icon(iconName));
            element.append(document.createTextNode(label));
            if (title) element.title = title;
            element.onclick = event => { event.stopPropagation(); handler(); };
            return element;
        }
        function iconButton(name, title, handler, extraClass) {
            const element = node('button', 'icon-button' + (extraClass ? ' ' + extraClass : ''));
            element.type = 'button';
            element.title = title;
            element.setAttribute('aria-label', title);
            element.append(icon(name));
            element.onclick = event => { event.stopPropagation(); handler(); };
            return element;
        }
        function kv(pairs) {
            const list = node('dl', 'kv');
            for (const [label, value] of pairs) {
                if (value === undefined || value === null || value === '') continue;
                list.append(node('dt', '', label), node('dd', '', String(value)));
            }
            return list;
        }
        function serverState(server) {
            if (server.error) return server.lastSuccessAt ? 'stale' : 'offline';
            return server.lastSuccessAt ? 'online' : 'pending';
        }
        function stateLabel(state) {
            return t({ online: 'sb_online', stale: 'sb_stale', offline: 'sb_offline', pending: 'sb_connecting' }[state]);
        }
        function displayName(server) { return (server.metadata && server.metadata.alias) || server.host; }
        function gpuModels(gpus) {
            const counts = new Map();
            for (const gpu of gpus) counts.set(gpu.name, (counts.get(gpu.name) || 0) + 1);
            return Array.from(counts.entries()).map(([name, count]) => name + ' × ' + count).join(', ');
        }
        function gpuSubtitle(server) {
            if (server.gpuState === 'missing') {
                const cores = server.cpu && server.cpu.logicalCores;
                return t('sb_cpuOnly') + (cores ? ' · ' + cores + ' ' + t('sb_cores') : '');
            }
            if (!server.gpus.length) return server.gpuState === 'error' ? t('sb_gpuError') : '';
            const free = server.gpus.filter(gpu => gpu.availability && gpu.availability.available).length;
            return gpuModels(server.gpus) + ' · ' + free + '/' + server.gpus.length + ' ' + t('sb_gpuFree');
        }
        function errorText(server) {
            const key = 'sb_err_' + (server.errorCategory || 'unknown');
            const translated = t(key);
            return translated === key ? (server.error || t('sb_err_unknown')) : translated;
        }
        function renderBanner(server) {
            const banner = node('div', 'banner');
            banner.dataset.key = 'banner';
            banner.setAttribute('role', 'status');
            const title = node('div', 'banner-title', errorText(server));
            title.title = [server.error, server.errorDetail].filter(Boolean).join('\\n');
            banner.append(title);
            const meta = [t('sb_lastSuccess') + ' ' + clock(server.lastSuccessAt)];
            if (server.nextRetryAt) meta.push(t('sb_nextRetry') + ' ' + clock(server.nextRetryAt));
            banner.append(node('div', 'banner-meta', meta.join(' · ')));
            if (server.errorDetail && server.errorDetail !== server.error) banner.append(node('div', 'banner-meta', server.errorDetail));
            const actions = node('div', 'banner-actions');
            actions.append(textButton(t('sb_retry'), () => post({ command: 'refresh', host: server.host }), 'refresh-cw'));
            banner.append(actions);
            return banner;
        }
        function gpuTooltip(gpu) {
            const lines = [gpu.name + ' (GPU ' + gpu.index + ')',
                t('sb_util') + ': ' + gpu.utilization.gpu,
                t('sb_mem') + ': ' + mibPair(gpu.memory.used, gpu.memory.total) + ' (' + pct(num(gpu.memory.used) / Math.max(1, num(gpu.memory.total)) * 100) + ')'];
            if (gpu.temperature.gpu !== 'N/A') lines.push(t('sb_temp') + ': ' + num(gpu.temperature.gpu) + '°C');
            if (gpu.power.draw !== 'N/A') lines.push(t('sb_power') + ': ' + Math.round(num(gpu.power.draw)) + (gpu.power.limit !== 'N/A' ? ' / ' + Math.round(num(gpu.power.limit)) : '') + ' W');
            if (gpu.fanSpeed !== 'N/A') lines.push(t('sb_fan') + ': ' + gpu.fanSpeed);
            const users = Array.from(new Set(gpu.processes.map(process => process.user)));
            lines.push(t('sb_processes') + ': ' + gpu.processes.length + (users.length ? ' (' + users.join(', ') + ')' : ''));
            if (gpu.availability) lines.push(gpu.availability.available ? t('sb_available') : t('sb_busy') + ': ' + gpu.availability.reasons.join(', '));
            return lines.join('\\n');
        }
        function renderGpuRow(gpu) {
            const used = num(gpu.memory.used);
            const total = num(gpu.memory.total);
            const memoryPercent = total > 0 ? used / total * 100 : 0;
            const row = node('div', 'row gpu-row');
            row.dataset.key = 'gpu:' + (gpu.uuid !== 'N/A' ? gpu.uuid : gpu.index);
            row.title = gpuTooltip(gpu);
            const label = node('span', 'row-label');
            label.append(node('span', 'avail' + (gpu.availability && gpu.availability.available ? ' on' : '')), document.createTextNode('GPU ' + gpu.index));
            const hot = num(gpu.temperature.gpu) >= settings.temperatureWarningThreshold;
            const aside = node('span', 'aside' + (memoryPercent >= settings.memoryWarningThreshold || hot ? ' warning' : ''),
                mibPair(used, total) + (hot ? ' · ' + num(gpu.temperature.gpu) + '°C' : ''));
            // The bar matches the percentage next to it (utilization); memory is the text on the right.
            const utilization = gpu.utilization.gpu === 'N/A' ? undefined : num(gpu.utilization.gpu);
            row.append(label, node('span', 'pct', utilization === undefined ? '—' : pct(utilization)),
                meter(utilization || 0, 'neutral', t('sb_util')), aside);
            return row;
        }
        function healthLevel(percent) { return percent >= 85 ? 'warning' : 'neutral'; }
        function renderHostRows(server) {
            const rows = [];
            const cpu = server.cpu;
            if (cpu) {
                const usage = cpu.usagePercent;
                const row = node('div', 'row cpu-row');
                row.dataset.key = 'cpu';
                const lines = [cpu.model, (cpu.logicalCores || '?') + ' ' + t('sb_logical') + (cpu.physicalCores ? ' · ' + cpu.physicalCores + ' ' + t('sb_physical') : '') +
                    (cpu.availableCores && cpu.availableCores !== cpu.logicalCores ? ' · ' + cpu.availableCores + ' ' + t('sb_usableCores') : '')];
                if (usage !== undefined) lines.push(t('sb_userCpu') + ' ' + pct(cpu.userPercent) + ' · ' + t('sb_systemCpu') + ' ' + pct(cpu.systemPercent) + ' · ' +
                    t('sb_iowait') + ' ' + pct(cpu.iowaitPercent) + ' · ' + t('sb_steal') + ' ' + pct(cpu.stealPercent));
                if (cpu.load1 !== undefined) lines.push(t('sb_load') + ' ' + [cpu.load1, cpu.load5, cpu.load15].map(value => value === undefined ? '—' : value.toFixed(2)).join(' / '));
                row.title = lines.filter(Boolean).join('\\n');
                const aside = cpu.load1 !== undefined ? t('sb_load') + ' ' + cpu.load1.toFixed(1) + (cpu.logicalCores ? ' / ' + cpu.logicalCores : '') : '';
                row.append(node('span', 'row-label', t('sb_cpu')), node('span', 'pct', usage === undefined ? '—' : pct(usage)),
                    meter(usage || 0, healthLevel(usage || 0), t('sb_cpu')), node('span', 'aside', aside));
                rows.push(row);
            }
            const memory = server.memory;
            if (memory) {
                const row = node('div', 'row ram-row');
                row.dataset.key = 'ram';
                row.title = [t('sb_used') + ' ' + kib(memory.usedKiB) + ' · ' + t('sb_available') + ' ' + kib(memory.availableKiB) + (memory.availableEstimated ? ' (' + t('sb_estimated') + ')' : ''),
                    t('sb_cache') + ' ' + kib(memory.cachedKiB) + ' · ' + t('sb_total') + ' ' + kib(memory.totalKiB),
                    t('sb_swap') + ' ' + (memory.swapTotalKiB ? kibPair(memory.swapUsedKiB, memory.swapTotalKiB) : '—')].join('\\n');
                row.append(node('span', 'row-label', t('sb_ram')), node('span', 'pct', pct(memory.usedPercent)),
                    meter(memory.usedPercent, healthLevel(memory.usedPercent), t('sb_ram')), node('span', 'aside', kibPair(memory.usedKiB, memory.totalKiB)));
                rows.push(row);
                if (memory.swapTotalKiB > 0 && memory.swapPercent >= 10) {
                    const swap = node('div', 'row swap-row');
                    swap.dataset.key = 'swap';
                    swap.append(node('span', 'row-label', t('sb_swap')), node('span', 'pct', pct(memory.swapPercent)),
                        meter(memory.swapPercent, healthLevel(memory.swapPercent), t('sb_swap')), node('span', 'aside', kibPair(memory.swapUsedKiB, memory.swapTotalKiB)));
                    rows.push(swap);
                }
            }
            return rows;
        }
        function quotaPercent(quota) {
            const limit = quota.hardKiB || quota.softKiB;
            return limit ? quota.usedKiB / limit * 100 : 0;
        }
        function renderQuota(quota, label) {
            const percent = quotaPercent(quota);
            const level = quota.overSoftLimit ? 'critical' : usageLevel(percent, settings.diskWarningThreshold, settings.diskCriticalThreshold);
            const line = node('div', 'quota' + (level === 'ok' ? '' : ' ' + level));
            const limits = [quota.softKiB ? t('sb_soft') + ' ' + kib(quota.softKiB) : '', quota.hardKiB ? t('sb_hard') + ' ' + kib(quota.hardKiB) : ''].filter(Boolean).join(' · ');
            line.title = (quota.filesystem || '') + '\\n' + limits + (quota.grace ? '\\n' + t('sb_grace') + ' ' + quota.grace : '') +
                (quota.filesUsed !== undefined ? '\\nfiles ' + quota.filesUsed + (quota.filesHard ? ' / ' + quota.filesHard : '') : '');
            line.append(node('span', '', (label || t('sb_quota')) + ': ' + kibPair(quota.usedKiB, quota.hardKiB || quota.softKiB) + (quota.overSoftLimit ? ' · ' + t('sb_quotaOver') : '')),
                node('span', '', pct(percent)));
            return line;
        }
        function diskTooltip(disk) {
            return [disk.mountPoint + ' (' + disk.fsType + (disk.network ? ', ' + t('sb_network') : '') + ')', disk.source,
                t('sb_used') + ' ' + kib(disk.usedKiB) + ' · ' + t('sb_free') + ' ' + kib(disk.availKiB) + ' · ' + t('sb_total') + ' ' + kib(disk.totalKiB),
                disk.pinnedPaths.length ? t('sb_pinned') + ': ' + disk.pinnedPaths.join(', ') : '',
                disk.alsoMountedAt.length ? t('sb_alsoMounted') + ': ' + disk.alsoMountedAt.join(', ') : ''].filter(Boolean).join('\\n');
        }
        function renderDisk(server, disk) {
            const level = usageLevel(disk.usedPercent, settings.diskWarningThreshold, settings.diskCriticalThreshold);
            const item = node('div', 'disk');
            item.dataset.key = 'disk:' + disk.id;
            item.title = diskTooltip(disk);
            item.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'disk', host: server.host, mount: disk.mountPoint, preventDefaultContextMenuItems: true }));
            const line = node('div', 'disk-line');
            const mount = node('span', 'mount');
            if (disk.pinned) mount.append(icon('pin'));
            else if (disk.network) mount.append(icon('globe'));
            mount.append(node('span', 'mount-path', disk.pinned && disk.pinnedPaths[0] && disk.pinnedPaths[0] !== disk.mountPoint ? disk.pinnedPaths[0] : disk.mountPoint));
            line.append(mount, meter(disk.usedPercent, level, disk.mountPoint), node('span', 'pct', disk.usedPercent + '%'));
            const detail = node('div', 'disk-detail');
            detail.append(document.createTextNode(kibPair(disk.usedKiB, disk.totalKiB) + ' · '),
                node('span', level === 'critical' ? 'critical' : '', kib(disk.availKiB) + ' ' + t('sb_free')));
            item.append(line, detail);
            if (disk.quota) item.append(renderQuota(disk.quota));
            return item;
        }
        function renderStorage(server) {
            const section = node('div', 'section storage');
            section.dataset.key = 'storage';
            const title = node('div', 'section-title');
            title.append(icon('hard-drive'), document.createTextNode(t('sb_storage')));
            section.append(title);
            const report = server.disks;
            if (!report) {
                section.append(node('div', 'note', t('sb_waiting')));
                return section;
            }
            if (report.error) section.append(node('div', 'note ' + (report.disks.length ? 'warning' : 'error'), report.partial ? t('sb_dfPartial') : report.error));
            const showAll = allDisks.has(server.host);
            const limit = 5;
            const disks = showAll ? report.disks : report.disks.slice(0, limit);
            for (const disk of disks) section.append(renderDisk(server, disk));
            if (report.disks.length > limit) {
                const toggle = textButton(showAll ? t('sb_showLess') : '+' + (report.disks.length - limit) + ' ' + t('sb_more'), () => {
                    if (allDisks.has(server.host)) allDisks.delete(server.host); else allDisks.add(server.host);
                    saveState(); render();
                });
                toggle.dataset.key = 'more-disks';
                section.append(toggle);
            }
            return section;
        }
        function collapsedSummary(server) {
            const line = node('div', 'collapsed-line');
            line.dataset.key = 'collapsed';
            const parts = [];
            if (server.gpus.length) {
                const free = server.gpus.filter(gpu => gpu.availability && gpu.availability.available).length;
                parts.push(node('span', '', 'GPU ' + free + '/' + server.gpus.length + ' ' + t('sb_gpuFree')));
            }
            if (server.cpu && server.cpu.usagePercent !== undefined) parts.push(node('span', '', 'CPU ' + pct(server.cpu.usagePercent)));
            if (server.memory) parts.push(node('span', '', t('sb_ram') + ' ' + pct(server.memory.usedPercent)));
            const top = server.disks && server.disks.disks.reduce((worst, disk) => !worst || disk.usedPercent > worst.usedPercent ? disk : worst, undefined);
            if (top) {
                const level = usageLevel(top.usedPercent, settings.diskWarningThreshold, settings.diskCriticalThreshold);
                parts.push(node('span', level === 'ok' ? '' : level, top.mountPoint + ' ' + top.usedPercent + '%'));
            }
            parts.forEach((part, index) => { if (index) line.append(document.createTextNode(' · ')); line.append(part); });
            return line;
        }
        function formatRuntime(seconds) { return seconds ? formatDurationSeconds(seconds) : '—'; }
        function renderGpuDetails(server) {
            const wrapper = node('div', 'section');
            wrapper.dataset.key = 'gpu-details';
            for (const gpu of server.gpus) {
                const block = node('div', 'gpu-detail');
                block.dataset.key = 'gpu-detail:' + gpu.uuid;
                const head = node('div', 'gpu-detail-title');
                const facts = [num(gpu.temperature.gpu) ? num(gpu.temperature.gpu) + '°C' : '', gpu.power.draw !== 'N/A' ? Math.round(num(gpu.power.draw)) + ' W' : '',
                    gpu.fanSpeed !== 'N/A' ? t('sb_fan') + ' ' + gpu.fanSpeed : ''].filter(Boolean).join(' · ');
                head.append(node('span', '', 'GPU ' + gpu.index + ' · ' + gpu.name), node('span', '', facts));
                block.append(head);
                if (settings.showProcesses) {
                    if (!gpu.processes.length) block.append(node('div', 'note', t('sb_noProcesses')));
                    for (const process of gpu.processes.slice(0, 8)) {
                        const row = node('div', 'process');
                        row.dataset.key = 'process:' + process.pid;
                        row.title = process.command || process.name;
                        row.append(node('span', '', process.user + ' · PID ' + process.pid + (process.slurm ? ' · Slurm ' + process.slurm.id : '')),
                            node('span', 'aside', mib(process.usedMemory) + ' · ' + formatRuntime(process.elapsedSeconds)),
                            node('span', 'process-command', process.command || process.name));
                        block.append(row);
                    }
                    if (gpu.processes.length > 8) block.append(node('div', 'note', '+' + (gpu.processes.length - 8) + ' ' + t('sb_more')));
                }
                const actions = node('div', 'actions');
                actions.append(textButton(t('sb_openTerminal'), () => post({ command: 'openTerminal', host: server.host, uuid: gpu.uuid }), 'terminal'),
                    textButton(t('sb_copyCuda'), () => post({ command: 'copy', kind: 'cuda', host: server.host, uuid: gpu.uuid }), 'copy'));
                block.append(actions);
                wrapper.append(block);
            }
            return wrapper;
        }
        function renderScan(server) {
            const result = server.storage;
            const section = node('div', 'section scan');
            section.dataset.key = 'scan';
            const title = node('div', 'section-title');
            title.append(icon('folder-search'), document.createTextNode(t('sb_analyze').replace('…', '')));
            section.append(title);
            if (!result || result.state !== 'running') {
                section.append(textButton(t('sb_analyze'), () => post({ command: 'analyzeStorage', host: server.host }), 'folder-search'));
            }
            if (!result) {
                section.append(node('div', 'note', t('sb_readOnly')));
                return section;
            }
            if (result.state === 'running') {
                const running = node('div', 'actions');
                running.append(node('span', 'note', t('sb_analyzing') + ' ' + result.label), textButton(t('sb_cancel'), () => post({ command: 'cancelStorage', host: server.host }), 'x'));
                section.append(running);
                return section;
            }
            const seconds = result.finishedAt ? ((result.finishedAt - result.startedAt) / 1000).toFixed(1) + ' s' : '';
            section.append(node('div', 'note', result.label + ' · ' + clock(result.finishedAt) + (seconds ? ' · ' + seconds : '')));
            if (result.state === 'cancelled') section.append(node('div', 'note warning', t('sb_scanCancelled')));
            if (result.state === 'error') section.append(node('div', 'note error', result.error || t('sb_err_unknown')));
            if (result.timedOut) section.append(node('div', 'note warning', t('sb_scanTimedOut')));
            if (result.unreadable) section.append(node('div', 'note warning', result.unreadable + ' ' + t('sb_scanUnreadable')));
            if (result.missing && result.missing.length) section.append(node('div', 'note', t('sb_scanMissing') + ': ' + result.missing.join(', ')));
            if (result.roots && result.roots.length) {
                const total = node('div', 'scan-entry');
                total.dataset.key = 'scan-total';
                total.append(node('strong', 'scan-path', t('sb_scanTotal') + (result.filesystem ? ' (' + t('sb_onFs') + ' ' + result.filesystem.mountPoint + ', ' + kib(result.filesystem.availKiB) + ' ' + t('sb_free') + ')' : '')),
                    node('strong', '', kib(result.totalKiB)));
                section.append(total);
            }
            const largest = result.entries.length ? result.entries[0].kib : 0;
            const showAll = allScan.has(server.host);
            const entries = showAll ? result.entries : result.entries.slice(0, 12);
            for (const entry of entries) {
                const row = node('div', 'scan-entry');
                row.dataset.key = 'scan:' + entry.path;
                row.title = entry.path + '\\n' + kib(entry.kib);
                row.append(node('span', 'scan-path', entry.path), node('span', '', kib(entry.kib)), meter(largest ? entry.kib / largest * 100 : 0, 'neutral'));
                section.append(row);
            }
            const actions = node('div', 'actions');
            if (result.entries.length > 12) {
                actions.append(textButton(showAll ? t('sb_showLess') : '+' + (result.entries.length - 12) + ' ' + t('sb_more'), () => {
                    if (allScan.has(server.host)) allScan.delete(server.host); else allScan.add(server.host);
                    saveState(); render();
                }));
            }
            if (result.omitted) actions.append(node('span', 'note', result.omitted + ' ' + t('sb_scanOmitted')));
            actions.append(textButton(t('sb_clear'), () => post({ command: 'clearStorage', host: server.host }), 'x'));
            section.append(actions, node('div', 'note', t('sb_readOnly')));
            return section;
        }
        function renderDetails(server) {
            const details = node('details', 'details');
            details.dataset.key = 'details';
            details.open = detailsOpen.has(server.host);
            details.ontoggle = event => {
                if (event.currentTarget.open) detailsOpen.add(server.host); else detailsOpen.delete(server.host);
                saveState();
                if (event.currentTarget.open) render();
            };
            const summary = node('summary');
            summary.append(icon('chevron-right'), document.createTextNode(t('sb_details')));
            details.append(summary);
            if (!details.open) return details;
            if (server.gpus.length) details.append(renderGpuDetails(server));
            const cpu = server.cpu;
            const memory = server.memory;
            const system = server.system || {};
            const facts = [];
            if (cpu) {
                facts.push([t('sb_cpu'), cpu.model], [t('sb_coresTitle'), [cpu.logicalCores && cpu.logicalCores + ' ' + t('sb_logical'), cpu.physicalCores && cpu.physicalCores + ' ' + t('sb_physical'),
                    cpu.availableCores && cpu.availableCores + ' ' + t('sb_usableCores')].filter(Boolean).join(' · ')]);
                if (cpu.load1 !== undefined) facts.push([t('sb_load'), [cpu.load1, cpu.load5, cpu.load15].map(value => value === undefined ? '—' : value.toFixed(2)).join(' / ')]);
                if (cpu.usagePercent !== undefined) facts.push([t('sb_cpuTime'), t('sb_userCpu') + ' ' + pct(cpu.userPercent) + ' · ' + t('sb_systemCpu') + ' ' + pct(cpu.systemPercent) +
                    ' · ' + t('sb_iowait') + ' ' + pct(cpu.iowaitPercent) + ' · ' + t('sb_steal') + ' ' + pct(cpu.stealPercent)]);
            }
            if (memory) {
                facts.push([t('sb_ram'), kibPair(memory.usedKiB, memory.totalKiB) + ' · ' + kib(memory.availableKiB) + ' ' + t('sb_available').toLowerCase() + (memory.availableEstimated ? ' (' + t('sb_estimated') + ')' : '')],
                    [t('sb_cacheTitle'), kib(memory.cachedKiB)], [t('sb_swap'), memory.swapTotalKiB ? kibPair(memory.swapUsedKiB, memory.swapTotalKiB) + ' (' + pct(memory.swapPercent) + ')' : '—']);
            }
            facts.push([t('sb_os'), system.os], [t('sb_kernel'), system.kernel && system.kernel + (system.arch ? ' · ' + system.arch : '')], [t('sb_hostname'), system.hostname],
                [t('sb_user'), system.user], [t('sb_uptime'), system.uptimeSeconds ? formatDurationSeconds(system.uptimeSeconds) : ''],
                [t('sb_latency'), server.latencyMs ? server.latencyMs + ' ms · ' + (server.multiplexed ? t('sb_connShared') : t('sb_connNew')) : '']);
            const updated = server.updatedAt || {};
            facts.push([t('sb_lastUpdated'), ['gpu', 'cpu', 'memory', 'disk'].filter(key => updated[key]).map(key => key.toUpperCase() + ' ' + clock(updated[key])).join(' · ')]);
            const list = kv(facts);
            list.dataset.key = 'facts';
            details.append(list);
            const report = server.disks;
            if (report) {
                const extra = node('div', 'section');
                extra.dataset.key = 'disk-extra';
                if (report.hidden.length) extra.append(node('div', 'note', report.hidden.length + ' ' + t('sb_hiddenFs') + ': ' + report.hidden.map(item => item.mountPoint).join(', ')));
                if (report.missingPinnedPaths.length) extra.append(node('div', 'note warning', t('sb_missingPins') + ': ' + report.missingPinnedPaths.join(', ')));
                for (const quota of report.otherQuotas) extra.append(renderQuota(quota, t('sb_quota') + ' ' + (quota.mountPoint || quota.filesystem)));
                if (extra.childNodes.length) details.append(extra);
            }
            details.append(renderScan(server));
            return details;
        }
        function renderCard(server) {
            const state = serverState(server);
            const isCollapsed = collapsed.has(server.host);
            const card = node('section', 'card state-' + state + (isCollapsed ? ' collapsed' : '') + (state === 'stale' ? ' stale-data' : '') +
                (spinning('host:' + server.host, Boolean(server.refreshing)) ? ' refreshing' : ''));
            card.dataset.key = 'host:' + server.host;
            card.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'server', host: server.host, preventDefaultContextMenuItems: true }));
            const head = node('div', 'card-head');
            const toggle = node('button', 'card-toggle');
            toggle.type = 'button';
            toggle.setAttribute('aria-expanded', String(!isCollapsed));
            toggle.title = (server.metadata && server.metadata.alias ? server.metadata.alias + ' (' + server.host + ')' : server.host) + ' · ' + (isCollapsed ? t('sb_expand') : t('sb_collapse'));
            toggle.append(node('span', 'chevron', ''), node('span', 'dot'), node('span', 'name', displayName(server)), node('span', 'state-label', stateLabel(state)));
            toggle.firstChild.append(icon('chevron-right'));
            toggle.onclick = () => {
                if (collapsed.has(server.host)) collapsed.delete(server.host); else collapsed.add(server.host);
                post({ command: 'setCollapsed', host: server.host, collapsed: collapsed.has(server.host) });
                render();
            };
            head.append(toggle, iconButton('refresh-cw', t('sb_refreshServer'), () => post({ command: 'refresh', host: server.host }), 'refresh'));
            card.append(head);
            const subtitle = gpuSubtitle(server) + (server.duplicateOf ? ' · ' + t('sb_sameHost') + ' ' + server.duplicateOf : '');
            if (isCollapsed) {
                if (server.lastSuccessAt) card.append(collapsedSummary(server));
                return card;
            }
            if (subtitle) {
                const sub = node('div', 'sub', subtitle);
                sub.dataset.key = 'sub';
                sub.title = subtitle;
                card.append(sub);
            }
            if (server.error) card.append(renderBanner(server));
            if (!server.lastSuccessAt) {
                if (!server.error) {
                    const waiting = node('div', 'body');
                    waiting.dataset.key = 'body';
                    waiting.append(node('div', 'note', t('sb_waiting')));
                    card.append(waiting);
                }
                return card;
            }
            const body = node('div', 'body');
            body.dataset.key = 'body';
            if (server.gpus.length) {
                const gpus = node('div', 'section gpus');
                gpus.dataset.key = 'gpus';
                server.gpus.forEach(gpu => gpus.append(renderGpuRow(gpu)));
                body.append(gpus);
            }
            if (server.gpuState === 'error') body.append(node('div', 'note warning', t('sb_gpuError') + ': ' + (server.gpuError || '')));
            const host = node('div', 'section host');
            host.dataset.key = 'host-rows';
            renderHostRows(server).forEach(row => host.append(row));
            if (host.childNodes.length) body.append(host);
            body.append(renderStorage(server), renderDetails(server));
            card.append(body);
            return card;
        }
        function renderSummary() {
            const list = order.map(host => servers.get(host)).filter(Boolean);
            const online = list.filter(server => !server.error && server.lastSuccessAt).length;
            const unique = list.filter(server => !server.error && !server.duplicateOf);
            const gpus = unique.flatMap(server => server.gpus);
            const free = gpus.filter(gpu => gpu.availability && gpu.availability.available).length;
            const full = list.flatMap(server => (server.disks && !server.error ? server.disks.disks : [])).filter(disk => disk.usedPercent >= settings.diskCriticalThreshold).length;
            const parts = [online + '/' + list.length + ' ' + t('sb_serversOnline')];
            if (gpus.length) parts.push(t('sb_gpuSummary') + ' ' + free + '/' + gpus.length + ' ' + t('sb_gpuFree'));
            const fragment = document.createDocumentFragment();
            fragment.append(document.createTextNode(parts.join(' · ')));
            if (full) {
                fragment.append(document.createTextNode(' · '));
                fragment.append(node('span', 'warn', t('sb_disksFull') + ': ' + full));
            }
            summaryRoot.replaceChildren(fragment);
            // Background rounds run all the time with many servers; only a user-requested refresh spins.
            const manualBusy = (activity.manual || 0) > 0;
            refreshRoot.classList.toggle('busy', spinning('topbar', manualBusy));
            const newest = Math.max(0, ...list.map(server => server.lastSuccessAt || 0));
            const label = manualBusy ? t('sb_refreshing')
                : newest ? t('sb_updated') + ' ' + new Date(newest).toLocaleTimeString() : (automatic ? '' : t('sb_manual'));
            if (refreshText.nodeValue !== label) refreshText.nodeValue = label;
            const title = automatic ? '' : t('sb_manual');
            if (refreshRoot.title !== title) refreshRoot.title = title;
        }
        function renderEmpty() {
            const title = node('h2', '', t('sb_emptyTitle'));
            const body = node('p', '', t('sb_emptyBody'));
            const actions = node('div', 'actions');
            actions.append(textButton(t('sb_addServer'), () => post({ command: 'addServer' }), 'plug'),
                textButton(t('sb_chooseServers'), () => post({ command: 'configureServers' }), 'server'));
            emptyRoot.replaceChildren(title, body, actions);
        }
        function render() {
            document.documentElement.lang = language;
            const hasServers = order.length > 0;
            emptyRoot.hidden = hasServers || !received;
            if (!hasServers && received) renderEmpty();
            const fragment = document.createDocumentFragment();
            for (const host of order) {
                const server = servers.get(host);
                if (server) fragment.append(renderCard(server));
            }
            patchChildren(cardsRoot, fragment);
            renderSummary();
        }
        window.addEventListener('message', event => {
            const message = event.data;
            if (!message || typeof message !== 'object') return;
            if (message.type === 'state') {
                received = true;
                language = message.language === 'zh-CN' ? 'zh-CN' : 'en';
                if (message.settings) settings = message.settings;
                if (Array.isArray(message.order)) order = message.order;
                if (Array.isArray(message.collapsed)) collapsed = new Set(message.collapsed);
                if (message.full) servers.clear();
                for (const server of message.servers || []) servers.set(server.host, server);
                for (const host of Array.from(servers.keys())) if (!order.includes(host)) servers.delete(host);
                if (message.activity) activity = message.activity;
                if (typeof message.automatic === 'boolean') automatic = message.automatic;
                render();
            } else if (message.type === 'activity') {
                activity = message.activity || activity;
                for (const server of servers.values()) server.refreshing = (message.refreshing || []).includes(server.host);
                render();
            } else if (message.type === 'collapse') {
                collapsed = new Set(message.all ? order : []);
                render();
            }
        });
        post({ command: 'ready' });
    `;
}
