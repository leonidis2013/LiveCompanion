'use strict';
/*
 * Tests for development mode (Claude and the central Companion). Loaded by test/run.js.
 * A pretend Companion 5 (lib/claude/fake-companion.js) answers both in memory and over a
 * real WebSocket + HTTP server, so the client, the tools and the whole server are tested.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const Fake = R('lib/claude/fake-companion'), Tools = R('lib/claude/tools'), Backups = R('lib/claude/backups'), Companion = R('lib/companion');
const Mcp = R('lib/claude/mcp'), Net = R('lib/claude/netsec'), OAuth = R('lib/claude/oauth'), Totp = R('lib/claude/totp'), QR = R('lib/claude/qr'), Secrets = R('lib/secrets');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-' + p + '-'));
const b64sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const LEVELS = { read: {}, build: { edit: true }, hands: { edit: true, press: true }, full: { edit: true, press: true, delete: true } };

function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function req(port, method, p, body, headers) {
  const res = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, j, text, headers: res.headers };
}
function toolsWith(level, opts) {
  opts = opts || {};
  const core = Fake.create(), companion = Fake.client(core), changes = [];
  const access = Object.assign({ level, enabled: true, protectedPages: opts.protectedPages || [] }, LEVELS[level]);
  const backups = Backups.create({ dir: tmp('cbk'), keep: 5 });
  const t = Tools.create({ companion, backups, access: () => access, onChange: (info) => { changes.push(info); return 'reviewed'; }, pressMs: 1 });
  const call = async (name, args, acc) => { const r = await t.call(name, args || {}, acc || null, { label: 'test' }); let j = null; try { j = JSON.parse(r.text); } catch (e) { /* text */ } return Object.assign(r, { j }); };
  return { t, core, call, changes, backups, access };
}

// ---------- a pretend Companion over a real WebSocket (RFC 6455) and HTTP ----------
function fakeCompanionServer(opts = {}) {
  const core = Fake.create();
  const seen = { origins: [], stops: 0, pongs: 0, frames: [] };
  const server = http.createServer((q, res) => {
    let r;
    try { r = core.http(q.method, q.url); } catch (e) { res.writeHead(e.status || 500); return res.end(e.message); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(JSON.stringify(r));
  });
  const socks = new Set();
  server.on('upgrade', (q, sock) => {
    if (q.url.split('?')[0] !== '/trpc') { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    seen.origins.push(q.headers.origin);
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    const accept = crypto.createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const sendText = (t) => {
      const p = Buffer.from(t);
      const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
      sock.write(Buffer.concat([head, p]));
    };
    const send = (o) => sendText(JSON.stringify(o));
    if (opts.ping) setTimeout(() => sendText('PING'), 20);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        if (op !== 1) continue;
        const text = data.toString('utf8');
        seen.frames.push(text);
        if (text === 'PONG') { seen.pongs++; continue; }
        const m = JSON.parse(text);
        if (m.method === 'subscription.stop') { seen.stops++; send({ id: m.id, result: { type: 'stopped' } }); continue; }
        if (opts.silent && m.params.path === opts.silent) continue;
        if (opts.dropOn && m.params.path === opts.dropOn) { sock.destroy(); continue; }
        try {
          const data2 = core.handle(m.method, m.params.path, m.params.input);
          if (m.method === 'subscription') { send({ id: m.id, result: { type: 'started' } }); setTimeout(() => send({ id: m.id, result: { type: 'data', data: data2 } }), 5); }
          else send({ id: m.id, result: { type: 'data', data: data2 } });
        } catch (e) { send({ id: m.id, error: { message: e.message, code: -32603, data: { code: e.trpcCode || 'INTERNAL_SERVER_ERROR' } } }); }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ core, seen, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { socks.forEach((x) => x.destroy()); server.closeAllConnections(); server.close(() => r()); setTimeout(r, 500).unref(); }) })));
}

module.exports = function register(test) {

  test('companion client: tRPC over a real WebSocket, PING/PONG, subscriptions stop, errors, HTTP', async () => {
    const f = await fakeCompanionServer({ ping: true });
    const c = Companion.create({ getUrl: () => f.url });
    try {
      assert.strictEqual((await c.query('appInfo.version')).appVersion, '5.1.1');
      const pages = await c.snapshot('pages.watch');
      assert.strictEqual(pages.type, 'init');
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(f.seen.stops >= 1, 'a subscription is stopped once its first message arrived');
      assert.ok(f.seen.pongs >= 1, 'answers Companion\'s PING with PONG');
      assert.ok(f.seen.origins.every((o) => o === undefined), 'sends no Origin, so Companion\'s origin check lets it in');
      assert.strictEqual(f.seen.origins.length, 1, 'calls share one connection');
      await assert.rejects(c.query('nope.nothing'), /Companion refused nope\.nothing.*NOT_FOUND/);
      assert.strictEqual(await c.mutate('customVariables.setCurrent', { name: 'service_live', value: '1' }), null);
      assert.strictEqual(f.core.state().customValues.service_live, '1');
      const all = await c.http('GET', '/int/export/custom?format=json');
      assert.strictEqual(all.type, 'full');
      await assert.rejects(c.http('GET', '/int/export/page/99?format=json'), /answered 404/);
    } finally { c.close(); await f.close(); }
    // a call Companion never answers times out; a dropped connection fails what was waiting
    const g = await fakeCompanionServer({ silent: 'appInfo.version', dropOn: 'pages.watch' });
    const c2 = Companion.create({ getUrl: () => g.url });
    try {
      await assert.rejects(c2.query('appInfo.version', undefined, { timeoutMs: 200 }), /did not answer appInfo\.version in time/);
      await assert.rejects(c2.snapshot('pages.watch'), /closed the connection/);
      assert.strictEqual((await c2.query('userConfig.getConfig')).gridSize.maxRow, 3, 'connects again afterwards');
    } finally { c2.close(); await g.close(); }
    const c3 = Companion.create({ getUrl: () => 'http://127.0.0.1:1' });
    await assert.rejects(c3.query('appInfo.version'), /Could not connect to Companion/);
    const c4 = Companion.create({ getUrl: () => '' });
    await assert.rejects(c4.query('appInfo.version'), /not set up/);
  });

  test('tools: the real client and the tools against a pretend Companion over the network', async () => {
    const f = await fakeCompanionServer();
    const c = Companion.create({ getUrl: () => f.url });
    const access = Object.assign({ level: 'build', enabled: true, protectedPages: [] }, LEVELS.build);
    const t = Tools.create({ companion: c, backups: Backups.create({ dir: tmp('net'), keep: 3 }), access: () => access, onChange: () => 'reviewed' });
    try {
      const big = 'x'.repeat(300 * 1024); // more than one upload chunk
      const r = await t.call('save_button', { page: 3, row: 3, column: 7, text: 'BIG', press_actions: [{ connection: 'propresenter', action: 'trigger_playlist', options: { playlist: big } }] }, null, {});
      assert.ok(!r.isError, r.text);
      const saved = f.core.state().pages[2].controls[3][7];
      assert.strictEqual(saved.steps[0].action_sets.down[0].options.playlist.value.length, big.length, 'uploaded in chunks with a checksum, and kept whole');
      assert.strictEqual(f.core.state().pages[2].controls[0][1].style.layers[2].text.value, 'PASTOR MIC', 'the rest of the page is untouched');
      assert.ok((await t.probe()).version === '5.1.1');
    } finally { c.close(); await f.close(); }
  });

  test('tools: read tools describe pages, buttons, triggers, connections, variables, the log', async () => {
    const { call, t } = toolsWith('read');
    assert.deepStrictEqual(t.list().map((x) => x.name).filter((n) => /save|press|delete|run|set_/.test(n)), [], 'Look only lists no change tools');
    const ov = await call('get_overview');
    assert.strictEqual(ov.j.companion.version, '5.1.1');
    assert.deepStrictEqual(ov.j.connections.with_problems.map((x) => x.label).sort(), ['obs', 'sq5']);
    assert.ok(ov.j.recent_log_problems.some((l) => /ETIMEDOUT/.test(l.message)));
    const pg = await call('get_page', { page: 1 });
    const sermon = pg.j.buttons.find((b) => b.text === 'SERMON');
    assert.deepStrictEqual([sermon.row, sermon.column], [0, 2]);
    assert.deepStrictEqual(sermon.does, ['atem program', 'sq5 mute_on']);
    const b = await call('get_button', { page: 1, row: 0, column: 2, raw: true });
    assert.strictEqual(b.j.steps[0].down[1].options.channel, 12);
    assert.strictEqual(b.j.feedbacks[0].style_when_true[0].color, '#cc0000');
    assert.strictEqual(b.j.raw.type, 'button-layered');
    assert.ok((await call('get_button', { page: 1, row: 3, column: 7 })).j.empty);
    const found = await call('find_buttons', { query: 'sq5 mute' });
    assert.deepStrictEqual(found.j.map((x) => x.location).sort(), ['1/0/2', '1/0/3', '3/0/1']);
    const tr = await call('get_trigger', { id: 't_count' });
    assert.strictEqual(tr.j.events[0].type, 'timeofday');
    assert.strictEqual(tr.j.actions[0].connection, 'propresenter');
    assert.ok((await call('list_connections', { problems_only: true })).j.every((x) => x.status !== 'ok'));
    const defs = await call('get_connection_definitions', { connection: 'ATEM', search: 'program' });
    assert.ok(defs.j.items.some((x) => x.id === 'program'), 'labels match without case');
    assert.deepStrictEqual((await call('get_connection_definitions', { connection: 'atem', id: 'program' })).j.options.map((o) => o.id), ['mixeffect', 'input']);
    assert.strictEqual((await call('get_variables', { source: 'atem' })).j['$(atem:pgm1_input)'].value, '1');
    assert.strictEqual((await call('list_custom_variables')).j[0].name, 'service_live');
    assert.ok(/ERROR Instance\/sq5/.test((await call('get_log', { level: 'error' })).text));
    assert.ok((await call('list_trigger_event_types')).j.some((e) => e.type === 'timeofday'));
    assert.ok((await call('get_page', { page: 9 })).isError);
  });

  test('tools: buttons are built simply, checked, written page-whole and reverted', async () => {
    const { call, core, changes, t, backups } = toolsWith('full');
    const r = await call('save_button', { page: 2, row: 2, column: 3, text: 'CAM 5', background: '#202020', press_actions: [{ connection: 'atem', action: 'program', options: { input: 5 } }], feedbacks: [{ connection: 'atem', feedback: 'program_tally', options: { input: 5 }, style_when_true: { background: 'red' } }] });
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.j.review, 'reviewed');
    const ctl = core.state().pages[1].controls[2][3];
    const act = ctl.steps[0].action_sets.down[0];
    assert.deepStrictEqual([act.connectionId, act.definitionId, act.options.input, act.options.mixeffect], ['c_atem', 'program', { value: 5, isExpression: false }, { value: 0, isExpression: false }], 'label mapped to id, missing options from their defaults');
    assert.strictEqual(act.upgradeIndex, 3, 'the connection\'s upgrade index, so Companion does not re-run its upgrades');
    assert.strictEqual(ctl.feedbacks[0].styleOverrides[0].override.value, 0xff0000);
    assert.strictEqual(core.state().imports, 1);
    // change keeps what was not mentioned
    await call('save_button', { page: 2, row: 0, column: 1, text: 'WIDE' });
    const cam1 = core.state().pages[1].controls[0][1];
    assert.strictEqual(cam1.style.layers.find((l) => l.type === 'text').text.value, 'WIDE');
    assert.strictEqual(cam1.steps[0].action_sets.down[0].definitionId, 'program', 'actions kept');
    // checked before anything is written
    assert.ok(/no action "nope"/.test((await call('save_button', { page: 2, row: 3, column: 3, press_actions: [{ connection: 'atem', action: 'nope' }] })).text));
    assert.ok(/Unknown connection "videohub"/.test((await call('save_button', { page: 2, row: 3, column: 3, press_actions: [{ connection: 'videohub', action: 'x' }] })).text));
    assert.ok(/outside Companion's grid/.test((await call('save_button', { page: 2, row: 9, column: 3, text: 'x' })).text));
    const typo = await call('save_button', { page: 2, row: 3, column: 3, press_actions: [{ connection: 'atem', action: 'program', options: { inptu: 2 } }] });
    assert.ok(typo.j.notes.some((n) => /no option "inptu"/.test(n)), 'a typo in an option is pointed out');
    // full config round trip (what get_button raw returns, back in)
    const raw = (await call('get_button', { page: 1, row: 0, column: 2, raw: true })).j.raw;
    raw.steps[0].action_sets.down[0].connectionId = 'atem';
    assert.ok(!(await call('save_button', { page: 2, row: 3, column: 0, config: raw })).isError);
    assert.strictEqual(core.state().pages[1].controls[3][0].steps[0].action_sets.down[0].connectionId, 'c_atem');
    // copy
    assert.ok(!(await call('copy_button', { from_page: 1, from_row: 0, from_column: 1, to_page: 3, to_row: 1, to_column: 1 })).isError);
    assert.strictEqual(Tools.buttonText(core.state().pages[2].controls[1][1]), 'WALK IN');
    // revert: changed -> back; created -> gone; deleted -> back
    const changed = changes.find((c) => c.id === 'p2r0c1');
    await t.revert(Object.assign({ action: 'changed' }, changed));
    assert.strictEqual(Tools.buttonText(core.state().pages[1].controls[0][1]), 'CAM 1');
    await t.revert(Object.assign({ action: 'created' }, changes.find((c) => c.id === 'p2r2c3')));
    assert.ok(!core.state().pages[1].controls[2] || !core.state().pages[1].controls[2][3]);
    assert.ok(!(await call('delete_button', { page: 3, row: 0, column: 1 })).isError);
    assert.ok(!core.state().pages[2].controls[0][1]);
    await t.revert(Object.assign({ action: 'deleted' }, changes[changes.length - 1]));
    assert.strictEqual(Tools.buttonText(core.state().pages[2].controls[0][1]), 'PASTOR MIC');
    assert.strictEqual(core.state().pages[2].controls[0][1].steps[0].action_sets.down[0].connectionId, 'c_sq', 'actions come back too');
    // backups, and restoring one
    const list = backups.list();
    assert.ok(list.some((b) => b.kind === 'button' && b.reason === 'before-delete'));
    const bk = list.find((b) => b.id === 'p2r0c1' && b.reason === 'before-change');
    await call('save_button', { page: 2, row: 0, column: 1, text: 'AGAIN' });
    await t.restore('button', 'p2r0c1', backups.read('button', 'p2r0c1', bk.file).config);
    assert.strictEqual(Tools.buttonText(core.state().pages[1].controls[0][1]), 'CAM 1');
    // no connection was ever created by an import
    assert.deepStrictEqual(Object.keys(core.state().connections).sort(), ['c_atem', 'c_obs', 'c_pro', 'c_sq']);
  });

  test('tools: protected pages are read-only at every level, including actions aimed at them', async () => {
    const { call, core } = toolsWith('full', { protectedPages: [1] });
    assert.ok(!(await call('get_page', { page: 1 })).isError, 'reading is fine');
    for (const [name, args] of [['save_button', { page: 1, row: 3, column: 3, text: 'x' }], ['press_button', { page: 1, row: 0, column: 2 }], ['delete_button', { page: 1, row: 0, column: 2 }], ['save_page', { page: 1, name: 'x' }], ['copy_button', { from_page: 2, from_row: 0, from_column: 1, to_page: 1, to_row: 3, to_column: 3 }]]) {
      const r = await call(name, args);
      assert.ok(r.isError && /protected/.test(r.text), name + ': ' + r.text);
    }
    const sneaky = await call('save_button', { page: 2, row: 3, column: 3, press_actions: [{ connection: 'internal', action: 'button_pressrelease', options: { location: '1/0/2' } }] });
    assert.ok(sneaky.isError && /page 1/.test(sneaky.text), 'a button that would press a protected button is refused');
    const trig = await call('save_trigger', { name: 'x', actions: [{ connection: 'internal', action: 'set_page', options: { page: 1 } }] });
    assert.ok(trig.isError && /protected/.test(trig.text));
    assert.strictEqual(core.state().imports, 0, 'nothing was written');
    assert.strictEqual(core.state().presses.length, 0);
  });

  test('tools: triggers, custom variables, pages; pressing and running need Hands on', async () => {
    const b = toolsWith('build');
    assert.ok(!b.t.list().some((x) => x.name === 'press_button' || x.name === 'delete_button'));
    const r = await b.call('save_trigger', { name: 'Preview cam 2', events: [{ type: 'interval', options: { seconds: 30 } }], actions: [{ connection: 'atem', action: 'preview', options: { input: 2 } }], enabled: true });
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.j.enabled, false, 'below Hands on a trigger is saved switched off');
    assert.ok(r.j.notes.some((n) => /Hands on/.test(n)));
    const id = r.j.saved, tr = b.core.state().triggers[id];
    assert.strictEqual(tr.events[0].options.seconds, 30);
    assert.strictEqual(tr.actions[0].connectionId, 'c_atem');
    assert.ok(/Unknown event type/.test((await b.call('save_trigger', { name: 'x', events: [{ type: 'whenever' }] })).text));
    // changing an existing trigger keeps its id
    const ch = await b.call('save_trigger', { id: 't_count', name: 'Countdown at 9:50' });
    assert.strictEqual(ch.j.saved, 't_count');
    assert.strictEqual(b.core.state().triggers.t_count.options.name, 'Countdown at 9:50');
    assert.strictEqual(b.core.state().triggers.t_count.options.enabled, true, 'a trigger that was on stays on');
    await b.t.revert(Object.assign({ action: 'changed' }, b.changes.find((c) => c.id === 't_count')));
    assert.strictEqual(b.core.state().triggers.t_count.options.name, 'Countdown at 9:55');
    await b.t.revert(Object.assign({ action: 'created' }, b.changes.find((c) => c.id === id)));
    assert.ok(!b.core.state().triggers[id], 'a created trigger is removed on revert');
    // custom variables
    assert.ok(!(await b.call('save_custom_variable', { name: 'song', start_value: 'none', description: 'Current song' })).isError);
    assert.strictEqual(b.core.state().customVars.song.defaultValue, 'none');
    assert.ok(!(await b.call('save_custom_variable', { name: 'service_live', start_value: '9' })).isError);
    await b.t.revert(Object.assign({ action: 'changed' }, b.changes.find((c) => c.id === 'service_live')));
    assert.strictEqual(b.core.state().customVars.service_live.defaultValue, '0');
    assert.ok(/letters, digits/.test((await b.call('save_custom_variable', { name: 'bad name' })).text));
    // pages
    const pg = await b.call('save_page', { name: 'Easter' });
    assert.strictEqual(pg.j.added, 4);
    assert.strictEqual(b.core.state().pages[3].name, 'Easter');
    await b.t.revert(Object.assign({ action: 'created' }, b.changes[b.changes.length - 1]));
    assert.strictEqual(b.core.state().pages.length, 3);
    await b.call('save_page', { page: 3, name: 'Sound' });
    await b.t.revert(Object.assign({ action: 'changed' }, b.changes[b.changes.length - 1]));
    assert.strictEqual(b.core.state().pages[2].name, 'Audio');
    // Hands on
    const h = toolsWith('hands');
    assert.ok(!(await h.call('press_button', { page: 2, row: 0, column: 3 })).isError);
    assert.deepStrictEqual(h.core.state().presses.map((p) => p.down), [true, false], 'down, then up');
    assert.ok((await h.call('press_button', { page: 2, row: 3, column: 7 })).isError, 'nothing there to press');
    assert.ok(!(await h.call('run_trigger', { id: 't_live' })).isError);
    assert.ok(!(await h.call('set_trigger_enabled', { id: 't_live', enabled: true })).isError);
    assert.strictEqual(h.core.state().triggers.t_live.options.enabled, true);
    assert.ok(!(await h.call('set_custom_variable_value', { name: '$(custom:service_live)', value: '1' })).isError);
    assert.strictEqual(h.core.state().customValues.service_live, '1');
    assert.ok(!(await h.call('set_connection_enabled', { connection: 'obs', enabled: false })).isError);
    assert.strictEqual(h.core.state().connections.c_obs.enabled, false);
    assert.ok((await h.call('delete_trigger', { id: 't_live' })).isError, 'deleting needs Full');
    // Full: delete and bring back
    const f = toolsWith('full');
    assert.ok(!(await f.call('delete_trigger', { id: 't_count' })).isError);
    await f.t.revert(Object.assign({ action: 'deleted' }, f.changes[0]));
    assert.strictEqual(f.core.state().triggers.t_count.options.name, 'Countdown at 9:55');
    assert.ok(!(await f.call('delete_custom_variable', { name: 'service_live' })).isError);
    await f.t.revert(Object.assign({ action: 'deleted' }, f.changes[1]));
    assert.strictEqual(f.core.state().customVars.service_live.description, 'Set to 1 while the service is streaming');
    // access narrowed for one call (a connection from outside)
    const narrowed = Object.assign({ level: 'read', enabled: true, protectedPages: [] }, LEVELS.read);
    assert.ok(/not allowed for this connection/.test((await f.call('delete_button', { page: 2, row: 0, column: 1 }, narrowed)).text));
  });

  test('tools: Companion 4 is refused with a clear message; big answers are cut', async () => {
    const { t, core } = toolsWith('read');
    core.state().version = '4.3.4';
    await assert.rejects(t.probe(), /needs Companion 5 or newer/);
    assert.ok(/\(cut: \d+ more characters/.test(Tools.fit('x'.repeat(70000))));
  });

  test('mcp: handshake, discover and tool listing for development mode', async () => {
    const { t } = toolsWith('build');
    const m = Mcp.create({ serverInfo: { name: 'livecompanion', version: '0' }, instructions: Tools.INSTRUCTIONS, listTools: () => t.list(), callTool: (n, a) => t.call(n, a) });
    const init = await m.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    assert.strictEqual(init.result.protocolVersion, '2025-11-25');
    assert.ok(/Companion/.test(init.result.instructions));
    const list = await m.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.result.tools.some((x) => x.name === 'save_button') && !list.result.tools.some((x) => x.name === 'press_button'));
    const call = await m.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'press_button', arguments: {} } });
    assert.ok(call.error && /may not be allowed/.test(call.error.message));
  });

  test('security: addresses, rate limits, encryption key, authenticator codes, QR', () => {
    ['10.1.2.3', '192.168.1.5', '127.0.0.1', '::ffff:192.168.0.9', '100.101.1.1'].forEach((ip) => assert.ok(Net.isPrivate(ip), ip));
    ['8.8.8.8', '172.32.0.1', ''].forEach((ip) => assert.ok(!Net.isPrivate(ip), ip));
    const l = Net.limiter({ max: 3, windowMs: 60000, lockMs: 60000 });
    assert.ok(!l.hit('a') && !l.hit('a') && l.hit('a') && l.locked('a') > 0);
    const d = tmp('key'), kf = path.join(d, 'secret.key');
    const a = Secrets.create(kf), blob = a.enc('device-password');
    const b = Secrets.create(kf, { masterKey: 'correct horse battery staple' });
    const moved = b.migrate({ v: blob });
    assert.ok(moved.v.startsWith('enc2:') && b.dec(moved.v) === 'device-password');
    assert.strictEqual(Secrets.create(kf, { masterKey: 'wrong' }).dec(moved.v), '');
    const key = Buffer.from('12345678901234567890');
    assert.strictEqual(Totp.hotp(key, Math.floor(59 / 30), 8), '94287082');
    const sec = Totp.base32Encode(key), now = 1793000000000, c = Totp.counterAt(now);
    assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c), c, now), null, 'no replay');
    assert.ok(/^otpauth:\/\/totp\/LiveCompanion:x\?/.test(Totp.uri(Totp.newSecret(), 'x', 'LiveCompanion')));
    assert.ok(/^<svg/.test(QR.svg('hello')));
  });

  // ---------- the whole server ----------
  function startServer(env, args) {
    const proc = spawn(process.execPath, [path.join(root, 'server.js')].concat(args || []), { env: Object.assign({}, process.env, { LIVECOMPANION_NO_UPDATE_CHECK: '1', LIVECOMPANION_REVIEW_TICK_MS: '200' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (x) => { log += x; }); proc.stderr.on('data', (x) => { log += x; });
    return { proc, log: () => log, ready: async () => { for (let i = 0; i < 80 && !/on http:\/\/localhost/.test(log); i++) await new Promise((r) => setTimeout(r, 100)); if (!/on http:\/\/localhost/.test(log)) throw new Error('server did not start:\n' + log); } };
  }
  const pinHash = (pin) => { const salt = crypto.randomBytes(16); return 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
  const rpc = (port, token, method, params) => req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, { authorization: 'Bearer ' + token });

  test('server: a real Companion over the network, levels, keep or revert, backups, separation from updates', async () => {
    const f = await fakeCompanionServer();
    const port = await freePort(), pub = await freePort(), dir = tmp('srv');
    const s = startServer({ PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json') });
    try {
      await s.ready();
      let st = (await req(port, 'GET', '/api/state')).j;
      assert.ok(st.claude && st.devices, 'updates and development mode side by side in one state, apart');
      assert.strictEqual(st.claude.access.local, 'read');
      assert.ok((await req(port, 'POST', '/api/claude/companion', { url: 'not a url/at all' })).j.error);
      assert.ok((await req(port, 'POST', '/api/claude/companion', { url: f.url.replace('http://', '') })).j.ok, 'http:// is added');
      const test1 = await req(port, 'POST', '/api/claude/companion-test', {});
      assert.ok(test1.j.ok, JSON.stringify(test1.j));
      st = (await req(port, 'GET', '/api/state')).j;
      assert.strictEqual(st.claude.companion.status.version, '5.1.1');
      assert.strictEqual(st.claude.companion.status.pages, 3);
      // the access token
      const tok = (await req(port, 'POST', '/api/claude/token', {})).j.token;
      assert.ok(tok && tok.length > 20);
      assert.strictEqual((await rpc(port, 'wrong', 'tools/list')).status, 401);
      assert.strictEqual((await req(port, 'POST', '/mcp', {}, { authorization: 'Bearer ' + tok, origin: 'https://evil.example' })).status, 403, 'web pages cannot use it');
      let tools = (await rpc(port, tok, 'tools/list')).j.result.tools.map((x) => x.name);
      assert.ok(tools.includes('get_overview') && !tools.includes('save_button'));
      // Help build: change a button, it waits for review; revert puts it back
      assert.ok((await req(port, 'POST', '/api/claude/access', { local: 'build' })).j.ok);
      tools = (await rpc(port, tok, 'tools/list')).j.result.tools.map((x) => x.name);
      assert.ok(tools.includes('save_button') && !tools.includes('press_button'));
      const saved = await rpc(port, tok, 'tools/call', { name: 'save_button', arguments: { page: 2, row: 0, column: 1, text: 'WIDE SHOT' } });
      assert.ok(!saved.j.result.isError, saved.j.result.content[0].text);
      assert.ok(/keep or revert/.test(saved.j.result.content[0].text));
      assert.strictEqual(Tools.buttonText(f.core.state().pages[1].controls[0][1]), 'WIDE SHOT');
      st = (await req(port, 'GET', '/api/state')).j;
      const rv = st.claude.reviews.find((x) => x.status === 'waiting');
      assert.ok(rv && rv.kind === 'button' && rv.action === 'changed' && rv.beforeView.text === 'CAM 1' && rv.afterView.text === 'WIDE SHOT', JSON.stringify(rv));
      assert.ok(!rv.before && !rv.after, 'the raw configs stay on the server');
      assert.ok(st.claude.activity.some((x) => x.tool === 'save_button' && x.write));
      assert.ok((await req(port, 'POST', '/api/claude/review', { rid: rv.rid, keep: false })).j.ok);
      assert.strictEqual(Tools.buttonText(f.core.state().pages[1].controls[0][1]), 'CAM 1', 'reverted in Companion');
      assert.ok(!(await req(port, 'POST', '/api/claude/review', { rid: rv.rid, keep: true })).j.ok, 'answered once');
      // Claude is told about the revert
      const ov = await rpc(port, tok, 'tools/call', { name: 'get_overview', arguments: {} });
      assert.ok(JSON.parse(ov.j.result.content[0].text).review.recently_reverted.length === 1);
      // backups, restore, download
      const bks = (await req(port, 'GET', '/api/claude/backups')).j.backups;
      assert.ok(bks.some((b) => b.kind === 'button' && b.reason === 'before-change'));
      // an unanswered change is reverted when its time runs out
      assert.ok((await req(port, 'POST', '/api/claude/review', { timeoutMin: 15, ifNoAnswer: 'revert' })).j.ok);
      await rpc(port, tok, 'tools/call', { name: 'save_custom_variable', arguments: { name: 'song', start_value: 'x' } });
      assert.ok(f.core.state().customVars.song);
      const cfgFile = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      assert.strictEqual(cfgFile.claude.review.timeoutMin, 15, 'saved under its own claude section');
      assert.ok(!JSON.stringify(cfgFile).includes(tok), 'the access token is stored encrypted');
      // protected pages via the page
      assert.ok((await req(port, 'POST', '/api/claude/access', { protectedPages: '2, 3' })).j.ok);
      st = (await req(port, 'GET', '/api/state')).j;
      assert.deepStrictEqual(st.claude.access.protectedPages, [2, 3]);
      const refused = await rpc(port, tok, 'tools/call', { name: 'save_button', arguments: { page: 2, row: 3, column: 3, text: 'x' } });
      assert.ok(refused.j.result.isError && /protected/.test(refused.j.result.content[0].text));
      // the off switch
      assert.ok((await req(port, 'POST', '/api/claude/access', { enabled: false })).j.ok);
      assert.strictEqual((await rpc(port, tok, 'tools/list')).status, 503);
      // the update side is untouched by all this
      st = (await req(port, 'GET', '/api/state')).j;
      assert.deepStrictEqual(st.devices, []);
      assert.ok(!('access' in st.settings) && !('claude' in st.settings));
    } finally { s.proc.kill(); await f.close(); }
  });

  test('server: exposed mode keeps the dashboard private and the public port narrow; sign-in approved at home', async () => {
    const port = await freePort(), pub = await freePort(), dir = tmp('exp');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ controlPinHash: pinHash('2468'), claude: { publicUrl: 'https://companion.example.com', security: { mode: 'exposed' }, access: { local: 'full', outsideMax: 'hands' }, setup: { completed: true, marks: {} } } }));
    const s = startServer({ PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json') }, ['--demo']);
    const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'companion.example.com' }, extra || {});
    const PIN = { 'x-pin': '2468' };
    try {
      await s.ready();
      // in demo mode the saved config is ignored: switch to exposed through the page, which needs the PIN
      assert.ok(!(await req(port, 'POST', '/api/claude/security', { mode: 'exposed' })).j.ok, 'no PIN set in demo yet');
      assert.ok((await req(port, 'POST', '/api/settings', { newPin: '2468' })).j.ok);
      assert.ok((await req(port, 'POST', '/api/claude/settings', { publicUrl: 'https://companion.example.com' }, PIN)).j.ok);
      assert.ok((await req(port, 'POST', '/api/claude/access', { local: 'full' }, PIN)).j.ok);
      assert.ok((await req(port, 'POST', '/api/claude/security', { mode: 'exposed' }, PIN)).j.ok);
      assert.ok(!(await req(port, 'POST', '/api/settings', { newPin: null }, PIN)).j.ok, 'the PIN cannot be removed while exposed');
      // the dashboard port refuses anything that came through a proxy: updates too
      assert.strictEqual((await req(port, 'GET', '/', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
      assert.strictEqual((await req(port, 'GET', '/api/state', undefined, { 'cf-connecting-ip': '203.0.113.9' })).status, 403);
      assert.strictEqual((await req(port, 'GET', '/api/state')).status, 200, 'fine from this network');
      const page = await fetch('http://127.0.0.1:' + port + '/');
      assert.ok(/script-src 'sha256-/.test(page.headers.get('content-security-policy')), 'strict CSP on the dashboard');
      // the public port: no dashboard, no updates, https and the right host only
      for (const p of ['/', '/api/state', '/api/update', '/api/devices', '/events']) assert.strictEqual((await req(pub, 'GET', p, undefined, H())).status, 404, p);
      assert.strictEqual((await req(pub, 'POST', '/api/update', { items: [] }, H())).status, 404);
      assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-proto': 'http' }))).status, 403);
      assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-host': 'evil.example' }))).status, 421);
      assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H())).j.resource, 'https://companion.example.com/mcp');
      assert.strictEqual((await req(pub, 'POST', '/mcp', {}, H())).status, 401);
      assert.strictEqual((await req(pub, 'POST', '/mcp', {}, H({ authorization: 'Bearer demo' }))).status, 401, 'the plain token does not work from outside');
      // sign in: the code shown outside must be approved at home, with a level and an access time
      const reg = (await req(pub, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, H())).j;
      const verifier = crypto.randomBytes(32).toString('base64url');
      const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 's' });
      const html = (await req(pub, 'GET', '/oauth/authorize?' + q, undefined, H())).text;
      assert.ok(/LIVECOMPANION/.test(html) && /connect to your LiveCompanion/.test(html));
      const d = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(html)[1]);
      const shown = /<div class="code"[^>]*>([A-Z0-9-]+)<\/div>/.exec(html)[1];
      const pend = (await req(port, 'GET', '/api/state')).j.claude.security.pending[0];
      assert.strictEqual(pend.code, shown, 'the dashboard shows the same code');
      assert.strictEqual((await req(port, 'POST', '/api/claude/connections/decide', { id: pend.id, approve: true, scope: 'hands', span: '1h' })).status, 401, 'approving needs the PIN');
      assert.ok((await req(port, 'POST', '/api/claude/connections/decide', { id: pend.id, approve: true, scope: 'hands', span: '1h' }, PIN)).j.ok);
      const stt = (await req(pub, 'GET', '/oauth/status?id=' + d.id + '&s=' + d.s, undefined, H())).j;
      const code = new URL(stt.redirect).searchParams.get('code');
      const tok = (await req(pub, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }, H())).j.access_token;
      assert.ok(tok);
      const list = (await req(pub, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, H({ authorization: 'Bearer ' + tok }))).j.result.tools.map((x) => x.name);
      assert.ok(list.includes('press_button') && !list.includes('delete_button'), 'from outside: Hands on at most, never Full');
      const pressed = await req(pub, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'press_button', arguments: { page: 2, row: 0, column: 2 } } }, H({ authorization: 'Bearer ' + tok }));
      assert.ok(!pressed.j.result.isError, pressed.j.result.content[0].text);
      const sec = (await req(port, 'GET', '/api/state')).j.claude.security;
      assert.strictEqual(sec.connections.length, 1);
      assert.ok(sec.connections[0].expiresAt > Date.now() + 3500e3, 'access time chosen at approval');
      assert.ok(sec.events.some((e) => e.type === 'admin-refused') && sec.events.some((e) => e.type === 'connection-approved'));
      const act = (await req(port, 'GET', '/api/state')).j.claude.activity[0];
      assert.ok(act.remote && act.tool === 'press_button');
      // wrong tokens lock an address out
      for (let i = 0; i < 10; i++) await req(pub, 'POST', '/mcp', {}, H({ 'x-forwarded-for': '198.51.100.7', authorization: 'Bearer guess' + i }));
      assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-for': '198.51.100.7' }))).status, 429);
      // revoke, and local mode closes the public port
      assert.ok((await req(port, 'POST', '/api/claude/connections/revoke', { all: true }, PIN)).j.ok);
      assert.strictEqual((await req(pub, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, H({ authorization: 'Bearer ' + tok }))).status, 401);
      assert.ok((await req(port, 'POST', '/api/claude/security', { mode: 'local' }, PIN)).j.ok);
      assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H())).status, 404);
      // PIN guessing locks out, for updates and development mode alike
      for (let i = 0; i < 5; i++) await req(port, 'POST', '/api/claude/access', { enabled: true }, { 'x-pin': '000' + i });
      assert.strictEqual((await req(port, 'POST', '/api/check', {}, PIN)).status, 429);
    } finally { s.proc.kill(); }
  });

  test('server: approving a connection from outside with an authenticator code', async () => {
    const port = await freePort(), pub = await freePort();
    const s = startServer({ PORT: String(port), PUBLIC_PORT: String(pub) }, ['--demo']);
    const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20', 'x-forwarded-host': 'companion.example.com' }, extra || {});
    const PIN = { 'x-pin': '2468' };
    const codeFor = (secret, offset) => Totp.hotp(Totp.base32Decode(secret.replace(/\s/g, '')), Totp.counterAt(Date.now()) + (offset || 0));
    try {
      await s.ready();
      await req(port, 'POST', '/api/settings', { newPin: '2468' });
      await req(port, 'POST', '/api/claude/settings', { publicUrl: 'https://companion.example.com' }, PIN);
      assert.ok((await req(port, 'POST', '/api/claude/security', { mode: 'exposed' }, PIN)).j.ok);
      const setup = (await req(port, 'POST', '/api/claude/totp', { action: 'setup' }, PIN)).j;
      assert.ok(setup.ok && /<svg/.test(setup.svg) && /^otpauth:\/\/totp\/LiveCompanion:/.test(setup.uri));
      assert.ok(!(await req(port, 'POST', '/api/claude/totp', { action: 'confirm', code: '000000' }, PIN)).j.ok);
      assert.ok((await req(port, 'POST', '/api/claude/totp', { action: 'confirm', code: codeFor(setup.secret) }, PIN)).j.ok);
      const reg = (await req(pub, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, H())).j;
      const verifier = crypto.randomBytes(32).toString('base64url');
      const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 's' });
      const html = (await req(pub, 'GET', '/oauth/authorize?' + q, undefined, H())).text;
      const d = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(html)[1]);
      assert.ok(d.totp && /id="c"/.test(html), 'the sign-in page offers the code box');
      assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: d.id, s: d.s, code: codeFor(setup.secret, 1), scope: 'hands' }, H())).status, 400, 'above the code limit (Help build)');
      assert.ok((await req(pub, 'POST', '/oauth/approve', { id: d.id, s: d.s, code: codeFor(setup.secret, 1), scope: 'build' }, H())).j.ok);
      const stt = (await req(pub, 'GET', '/oauth/status?id=' + d.id + '&s=' + d.s, undefined, H())).j;
      assert.strictEqual(stt.status, 'approved');
      const sec = (await req(port, 'GET', '/api/state')).j.claude.security;
      assert.ok(sec.totp.enabled && sec.events.some((e) => e.via === 'authenticator code'));
    } finally { s.proc.kill(); }
  });
};
