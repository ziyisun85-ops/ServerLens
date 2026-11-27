// ServerLens sidebar webview test (jsdom): states, thresholds, in-place updates, collapse,
// details, storage results, escaping and the empty state.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const sample = require('./sidebarPreviewData');

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

async function main() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'preview', 'sidebar-dark.html'), 'utf8');
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error));
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
    await tick(100);
    const { document } = dom.window;
    const send = async message => { dom.window.postMessage(message, '*'); await tick(); };
    const card = host => document.querySelector(`[data-key="host:${host}"]`);
    const messages = () => dom.window.__messages || [];

    assert.deepStrictEqual(errors, []);
    assert.ok(messages().some(message => message.command === 'ready'), 'The view asks for data when it loads.');
    assert.strictEqual(document.querySelectorAll('.card').length, 6);
    assert.ok(card('gpu-node-1').classList.contains('state-online'));
    assert.strictEqual(card('gpu-node-1').querySelectorAll('.gpu-row').length, 4);
    assert.ok(card('gpu-node-1').querySelector('.cpu-row') && card('gpu-node-1').querySelector('.ram-row'));
    assert.match(card('gpu-node-1').querySelector('.sub').textContent, /RTX 4090 × 4/);
    assert.match(card('gpu-node-1').querySelector('.gpu-row .aside').textContent, /4\.2 \/ 24 GiB/);
    assert.ok(card('gpu-node-1').querySelector('.gpu-row').title.includes('Temp'), 'Hovering a GPU row shows its details.');

    const levelOf = (host, mount) => {
        const disk = card(host).querySelector(`[data-key="disk:${mount}"] .meter`);
        return ['ok', 'warning', 'critical'].find(level => disk.classList.contains('lv-' + level));
    };
    assert.strictEqual(levelOf('gpu-node-1', '/data'), 'critical', '93 % is red.');
    assert.strictEqual(levelOf('gpu-node-1', '/'), 'ok', '41 % is green.');
    assert.strictEqual(levelOf('a6000-east', '/scratch'), 'warning', '75 % is yellow.');
    assert.match(card('gpu-node-1').querySelector('[data-key="disk:/data"] .disk-detail').textContent, /7\.44 \/ 8 TiB · 573 GiB free/);
    assert.match(card('gpu-node-1').querySelector('[data-key="disk:/home"] .quota').textContent, /Quota: 180 \/ 550 GiB/);
    assert.match(card('a6000-east').querySelector('.quota').textContent, /over soft limit/);
    assert.ok(card('a6000-east').querySelector('.quota').classList.contains('critical'));
    assert.ok(card('gpu-node-1').querySelector('[data-key="disk:/data"]').title.includes('/home/alice/data'), 'Merged mount points are listed on hover.');
    assert.strictEqual(JSON.parse(card('gpu-node-1').querySelector('[data-key="disk:/data"]').getAttribute('data-vscode-context')).mount, '/data');

    assert.strictEqual(card('cpu-node-01').querySelectorAll('.gpu-row').length, 0);
    assert.match(card('cpu-node-01').querySelector('.sub').textContent, /CPU only · 128 cores/);
    assert.ok(card('cpu-node-01').querySelector('.swap-row'), 'Swap appears when it is in real use.');
    assert.ok(card('gpu-node-2').classList.contains('state-stale') && card('gpu-node-2').classList.contains('stale-data'));
    assert.match(card('gpu-node-2').querySelector('.banner').textContent, /Server unreachable.*Last success/s);
    assert.strictEqual(card('gpu-node-2').querySelectorAll('.gpu-row').length, 8, 'Stale cards keep the last data, dimmed.');
    assert.ok(card('new-node').classList.contains('state-offline'));
    assert.match(card('new-node').querySelector('.banner').textContent, /authentication failed.*never/si);
    assert.strictEqual(card('new-node').querySelector('.body'), null);
    assert.ok(card('v100-cluster').classList.contains('collapsed'));
    assert.match(card('v100-cluster').querySelector('.collapsed-line').textContent, /GPU 1\/4 free · CPU 76% · RAM 76% · \/data 69%/);
    assert.match(document.getElementById('fleet-summary').textContent, /4\/6 online · GPU 3\/10 free · Full disks: 1/);

    // Background updates mutate values in place: no flicker, no lost focus or scroll position.
    const cardNode = card('gpu-node-1');
    const rowNode = cardNode.querySelector('.gpu-row');
    const updated = clone(sample.servers[0]);
    updated.gpus[0].utilization.gpu = '55 %';
    await send({ type: 'state', servers: [updated], order: sample.order, collapsed: sample.collapsed });
    assert.strictEqual(card('gpu-node-1'), cardNode, 'The card element is reused.');
    assert.strictEqual(cardNode.querySelector('.gpu-row'), rowNode, 'GPU rows are reused.');
    assert.strictEqual(rowNode.querySelector('.pct').textContent, '55%');
    assert.strictEqual(rowNode.querySelector('.fill').style.width, '55%');

    const boundaries = clone(sample.servers[2]);
    boundaries.disks.disks = [69, 70, 89, 90].map(percent => ({ ...boundaries.disks.disks[0], id: '/b' + percent, mountPoint: '/b' + percent,
        usedKiB: percent, availKiB: 100 - percent, totalKiB: 100, usedPercent: percent }));
    await send({ type: 'state', servers: [boundaries], order: sample.order });
    assert.deepStrictEqual(['/b69', '/b70', '/b89', '/b90'].map(mount => levelOf('cpu-node-01', mount)), ['ok', 'warning', 'warning', 'critical'],
        'Green below 70 %, yellow from 70 % to below 90 %, red from 90 %.');
    await send({ type: 'state', settings: { ...sample.settings, diskWarningThreshold: 50, diskCriticalThreshold: 80 }, servers: [], order: sample.order });
    assert.deepStrictEqual(['/b69', '/b89'].map(mount => levelOf('cpu-node-01', mount)), ['warning', 'critical'], 'Thresholds follow the settings.');
    await send({ type: 'state', settings: sample.settings, servers: [], order: sample.order });

    cardNode.querySelector('.card-toggle').click();
    await tick();
    assert.ok(card('gpu-node-1').classList.contains('collapsed'));
    assert.strictEqual(card('gpu-node-1'), cardNode, 'Collapsing keeps the same card element.');
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'setCollapsed', host: 'gpu-node-1', collapsed: true });
    assert.ok(card('gpu-node-1').querySelector('.collapsed-line'));
    cardNode.querySelector('.card-toggle').click();
    await tick();

    const details = card('gpu-node-1').querySelector('details.details');
    details.open = true;
    details.dispatchEvent(new dom.window.Event('toggle'));
    await tick();
    const openDetails = card('gpu-node-1').querySelector('details.details');
    assert.strictEqual(openDetails.querySelectorAll('.process').length, 4, 'Details list the GPU processes.');
    assert.ok(openDetails.querySelector('.process').title.includes('llama-7b.yaml'), 'Full commands are available on hover.');
    assert.match(openDetails.querySelector('.kv').textContent, /AMD EPYC 7763/);
    assert.match(openDetails.textContent, /2 filesystems hidden/);
    const scanRows = openDetails.querySelectorAll('.scan-entry');
    assert.match(scanRows[0].textContent, /Total.*402 GiB/s);
    assert.match(scanRows[1].textContent, /~\/checkpoints.*212 GiB/s, 'Largest folders first.');
    assert.match(openDetails.textContent, /2 unreadable folders skipped/);
    assert.match(openDetails.textContent, /Read-only analysis/);
    openDetails.querySelector('.scan .text-button').click();
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'analyzeStorage', host: 'gpu-node-1' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(dom.window.__previewState.detailsOpen)), ['gpu-node-1'], 'Open details survive the view being hidden.');

    const running = clone(sample.servers[0]);
    running.storage = { ...running.storage, state: 'running', entries: [], roots: [] };
    await send({ type: 'state', servers: [running], order: sample.order });
    const cancel = Array.from(card('gpu-node-1').querySelectorAll('.scan .text-button')).find(button => button.textContent === 'Cancel');
    assert.ok(cancel, 'A running scan can be cancelled.');
    cancel.click();
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'cancelStorage', host: 'gpu-node-1' });

    card('gpu-node-2').querySelector('.banner .text-button').click();
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'refresh', host: 'gpu-node-2' });
    card('cpu-node-01').querySelector('.icon-button.refresh').click();
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'refresh', host: 'cpu-node-01' });
    // Background rounds run constantly with many servers: they must not spin anything.
    const topIcon = document.querySelector('#refresh-state .icon');
    await send({ type: 'activity', activity: { running: 5, queued: 3, total: 6, manual: 0 }, refreshing: [] });
    assert.ok(!document.getElementById('refresh-state').classList.contains('busy'), 'Background collection does not spin the top icon.');
    assert.strictEqual(document.querySelectorAll('.card.refreshing').length, 0, 'Background collection does not spin any card.');
    await send({ type: 'activity', activity: { running: 1, queued: 0, total: 6, manual: 1 }, refreshing: ['cpu-node-01'] });
    assert.ok(card('cpu-node-01').classList.contains('refreshing'), 'A refresh the user asked for spins its card.');
    assert.ok(document.getElementById('refresh-state').classList.contains('busy'));
    assert.match(document.getElementById('refresh-state').textContent, /Refreshing/);
    const refreshingServer = clone(sample.servers[2]);
    refreshingServer.refreshing = true;
    for (let round = 0; round < 5; round += 1) {
        await send({ type: 'state', servers: [refreshingServer], order: sample.order });
    }
    assert.strictEqual(document.querySelector('#refresh-state .icon'), topIcon, 'Updates never replace the spinning icon (that restarted its rotation).');
    const cardIcon = card('cpu-node-01').querySelector('.icon-button.refresh .icon');
    await send({ type: 'activity', activity: { running: 0, queued: 0, total: 6, manual: 0 }, refreshing: [] });
    assert.ok(card('cpu-node-01').classList.contains('refreshing'), 'A finished refresh keeps turning to the end of the current turn...');
    assert.strictEqual(card('cpu-node-01').querySelector('.icon-button.refresh .icon'), cardIcon, 'The card icon is not recreated either.');
    await tick(1300);
    assert.ok(!card('cpu-node-01').classList.contains('refreshing'), '...and then stops.');
    assert.ok(!document.getElementById('refresh-state').classList.contains('busy'));
    assert.match(document.getElementById('refresh-state').textContent, /Updated/);

    const hostile = clone(sample.servers[2]);
    hostile.metadata = { alias: '<img src=x onerror="window.__pwned=1">' };
    hostile.disks.disks[0].mountPoint = '/mnt/<b>bold</b>';
    hostile.disks.disks[0].id = '/mnt/<b>bold</b>';
    await send({ type: 'state', servers: [hostile], order: sample.order });
    assert.strictEqual(document.querySelectorAll('.card img, .card b').length, 0, 'Server data is rendered as text, never as HTML.');
    assert.strictEqual(dom.window.__pwned, undefined);
    assert.ok(card('cpu-node-01').querySelector('.name').textContent.startsWith('<img'));

    await send({ type: 'state', language: 'zh-CN', servers: [], order: sample.order });
    assert.strictEqual(card('gpu-node-1').querySelector('.state-label').textContent, '在线');
    assert.match(card('gpu-node-1').querySelector('.section-title').textContent, /存储/);
    await send({ type: 'state', language: 'en', full: true, servers: [], order: [] });
    assert.strictEqual(document.querySelectorAll('.card').length, 0);
    assert.strictEqual(document.getElementById('empty').hidden, false, 'With no servers the view explains how to add one.');
    document.querySelector('#empty .text-button').click();
    assert.deepStrictEqual(clone(messages().at(-1)), { command: 'addServer' });
    assert.deepStrictEqual(errors, []);
    console.log('Sidebar cards: states, thresholds, in-place updates, collapse, details, storage results, escaping and empty state passed.');
    dom.window.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
