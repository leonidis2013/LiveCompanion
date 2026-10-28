/*
 * The tools Claude sees in development mode, working on the central Bitfocus Companion (5.x).
 *
 * Read tools are always on. Change tools only show up at the level that allows them:
 *   edit   (Help build): buttons, pages, triggers, custom variables. Backed up first, reviewed after.
 *   press  (Hands on):   press buttons, run triggers, switch triggers and connections on and off,
 *                        set custom variable values. These act on the real show.
 *   delete (Full):       delete buttons, pages, triggers, custom variables. Backed up first.
 * Protected pages can be read, but nothing on them is changed or pressed at any level, and
 * buttons or triggers whose actions would press buttons on them are refused.
 *
 * How changes reach Companion: Companion has no call to put one saved button back, so a button
 * is written by re-importing its page: LiveCompanion exports the page as it is now, swaps that
 * one button, and imports the page again. Everything else on the page stays as it was (the
 * page briefly redraws). Triggers are written the same way through Companion's trigger import.
 */
'use strict';
const crypto = require('crypto');

class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };

// ---------- small helpers ----------
const MAX_TEXT = 60000;
function fit(obj) {
  let text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n... (cut: ' + (text.length - MAX_TEXT) + ' more characters. Ask for less, for example one page or a filter.)';
  return text;
}
const str = (v, max = 300) => (v == null ? '' : String(v)).trim().slice(0, max);
function int(v, def, min, max) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
const words = (q) => str(q, 200).toLowerCase().split(/\s+/).filter(Boolean);
const matches = (ws, ...hay) => { const h = hay.join(' ').toLowerCase(); return ws.every((w) => h.includes(w)); };
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const newId = () => crypto.randomBytes(9).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VAR_NAME_RE = /^\w{1,100}$/;
const TRIGGER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const locKey = (p, r, c) => 'p' + p + 'r' + r + 'c' + c;
const locText = (p, r, c) => p + '/' + r + '/' + c;
function parseLocKey(k) { const m = /^p(\d+)r(-?\d+)c(-?\d+)$/.exec(String(k)); return m ? { page: +m[1], row: +m[2], column: +m[3] } : null; }
const EoV = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'isExpression' in v && 'value' in v ? v : { value: v, isExpression: false });
const unEoV = (v) => (v && typeof v === 'object' && 'isExpression' in v && 'value' in v ? (v.isExpression ? { expression: v.value } : v.value) : v);
/** "#ff0000", "ff0000", "red"-less: numbers stay numbers */
function color(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
  if (m) return parseInt(m[1], 16);
  const named = { black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x00cc00, blue: 0x0055ff, yellow: 0xffcc00, orange: 0xff7700, purple: 0x8800cc, grey: 0x555555, gray: 0x555555 };
  const n = named[String(v).trim().toLowerCase()];
  if (n != null) return n;
  fail('Colors are written like "#ff0000" (or a name: red, green, blue, yellow, orange, purple, grey, black, white)');
}
const hex = (n) => (typeof n === 'number' ? '#' + (n & 0xffffff).toString(16).padStart(6, '0') : n);

// ---------- what Companion holds, read in a few calls ----------
const EXPORT_ALL = '/int/export/custom?buttons=true&connections=true&surfaces=&triggers=true&customVariables=true&expressionVariables=true&includeSecrets=false&imageLibrary=false&format=json';

async function everything(ctx, fresh) {
  const c = ctx.cache;
  if (!fresh && c.all && Date.now() - c.all.at < 2500) return c.all.v;
  const v = await ctx.companion.http('GET', EXPORT_ALL, undefined, { timeoutMs: 20000 });
  if (!v || typeof v !== 'object' || v.type !== 'full') fail('Companion did not send its configuration as expected. Is this Companion 5?');
  v.pages = v.pages || {}; v.triggers = v.triggers || {}; v.instances = v.instances || {}; v.custom_variables = v.custom_variables || {};
  c.all = { at: Date.now(), v };
  return v;
}
function forget(ctx) { delete ctx.cache.all; delete ctx.cache.pagesWatch; }
async function connections(ctx) {
  const c = ctx.cache;
  if (c.conns && Date.now() - c.conns.at < 3000) return c.conns.v;
  const [list, stat] = await Promise.all([ctx.companion.snapshot('instances.connections.watch'), ctx.companion.snapshot('instances.statuses.watch').catch(() => null)]);
  const info = (Array.isArray(list) ? list.find((m) => m && m.type === 'init') : list) || {};
  const statuses = (stat && stat.statuses) || {};
  const v = Object.values(info.info || {}).map((x) => ({ id: x.id, label: x.label, module: x.moduleId, version: x.moduleVersionId, enabled: !!x.enabled, status: statuses[x.id] || null }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  c.conns = { at: Date.now(), v };
  return v;
}
async function definitions(ctx, kind) {
  const c = ctx.cache, key = 'defs_' + kind;
  if (c[key] && Date.now() - c[key].at < 30000) return c[key].v;
  const m = await ctx.companion.snapshot(kind === 'feedback' ? 'instances.definitions.feedbacks' : 'instances.definitions.actions', undefined, { timeoutMs: 20000 });
  const v = (m && m.definitions) || {};
  c[key] = { at: Date.now(), v };
  return v;
}
async function gridSize(ctx) {
  const cfg = await ctx.companion.query('userConfig.getConfig');
  return (cfg && cfg.gridSize) || { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 };
}

/** A connection by id or by label (what people and Claude usually say). */
function findConn(conns, q) {
  const s = str(q, 100);
  if (!s) return null;
  if (s === 'internal') return { id: 'internal', label: 'internal', module: 'internal' };
  return conns.find((x) => x.id === s) || conns.find((x) => String(x.label).toLowerCase() === s.toLowerCase()) || null;
}
const statusText = (st) => (!st ? 'unknown' : st.category === 'good' ? 'ok' : [st.category, st.level, st.message].filter(Boolean).join(': '));

// ---------- buttons, read ----------
function buttonText(ctl) {
  if (!ctl) return '';
  if (ctl.type === 'pageup') return '(page up)';
  if (ctl.type === 'pagedown') return '(page down)';
  if (ctl.type === 'pagenum') return '(page number)';
  if (ctl.type === 'button-reference') return '(mirror of ' + unEoV(ctl.options && ctl.options.location) + ')';
  const layers = (ctl.style && ctl.style.layers) || [];
  const t = layers.find((l) => l && l.type === 'text');
  if (t && t.text) { const v = t.text; return v.isExpression ? '=' + v.value : String(v.value == null ? '' : v.value); }
  if (ctl.style && ctl.style.text != null) return String(ctl.style.text); // Companion 4 shape
  return '';
}
function entityCount(ctl) {
  let n = 0;
  for (const step of Object.values((ctl && ctl.steps) || {})) for (const set of Object.values(step.action_sets || {})) n += (set || []).length;
  return n;
}
/** A readable version of one action or feedback, with the connection's label. */
function describeEntity(e, labelOf) {
  if (!e) return null;
  const out = { id: e.id, connection: labelOf(e.connectionId), [e.type === 'feedback' ? 'feedback' : 'action']: e.definitionId };
  if (e.headline) out.headline = e.headline;
  if (e.disabled) out.disabled = true;
  const opts = {};
  for (const [k, v] of Object.entries(e.options || {})) opts[k] = unEoV(v);
  if (Object.keys(opts).length) out.options = opts;
  if (e.isInverted && unEoV(e.isInverted) === true) out.inverted = true;
  if (e.styleOverrides && e.styleOverrides.length) out.style_when_true = e.styleOverrides.map((o) => ({ [o.elementProperty]: (o.elementProperty || '').match(/color/i) ? hex(unEoV(o.override)) : unEoV(o.override), element: o.elementId }));
  if (e.storeResult) out.store_result = e.storeResult;
  if (e.children) out.children = Object.fromEntries(Object.entries(e.children).map(([g, list]) => [g, (list || []).map((x) => describeEntity(x, labelOf))]));
  return out;
}
function describeButton(ctl, labelOf) {
  if (!ctl) return null;
  const out = { type: ctl.type, text: buttonText(ctl) };
  if (ctl.type !== 'button-layered') return Object.assign(out, ctl.options ? { options: ctl.options } : {});
  const layers = (ctl.style && ctl.style.layers) || [];
  const box = layers.find((l) => l.type === 'box'), txt = layers.find((l) => l.type === 'text');
  if (box && box.color) out.background = hex(unEoV(box.color));
  if (txt && txt.color) out.text_color = hex(unEoV(txt.color));
  if (txt && txt.fontsize) out.text_size = unEoV(txt.fontsize);
  const extra = layers.filter((l) => !['canvas', 'box', 'text'].includes(l.type) || (l.type === 'box' && l !== box) || (l.type === 'text' && l !== txt));
  if (extra.length) out.other_layers = extra.map((l) => l.type + (l.name ? ' "' + l.name + '"' : ''));
  out.steps = Object.entries(ctl.steps || {}).map(([id, s]) => {
    const sets = {};
    for (const [k, list] of Object.entries(s.action_sets || {})) if (list && list.length) sets[/^\d+$/.test(k) ? 'held_' + k + 'ms' : k] = list.map((e) => describeEntity(e, labelOf));
    return Object.assign({ step: id }, s.options && s.options.name ? { name: s.options.name } : {}, sets);
  });
  if ((ctl.feedbacks || []).length) out.feedbacks = ctl.feedbacks.map((e) => describeEntity(e, labelOf));
  if ((ctl.localVariables || []).length) out.local_variables = ctl.localVariables.map((e) => describeEntity(e, labelOf));
  const o = ctl.options || {};
  if (o.stepProgression && o.stepProgression !== 'auto') out.step_progression = o.stepProgression;
  if (o.rotaryActions) out.rotary = true;
  if (o.notes) out.notes = o.notes;
  return out;
}
const labeler = (all) => (id) => (id === 'internal' ? 'internal' : (all.instances[id] && all.instances[id].label) || id + ' (missing connection)');

function pageOf(all, page) {
  const p = all.pages[page] || all.pages[String(page)];
  if (!p) fail('There is no page ' + page + '. Companion has ' + Object.keys(all.pages).length + ' pages.');
  return p;
}
function controlAt(all, page, row, column) {
  const p = pageOf(all, page);
  return ((p.controls || {})[row] || {})[column] || null;
}
function eachButton(all, fn) {
  for (const [pn, p] of Object.entries(all.pages)) for (const [r, cols] of Object.entries(p.controls || {})) for (const [c, ctl] of Object.entries(cols || {})) if (ctl) fn(+pn, +r, +c, ctl, p);
}

// ---------- protected pages ----------
function protectedSet(ctx) { return new Set((ctx.access().protectedPages || []).map(Number)); }
function guardPage(ctx, page) {
  if (protectedSet(ctx).has(Number(page))) fail('Page ' + page + ' is protected in LiveCompanion: Claude can read it, but cannot change or press anything on it. The person can change that under Development mode > Permissions.');
}
/** Actions that would press or change buttons on a protected page (best effort: location and page options). */
function guardEntities(ctx, list, what) {
  const prot = protectedSet(ctx);
  if (!prot.size) return;
  const walk = (e) => {
    if (!e) return;
    for (const [k, v] of Object.entries(e.options || {})) {
      const val = unEoV(v);
      if (typeof val === 'string') { const m = /^\s*(\d+)\s*\/\s*-?\d+\s*\/\s*-?\d+\s*$/.exec(val); if (m && prot.has(+m[1])) fail(what + ' would act on page ' + m[1] + ' (' + val + '), which is protected in LiveCompanion.'); }
      if (/^page$/i.test(k) && (typeof val === 'number' || /^\d+$/.test(String(val))) && prot.has(Number(val))) fail(what + ' would act on page ' + val + ', which is protected in LiveCompanion.');
    }
    for (const kids of Object.values(e.children || {})) (kids || []).forEach(walk);
  };
  (list || []).forEach(walk);
}
function allEntitiesOfButton(ctl) {
  const out = [].concat(ctl.feedbacks || [], ctl.localVariables || []);
  for (const s of Object.values(ctl.steps || {})) for (const set of Object.values(s.action_sets || {})) out.push(...(set || []));
  return out;
}

// ---------- building buttons from what Claude writes ----------
/**
 * Claude may write actions simply: { connection: "ATEM", action: "program", options: { input: 2 } }.
 * Turned into Companion's own shape, checked against the connection's definitions, with the
 * missing options filled in from their defaults.
 */
async function buildEntity(ctx, spec, type, all, notes) {
  if (!spec || typeof spec !== 'object') fail('Each ' + type + ' must be an object');
  const conns = await connections(ctx);
  const connQ = spec.connection != null ? spec.connection : spec.connectionId;
  const conn = findConn(conns, connQ);
  if (!conn) fail('Unknown connection "' + str(connQ, 80) + '". Use a label from list_connections (or "internal" for Companion\'s own ' + type + 's).');
  const defId = str(spec.action != null ? spec.action : spec.feedback != null ? spec.feedback : spec.definitionId, 120);
  if (!defId) fail('Say which ' + type + ' to use (the "' + type + '" field, an id from get_connection_definitions)');
  const defs = (await definitions(ctx, type))[conn.id] || {};
  const def = defs[defId];
  if (!def) fail(conn.label + ' has no ' + type + ' "' + defId + '". Look it up with get_connection_definitions (connection "' + conn.label + '", kind "' + type + 's").');
  const options = {};
  for (const f of def.options || []) if (f && f.id && f.default !== undefined && f.type !== 'static-text') options[f.id] = { value: clone(f.default), isExpression: false };
  const known = new Set((def.options || []).map((f) => f.id));
  for (const [k, v] of Object.entries(spec.options || {})) {
    if (known.size && !known.has(k)) notes.push(conn.label + ' ' + type + ' "' + defId + '" has no option "' + k + '"; it was kept, but Companion ignores it.');
    options[k] = v && typeof v === 'object' && !Array.isArray(v) && 'expression' in v && Object.keys(v).length === 1 ? { value: String(v.expression), isExpression: true } : EoV(v);
  }
  const inst = all.instances[conn.id];
  const e = { type, id: str(spec.id, 40) || newId(), definitionId: defId, connectionId: conn.id, options, upgradeIndex: inst && inst.lastUpgradeIndex != null ? inst.lastUpgradeIndex : undefined };
  if (spec.headline) e.headline = str(spec.headline, 200);
  if (spec.disabled) e.disabled = true;
  if (type === 'feedback') {
    if (spec.inverted) e.isInverted = { value: true, isExpression: false };
    const st = spec.style_when_true || spec.style;
    if (st && typeof st === 'object') {
      e.styleOverrides = [];
      const add = (elementId, prop, val) => e.styleOverrides.push({ overrideId: newId(), elementId, elementProperty: prop, override: { value: val, isExpression: false } });
      if (st.background != null || st.bgcolor != null) add('box0', 'color', color(st.background != null ? st.background : st.bgcolor));
      if (st.text_color != null || st.color != null) add('text0', 'color', color(st.text_color != null ? st.text_color : st.color));
      if (st.text != null) add('text0', 'text', String(st.text));
    }
  } else if (spec.delay_ms) notes.push('Companion 5 has no per-action delay; use the internal "wait" action between actions instead. delay_ms was ignored.');
  if (spec.children && typeof spec.children === 'object') {
    e.children = {};
    for (const [g, list] of Object.entries(spec.children)) {
      e.children[g] = [];
      for (const ch of list || []) e.children[g].push(await buildEntity(ctx, ch, ch && ch.feedback ? 'feedback' : 'action', all, notes));
    }
  }
  return e;
}
/** Companion's own entity shape (as read with get_button raw): keep it, but map connection labels to ids. */
async function fixEntity(ctx, e, all, notes) {
  if (e && (e.action || e.feedback || e.connection) && !e.definitionId) return buildEntity(ctx, e, e.feedback ? 'feedback' : 'action', all, notes);
  if (!e || typeof e !== 'object' || !e.definitionId) fail('An action or feedback is missing its definitionId (or use the simple form: { connection, action, options })');
  const conns = await connections(ctx);
  const conn = findConn(conns, e.connectionId);
  if (!conn) fail('Unknown connection "' + str(e.connectionId, 80) + '" in ' + e.definitionId);
  const out = clone(e);
  out.connectionId = conn.id;
  if (!out.id) out.id = newId();
  if (!out.type) out.type = 'action';
  const opts = {};
  for (const [k, v] of Object.entries(out.options || {})) opts[k] = EoV(v);
  out.options = opts;
  for (const [g, list] of Object.entries(out.children || {})) out.children[g] = await Promise.all((list || []).map((x) => fixEntity(ctx, x, all, notes)));
  return out;
}

function defaultLayers() {
  return [
    { id: 'canvas', type: 'canvas', name: 'Canvas', usage: 'auto', decoration: { value: 'default', isExpression: false }, showStatusIcons: { value: 'default', isExpression: false } },
    { id: 'box0', type: 'box', name: 'Background', usage: 'auto', enabled: { value: true, isExpression: false }, opacity: { value: 100, isExpression: false }, x: { value: 0, isExpression: false }, y: { value: 0, isExpression: false }, width: { value: 100, isExpression: false }, height: { value: 100, isExpression: false }, rotation: { value: 0, isExpression: false }, color: { value: 0x000000, isExpression: false }, cornerRadius: { value: 0, isExpression: false }, borderWidth: { value: 0, isExpression: false }, borderColor: { value: 0, isExpression: false }, borderPosition: { value: 'inside', isExpression: false } },
    { id: 'text0', type: 'text', name: 'Text', usage: 'auto', enabled: { value: true, isExpression: false }, opacity: { value: 100, isExpression: false }, x: { value: 0, isExpression: false }, y: { value: 0, isExpression: false }, width: { value: 100, isExpression: false }, height: { value: 100, isExpression: false }, rotation: { value: 0, isExpression: false }, text: { value: '', isExpression: false }, color: { value: 0xffffff, isExpression: false }, halign: { value: 'center', isExpression: false }, valign: { value: 'center', isExpression: false }, fontsize: { value: 100, isExpression: false }, fontsizeAllowShrink: { value: true, isExpression: false }, font: { value: 'companion-sans', isExpression: false }, weight: { value: 'normal', isExpression: false }, styles: { value: [], isExpression: false }, outlineColor: { value: 0xff000000, isExpression: false } }
  ];
}
function newButton() {
  return { type: 'button-layered', options: { stepProgression: 'auto', rotaryActions: false, canModifyStyleInApis: false }, style: { layers: defaultLayers() }, feedbacks: [], steps: { 0: { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } } }, localVariables: [] };
}
function setLayer(ctl, type, key, value) {
  let l = ctl.style.layers.find((x) => x.type === type);
  if (!l) { const d = defaultLayers().find((x) => x.type === type); ctl.style.layers.push(d); l = d; }
  l[key] = EoV(value);
}

/** The finished button from a save_button request: a new button, a change to the one there, or Claude's full config. */
async function buttonFromArgs(ctx, a, current, all) {
  const notes = [];
  let ctl;
  if (a.config) {
    if (typeof a.config !== 'object' || Array.isArray(a.config)) fail('config must be a button object (as get_button shows it with raw: true)');
    ctl = clone(a.config);
    if (!ctl.type) ctl.type = 'button-layered';
    if (!['button-layered', 'pageup', 'pagedown', 'pagenum', 'button-reference'].includes(ctl.type)) fail('Unknown button type "' + ctl.type + '"');
    if (ctl.type === 'button-layered') {
      const base = newButton();
      ctl = Object.assign(base, ctl, { options: Object.assign(base.options, ctl.options || {}) });
      if (!ctl.style || !Array.isArray(ctl.style.layers)) ctl.style = { layers: defaultLayers() };
      ctl.feedbacks = await Promise.all((ctl.feedbacks || []).map((e) => fixEntity(ctx, e, all, notes)));
      ctl.localVariables = await Promise.all((ctl.localVariables || []).map((e) => fixEntity(ctx, e, all, notes)));
      for (const s of Object.values(ctl.steps || {})) {
        s.options = Object.assign({ runWhileHeld: [] }, s.options || {});
        for (const [k, list] of Object.entries(s.action_sets || {})) s.action_sets[k] = list ? await Promise.all(list.map((e) => fixEntity(ctx, e, all, notes))) : list;
      }
    }
  } else {
    const keepOld = a.mode !== 'replace' && current && current.type === 'button-layered';
    ctl = keepOld ? clone(current) : newButton();
    if (a.text != null) setLayer(ctl, 'text', 'text', String(a.text).slice(0, 500));
    if (a.text_expression != null) setLayer(ctl, 'text', 'text', { value: String(a.text_expression), isExpression: true });
    if (a.background != null) setLayer(ctl, 'box', 'color', color(a.background));
    if (a.text_color != null) setLayer(ctl, 'text', 'color', color(a.text_color));
    if (a.text_size != null) setLayer(ctl, 'text', 'fontsize', a.text_size === 'auto' ? 100 : int(a.text_size, 100, 5, 500));
    if (a.notes != null) ctl.options.notes = str(a.notes, 2000);
    const step = ctl.steps[Object.keys(ctl.steps)[0]] || (ctl.steps[0] = { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } });
    if (Array.isArray(a.press_actions)) step.action_sets.down = await Promise.all(a.press_actions.map((x) => buildEntity(ctx, x, 'action', all, notes)));
    if (Array.isArray(a.release_actions)) step.action_sets.up = await Promise.all(a.release_actions.map((x) => buildEntity(ctx, x, 'action', all, notes)));
    if (Array.isArray(a.feedbacks)) ctl.feedbacks = await Promise.all(a.feedbacks.map((x) => buildEntity(ctx, x, 'feedback', all, notes)));
  }
  guardEntities(ctx, allEntitiesOfButton(ctl), 'This button');
  return { ctl, notes };
}

// ---------- writing pages and triggers through Companion's import ----------
let importChain = Promise.resolve();
/** One import at a time: Companion allows a single upload session. */
function serial(fn) { const run = importChain.then(fn, fn); importChain = run.catch(() => {}); return run; }

async function uploadImport(ctx, fileObj) {
  const text = JSON.stringify(fileObj);
  const buf = Buffer.from(text, 'utf8');
  const cp = ctx.companion;
  const sessionId = await cp.mutate('importExport.prepareImport.start', { name: 'livecompanion.companionconfig', size: buf.length });
  const CHUNK = 256 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK) await cp.mutate('importExport.prepareImport.uploadChunk', { sessionId, offset: off, data: buf.subarray(off, off + CHUNK).toString('base64') });
  const res = await cp.mutate('importExport.prepareImport.complete', { sessionId, expectedChecksum: crypto.createHash('sha1').update(buf).digest('hex'), userData: null }, { timeoutMs: 30000 });
  if (Array.isArray(res) && res[0]) fail('Companion would not read the import: ' + res[0]);
}
/** Map every connection in the file to the same connection in Companion, so the import never makes new ones. */
async function remapFor(ctx, instances) {
  const conns = await connections(ctx);
  const ids = new Set(conns.map((x) => x.id));
  const map = {};
  for (const id of Object.keys(instances || {})) map[id] = ids.has(id) ? id : '_ignore';
  return map;
}
async function allInstances(ctx) {
  const all = await everything(ctx);
  const out = {};
  for (const [id, x] of Object.entries(all.instances)) if (x && x.label) out[id] = { label: x.label, moduleId: x.moduleId, lastUpgradeIndex: x.lastUpgradeIndex, moduleVersionId: x.moduleVersionId };
  return out;
}

/**
 * Put new versions of some buttons on one page (null removes a button), leaving the rest of the
 * page as it is now. changes: { "row/column": control | null }
 */
async function writeButtons(ctx, page, changes) {
  return serial(async () => {
    const file = await ctx.companion.http('GET', '/int/export/page/' + page + '?format=json&includeSecrets=false', undefined, { timeoutMs: 20000 });
    if (!file || file.type !== 'page' || !file.page) fail('Could not read page ' + page + ' from Companion');
    file.page.controls = file.page.controls || {};
    for (const [k, ctl] of Object.entries(changes)) {
      const [r, c] = k.split('/');
      if (ctl) { (file.page.controls[r] = file.page.controls[r] || {})[c] = clone(ctl); }
      else if (file.page.controls[r]) { delete file.page.controls[r][c]; if (!Object.keys(file.page.controls[r]).length) delete file.page.controls[r]; }
    }
    file.instances = Object.assign(await allInstances(ctx), file.instances || {});
    for (const id of Object.keys(file.instances)) { delete file.instances[id].config; delete file.instances[id].secrets; }
    file.version = file.version || 12;
    await uploadImport(ctx, file);
    await ctx.companion.mutate('importExport.importSinglePage', { targetPage: page, sourcePage: file.oldPageNumber || page, connectionIdRemapping: await remapFor(ctx, file.instances) }, { timeoutMs: 30000 });
    forget(ctx);
  });
}
/** A trigger, written whole. Its id stays the same. null deletes it. */
async function writeTrigger(ctx, id, model) {
  return serial(async () => {
    const all = await everything(ctx, true);
    if (all.triggers[id]) await ctx.companion.mutate('controls.triggers.delete', { controlId: 'trigger:' + id });
    if (model) {
      const instances = await allInstances(ctx);
      const file = { version: 12, type: 'trigger_list', companionBuild: 'livecompanion', triggers: { [id]: clone(model) }, triggerCollections: undefined, instances, connectionCollections: undefined };
      await uploadImport(ctx, file);
      await ctx.companion.mutate('importExport.importTriggers', { selectedTriggerIds: [id], connectionIdRemapping: await remapFor(ctx, instances), replaceExisting: false }, { timeoutMs: 30000 });
    }
    forget(ctx);
  });
}

// ---------- the tools ----------
const LOC_PROPS = {
  page: { type: 'integer', minimum: 1, description: 'Page number' },
  row: { type: 'integer', description: 'Row, counted from 0 at the top' },
  column: { type: 'integer', description: 'Column, counted from 0 at the left' }
};
const LOC_REQ = ['page', 'row', 'column'];
const ACTION_SPEC = 'Each action: { "connection": "<label from list_connections, or internal>", "action": "<id from get_connection_definitions>", "options": { "<option id>": <value> } }. An option value can be { "expression": "$(conn:var) + 1" }. Options you leave out get their defaults.';
const FEEDBACK_SPEC = 'Each feedback: { "connection", "feedback": "<id>", "options": {...}, "style_when_true": { "background": "#ff0000", "text_color": "#ffffff", "text": "LIVE" }, "inverted": false }.';

function readLoc(a) {
  const page = int(a.page, NaN, 1, 9999), row = int(a.row, NaN, -99, 999), column = int(a.column, NaN, -99, 999);
  if (!Number.isFinite(page) || !Number.isFinite(row) || !Number.isFinite(column)) fail('Give page, row and column (row and column start at 0)');
  return { page, row, column };
}
async function checkOnGrid(ctx, loc) {
  const g = await gridSize(ctx);
  if (loc.row < g.minRow || loc.row > g.maxRow || loc.column < g.minColumn || loc.column > g.maxColumn) fail('Row ' + loc.row + ', column ' + loc.column + ' is outside Companion\'s grid (rows ' + g.minRow + ' to ' + g.maxRow + ', columns ' + g.minColumn + ' to ' + g.maxColumn + ').');
}
function buttonName(loc, ctl) { const t = buttonText(ctl); return 'Page ' + loc.page + ' ' + loc.row + '/' + loc.column + (t ? ' "' + t.slice(0, 40) + '"' : ''); }
function backupButton(ctx, loc, ctl, reason) {
  if (!ctl) return null;
  return ctx.backups.save('button', locKey(loc.page, loc.row, loc.column), { name: buttonName(loc, ctl), page: loc.page, row: loc.row, column: loc.column, control: ctl }, reason);
}

const TOOLS = [
  {
    name: 'get_overview', title: 'Overview of Companion',
    description: 'Start here. Companion version, pages with their button counts, connections with problems, triggers, custom variables, surfaces, recent errors in the log, what this connection may do in LiveCompanion, and changes waiting for review.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const cp = ctx.companion;
      const [ver, all, conns, surf, logs, grid] = await Promise.all([
        cp.query('appInfo.version').catch(() => null), everything(ctx, true), connections(ctx),
        cp.snapshot('surfaces.watchSurfaces').catch(() => null), cp.snapshot('logs.watch').catch(() => null), gridSize(ctx).catch(() => null)
      ]);
      const pages = Object.entries(all.pages).map(([n, p]) => { let b = 0; for (const cols of Object.values(p.controls || {})) for (const ctl of Object.values(cols || {})) if (ctl && !['pageup', 'pagedown', 'pagenum'].includes(ctl.type)) b++; return { page: +n, name: p.name, buttons: b, protected: protectedSet(ctx).has(+n) || undefined }; });
      const bad = conns.filter((x) => x.enabled && x.status && x.status.category && x.status.category !== 'good');
      const lines = ((logs && logs.lines) || []).filter((l) => /error|warn/i.test(l.level)).slice(-15).map((l) => ({ time: new Date(l.time).toISOString(), level: l.level, source: l.source, message: String(l.message).slice(0, 300) }));
      const sInit = Array.isArray(surf) ? surf.find((m) => m && m.type === 'init') : null;
      const surfaces = sInit ? Object.values(sInit.info || {}).flatMap((g) => (g.surfaces || []).map((x) => ({ name: x.displayName || x.name, type: x.type, connected: !!x.isConnected }))) : undefined;
      return {
        companion: ver ? { version: ver.appVersion, build: ver.appBuild } : 'version unknown',
        grid: grid ? { rows: grid.minRow + '..' + grid.maxRow, columns: grid.minColumn + '..' + grid.maxColumn } : undefined,
        pages,
        connections: { total: conns.length, disabled: conns.filter((x) => !x.enabled).length, with_problems: bad.map((x) => ({ label: x.label, module: x.module, status: statusText(x.status) })) },
        triggers: Object.entries(all.triggers).map(([id, t]) => ({ id, name: t.options && t.options.name, enabled: !!(t.options && t.options.enabled) })),
        custom_variables: Object.keys(all.custom_variables),
        surfaces,
        recent_log_problems: lines,
        livecompanion: ctx.describeAccess(),
        review: ctx.reviewInfo ? ctx.reviewInfo() : undefined
      };
    }
  },
  {
    name: 'get_page', title: 'Buttons on a page',
    description: 'Every button on one page: its location (row/column from 0), text, colors, and what it does in short. Use get_button for one button in full.',
    inputSchema: { type: 'object', properties: { page: LOC_PROPS.page }, required: ['page'] }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const page = int(a.page, 1, 1, 9999);
      const all = await everything(ctx), p = pageOf(all, page), labelOf = labeler(all);
      const buttons = [];
      for (const [r, cols] of Object.entries(p.controls || {})) for (const [c, ctl] of Object.entries(cols || {})) {
        if (!ctl) continue;
        const d = describeButton(ctl, labelOf);
        const acts = [];
        for (const s of d.steps || []) for (const [k, list] of Object.entries(s)) if (Array.isArray(list)) list.forEach((e) => acts.push((k === 'down' ? '' : k + ': ') + e.connection + ' ' + e.action));
        buttons.push(Object.assign({ row: +r, column: +c, type: ctl.type, text: d.text }, d.background ? { background: d.background } : {}, acts.length ? { does: acts.slice(0, 12) } : {}, d.feedbacks ? { feedbacks: d.feedbacks.map((f) => f.connection + ' ' + f.feedback) } : {}, (d.steps || []).length > 1 ? { steps: d.steps.length } : {}));
      }
      buttons.sort((x, y) => x.row - y.row || x.column - y.column);
      return { page, name: p.name, protected: protectedSet(ctx).has(page), grid: p.gridSize, buttons, page_variables: (p.pageVariables || []).length ? p.pageVariables.map((e) => describeEntity(e, labelOf)) : undefined };
    }
  },
  {
    name: 'get_button', title: 'One button in full',
    description: 'Everything about one button: text and colors, every step with its press, release and hold actions (with their options), feedbacks and local variables, as readable text. raw: true also returns Companion\'s own config, which save_button accepts back as config.',
    inputSchema: { type: 'object', properties: Object.assign({}, LOC_PROPS, { raw: { type: 'boolean', description: 'Also return Companion\'s own config' } }), required: LOC_REQ }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const loc = readLoc(a), all = await everything(ctx);
      const ctl = controlAt(all, loc.page, loc.row, loc.column);
      if (!ctl) return { location: locText(loc.page, loc.row, loc.column), empty: true, protected: protectedSet(ctx).has(loc.page) };
      return Object.assign({ location: locText(loc.page, loc.row, loc.column), protected: protectedSet(ctx).has(loc.page) }, describeButton(ctl, labeler(all)), a.raw ? { raw: ctl } : {});
    }
  },
  {
    name: 'find_buttons', title: 'Find buttons',
    description: 'Search every page for buttons by their text, or by what they do: a connection label, an action or feedback id, an option value, a variable name like $(atem:pgm). Returns locations.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['query'] }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const ws = words(a.query); if (!ws.length) fail('Give something to search for');
      const all = await everything(ctx), labelOf = labeler(all), out = [], limit = int(a.limit, 50, 1, 200);
      eachButton(all, (p, r, c, ctl, pg) => {
        if (out.length >= limit) return;
        const d = describeButton(ctl, labelOf);
        if (matches(ws, d.text, JSON.stringify(d.steps || ''), JSON.stringify(d.feedbacks || ''), pg.name)) out.push({ location: locText(p, r, c), page_name: pg.name, text: d.text });
      });
      return out.length ? out : 'No buttons match.';
    }
  },
  {
    name: 'list_triggers', title: 'List triggers',
    description: 'Every trigger with its id, name, whether it is on, and what starts it.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const all = await everything(ctx, true);
      return Object.entries(all.triggers).map(([id, t]) => ({ id, name: t.options && t.options.name, enabled: !!(t.options && t.options.enabled), events: (t.events || []).map((e) => e.type + (e.enabled === false ? ' (off)' : '')), actions: (t.actions || []).length, conditions: (t.condition || []).length }));
    }
  },
  {
    name: 'get_trigger', title: 'One trigger in full',
    description: 'A trigger\'s events (what starts it, with their options), conditions and actions. raw: true also returns Companion\'s own config, which save_trigger accepts back as config.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Trigger id from list_triggers' }, raw: { type: 'boolean' } }, required: ['id'] }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const id = str(a.id, 80).replace(/^trigger:/, '');
      const all = await everything(ctx, true), t = all.triggers[id];
      if (!t) fail('No trigger "' + id + '". See list_triggers.');
      const labelOf = labeler(all);
      return Object.assign({ id, name: t.options && t.options.name, enabled: !!(t.options && t.options.enabled), notes: t.options && t.options.notes,
        events: (t.events || []).map((e) => ({ type: e.type, enabled: e.enabled !== false, options: e.options })),
        conditions: (t.condition || []).map((e) => describeEntity(e, labelOf)), actions: (t.actions || []).map((e) => describeEntity(e, labelOf)) }, a.raw ? { raw: t } : {});
    }
  },
  {
    name: 'list_connections', title: 'Connections and their status',
    description: 'Every connection (module instance): label, module, on or off, and its status (ok, or the warning or error Companion shows). Labels are what actions, feedbacks and variables use.',
    inputSchema: { type: 'object', properties: { problems_only: { type: 'boolean' } } }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const list = await connections(ctx);
      return list.filter((x) => !a.problems_only || (x.enabled && x.status && x.status.category !== 'good')).map((x) => ({ label: x.label, module: x.module, version: x.version, enabled: x.enabled, status: statusText(x.status) }));
    }
  },
  {
    name: 'get_connection_definitions', title: 'Actions and feedbacks a connection offers',
    description: 'What a connection can do: its actions or feedbacks with ids, descriptions and options (id, type, choices, default). Needed before writing buttons or triggers. Use connection "internal" for Companion\'s own (press a button, set a variable, wait, change page...).',
    inputSchema: { type: 'object', properties: { connection: { type: 'string' }, kind: { type: 'string', enum: ['actions', 'feedbacks'] }, search: { type: 'string' }, id: { type: 'string', description: 'One action or feedback id, with all its options' } }, required: ['connection'] }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const conn = findConn(await connections(ctx), a.connection);
      if (!conn) fail('Unknown connection "' + str(a.connection, 80) + '". See list_connections.');
      const kind = a.kind === 'feedbacks' ? 'feedback' : 'action';
      const defs = (await definitions(ctx, kind))[conn.id] || {};
      const field = (f) => Object.assign({ id: f.id, type: f.type, label: f.label }, f.default !== undefined ? { default: f.default } : {}, f.choices ? { choices: f.choices.slice(0, 60).map((c) => (c.label && c.label !== String(c.id) ? c.id + '=' + c.label : c.id)) } : {}, f.min != null ? { min: f.min } : {}, f.max != null ? { max: f.max } : {});
      if (a.id) {
        const d = defs[str(a.id, 120)];
        if (!d) fail(conn.label + ' has no ' + kind + ' "' + a.id + '"');
        return { connection: conn.label, [kind]: a.id, name: d.label, description: d.description, feedback_type: d.feedbackType || undefined, options: (d.options || []).filter((f) => f.type !== 'static-text').map(field) };
      }
      const ws = words(a.search);
      const list = Object.entries(defs).filter(([id, d]) => !ws.length || matches(ws, id, d.label, d.description)).map(([id, d]) => ({ id, name: d.label, options: (d.options || []).filter((f) => f.type !== 'static-text').map((f) => f.id + (f.type === 'dropdown' ? ' (choice)' : f.type === 'number' ? ' (number)' : f.type === 'checkbox' ? ' (on/off)' : '')).join(', ') || undefined }));
      return { connection: conn.label, module: conn.module, kind: kind + 's', count: list.length, items: list.slice(0, 300), more: list.length > 300 ? 'Narrow it with search' : undefined };
    }
  },
  {
    name: 'get_variables', title: 'Variables and their values',
    description: 'Current variable values from one source: a connection label, "internal", "custom" (custom variables) or "expression". Use them in text or options as $(<source>:<name>).',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, search: { type: 'string' } }, required: ['source'] }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      let label = str(a.source, 100);
      if (!['internal', 'custom', 'expression'].includes(label)) { const c = findConn(await connections(ctx), label); if (!c) fail('Unknown source "' + label + '". Use a connection label, internal, custom or expression.'); label = c.label; }
      const [vals, defs] = await Promise.all([ctx.companion.query('variables.values.connection', { label }), ctx.companion.snapshot('variables.definitions.watch').catch(() => null)]);
      const d = (defs && defs.variables && defs.variables[label]) || {};
      const ws = words(a.search), out = {};
      for (const [k, v] of Object.entries(vals || {})) if (!ws.length || matches(ws, k, d[k] && (d[k].name || d[k].description))) out['$(' + label + ':' + k + ')'] = Object.assign({ value: typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v }, d[k] && (d[k].name || d[k].description) ? { about: d[k].name || d[k].description } : {});
      return Object.keys(out).length ? out : 'No variables' + (ws.length ? ' match' : '') + ' for ' + label + '.';
    }
  },
  {
    name: 'list_custom_variables', title: 'Custom variables',
    description: 'Every custom variable: its current value, start value, description and whether its value survives a restart.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const [all, vals] = await Promise.all([everything(ctx, true), ctx.companion.query('variables.values.connection', { label: 'custom' }).catch(() => ({}))]);
      return Object.entries(all.custom_variables).map(([name, v]) => ({ name, variable: '$(custom:' + name + ')', value: (vals || {})[name], start_value: v.defaultValue, description: v.description || undefined, keeps_value: !!v.persistCurrentValue }));
    }
  },
  {
    name: 'get_log', title: 'Companion\'s log',
    description: 'Recent lines from Companion\'s log, newest last. Filter by level (error, warn, info, debug) and text, for example a connection label.',
    inputSchema: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] }, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, minutes: { type: 'integer', minimum: 1, maximum: 10080 } } }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const m = await ctx.companion.snapshot('logs.watch', undefined, { timeoutMs: 15000 });
      const order = ['error', 'warn', 'info', 'debug', 'silly'], want = a.level ? order.indexOf(a.level) : 2, ws = words(a.search);
      const since = a.minutes ? Date.now() - int(a.minutes, 60, 1, 10080) * 60e3 : 0;
      const lines = ((m && m.lines) || []).filter((l) => (order.indexOf(String(l.level)) < 0 ? true : order.indexOf(String(l.level)) <= want) && l.time >= since && (!ws.length || matches(ws, l.source, l.message)));
      return lines.slice(-int(a.limit, 100, 1, 500)).map((l) => new Date(l.time).toISOString().slice(0, 19).replace('T', ' ') + ' ' + String(l.level).toUpperCase() + ' ' + l.source + ': ' + String(l.message).slice(0, 500)).join('\n') || 'No log lines match.';
    }
  },
  {
    name: 'list_trigger_event_types', title: 'What can start a trigger',
    description: 'The event types a trigger can use (interval, time of day, startup, button press, variable changed...) with their options, for save_trigger.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    async run(a, ctx) {
      const defs = (await ctx.companion.query('instances.definitions.events')) || {};
      return Object.entries(defs).map(([type, d]) => ({ type, name: d.name, description: d.description, options: (d.options || []).filter((f) => f.type !== 'static-text').map((f) => Object.assign({ id: f.id, type: f.type }, f.default !== undefined ? { default: f.default } : {}, f.choices ? { choices: f.choices.slice(0, 40).map((c) => c.id) } : {})) }));
    }
  },

  // ----- Help build -----
  {
    name: 'save_button', title: 'Create or change a button', needs: 'edit',
    description: 'Create a button, or change the one at that location. Simple form: text, background, text_color, text_size, press_actions, release_actions, feedbacks (changing an existing button keeps what you leave out; mode "replace" starts from an empty button). ' + ACTION_SPEC + ' ' + FEEDBACK_SPEC +
      ' Or give config: Companion\'s own button config (get_button with raw: true), for steps, hold actions and layers. The page briefly redraws while it is written. Backed up first; the person is asked to keep or revert it.',
    inputSchema: { type: 'object', properties: Object.assign({}, LOC_PROPS, {
      text: { type: 'string', description: 'Button text. Variables work: $(atem:pgm)' }, text_expression: { type: 'string', description: 'Text as an expression instead' },
      background: { type: 'string', description: '#rrggbb' }, text_color: { type: 'string' }, text_size: { description: 'Number (100 is normal) or "auto"' },
      press_actions: { type: 'array', items: { type: 'object' } }, release_actions: { type: 'array', items: { type: 'object' } }, feedbacks: { type: 'array', items: { type: 'object' } },
      notes: { type: 'string' }, mode: { type: 'string', enum: ['change', 'replace'] }, config: { type: 'object', description: 'Companion\'s own button config instead of the simple fields' }
    }), required: LOC_REQ },
    annotations: { destructiveHint: false },
    async run(a, ctx) {
      const loc = readLoc(a);
      guardPage(ctx, loc.page);
      await checkOnGrid(ctx, loc);
      const all = await everything(ctx, true);
      const before = controlAt(all, loc.page, loc.row, loc.column);
      const { ctl, notes } = await buttonFromArgs(ctx, a, before, all);
      const backup = backupButton(ctx, loc, before, 'before-change');
      await writeButtons(ctx, loc.page, { [loc.row + '/' + loc.column]: ctl });
      const after = controlAt(await everything(ctx, true), loc.page, loc.row, loc.column);
      if (!after) fail('Companion did not keep the button. Check the config, or read the log with get_log.');
      const review = ctx.onChange && ctx.onChange({ kind: 'button', id: locKey(loc.page, loc.row, loc.column), alias: buttonName(loc, after), before, after, backup });
      return { saved: locText(loc.page, loc.row, loc.column), [before ? 'changed' : 'created']: true, text: buttonText(after), notes: notes.length ? notes : undefined, review: review || undefined };
    }
  },
  {
    name: 'copy_button', title: 'Copy a button', needs: 'edit',
    description: 'Copy a button, with all its actions and feedbacks, to another location (on the same or another page). Whatever is at the destination is replaced (backed up first).',
    inputSchema: { type: 'object', properties: { from_page: { type: 'integer' }, from_row: { type: 'integer' }, from_column: { type: 'integer' }, to_page: { type: 'integer' }, to_row: { type: 'integer' }, to_column: { type: 'integer' } }, required: ['from_page', 'from_row', 'from_column', 'to_page', 'to_row', 'to_column'] },
    async run(a, ctx) {
      const from = readLoc({ page: a.from_page, row: a.from_row, column: a.from_column }), to = readLoc({ page: a.to_page, row: a.to_row, column: a.to_column });
      guardPage(ctx, to.page);
      await checkOnGrid(ctx, to);
      const all = await everything(ctx, true);
      const src = controlAt(all, from.page, from.row, from.column);
      if (!src) fail('There is no button at ' + locText(from.page, from.row, from.column));
      guardEntities(ctx, allEntitiesOfButton(src), 'This button');
      const before = controlAt(all, to.page, to.row, to.column);
      const backup = backupButton(ctx, to, before, 'before-change');
      await writeButtons(ctx, to.page, { [to.row + '/' + to.column]: src });
      const after = controlAt(await everything(ctx, true), to.page, to.row, to.column);
      const review = ctx.onChange && ctx.onChange({ kind: 'button', id: locKey(to.page, to.row, to.column), alias: buttonName(to, after), before, after, backup });
      return { copied: locText(from.page, from.row, from.column) + ' -> ' + locText(to.page, to.row, to.column), review: review || undefined };
    }
  },
  {
    name: 'save_page', title: 'Add or rename a page', needs: 'edit',
    description: 'Add a new page (it gets Companion\'s page up / number / down buttons), or rename one. Give page to rename it, or leave page out to add one at the end.',
    inputSchema: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, name: { type: 'string' } }, required: ['name'] },
    async run(a, ctx) {
      const name = str(a.name, 60); if (!name) fail('Give the page a name');
      const all = await everything(ctx, true), count = Object.keys(all.pages).length;
      if (a.page != null) {
        const page = int(a.page, 0, 1, 9999), p = pageOf(all, page);
        guardPage(ctx, page);
        const before = { name: p.name, page }, backup = ctx.backups.save('page', p.id || 'page' + page, { name: p.name, page, pageId: p.id, rename: true }, 'before-change');
        await ctx.companion.mutate('pages.setName', { pageNumber: page, name });
        forget(ctx);
        const review = ctx.onChange && ctx.onChange({ kind: 'page', id: p.id || 'page' + page, alias: 'Page ' + page + ' "' + name + '"', before, after: { name, page }, backup });
        return { renamed: page, name, review: review || undefined };
      }
      await ctx.companion.mutate('pages.insert', { asPageNumber: count + 1, pageNames: [name] });
      forget(ctx);
      const p = (await everything(ctx, true)).pages[count + 1];
      const review = ctx.onChange && ctx.onChange({ kind: 'page', id: (p && p.id) || 'page' + (count + 1), alias: 'Page ' + (count + 1) + ' "' + name + '"', before: null, after: { name, page: count + 1 } });
      return { added: count + 1, name, review: review || undefined };
    }
  },
  {
    name: 'save_trigger', title: 'Create or change a trigger', needs: 'edit',
    description: 'Create a trigger, or change one (give its id). Simple form: name, events ([{ "type": "<from list_trigger_event_types>", "options": {...} }]), conditions (feedbacks that must all be true), actions, enabled. ' + ACTION_SPEC +
      ' Or give config: Companion\'s own trigger config (get_trigger with raw: true). Below Hands on, triggers are saved switched off, because a running trigger acts on the show; the person switches it on. Backed up first; the person is asked to keep or revert it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, notes: { type: 'string' }, events: { type: 'array', items: { type: 'object' } }, conditions: { type: 'array', items: { type: 'object' } }, actions: { type: 'array', items: { type: 'object' } }, config: { type: 'object' } } },
    async run(a, ctx) {
      const all = await everything(ctx, true);
      const id = a.id ? str(a.id, 80).replace(/^trigger:/, '') : newId().replace(/[^A-Za-z0-9_-]/g, '');
      if (!TRIGGER_ID_RE.test(id)) fail('Unexpected trigger id');
      const before = all.triggers[id] || null;
      if (a.id && !before) fail('No trigger "' + id + '". Leave id out to create one.');
      const notes = [];
      let t;
      if (a.config) {
        t = clone(a.config);
        t.type = 'trigger';
        t.options = Object.assign({ name: 'Trigger', enabled: false, sortOrder: 0 }, t.options || {});
        t.actions = await Promise.all((t.actions || []).map((e) => fixEntity(ctx, e, all, notes)));
        t.condition = await Promise.all((t.condition || []).map((e) => fixEntity(ctx, e, all, notes)));
        t.localVariables = await Promise.all((t.localVariables || []).map((e) => fixEntity(ctx, e, all, notes)));
        t.events = (t.events || []).map((e) => Object.assign({ id: newId(), enabled: true, options: {} }, e));
      } else {
        t = before ? clone(before) : { type: 'trigger', options: { name: 'New trigger', enabled: false, sortOrder: Object.keys(all.triggers).length }, actions: [], condition: [], events: [], localVariables: [] };
        if (a.name != null) t.options.name = str(a.name, 100);
        if (a.notes != null) t.options.notes = str(a.notes, 2000);
        if (Array.isArray(a.events)) {
          const types = (await ctx.companion.query('instances.definitions.events').catch(() => null)) || null;
          t.events = a.events.map((e) => {
            const type = str(e && e.type, 60);
            if (types && !types[type]) fail('Unknown event type "' + type + '". See list_trigger_event_types.');
            const opts = {};
            for (const f of ((types && types[type] && types[type].options) || [])) if (f.default !== undefined) opts[f.id] = clone(f.default);
            return { id: newId(), type, enabled: e.enabled !== false, options: Object.assign(opts, e.options || {}) };
          });
        }
        if (Array.isArray(a.conditions)) t.condition = await Promise.all(a.conditions.map((x) => buildEntity(ctx, x, 'feedback', all, notes)));
        if (Array.isArray(a.actions)) t.actions = await Promise.all(a.actions.map((x) => buildEntity(ctx, x, 'action', all, notes)));
      }
      const wantOn = a.enabled != null ? !!a.enabled : !!(a.config && a.config.options && a.config.options.enabled) || !!(before && before.options && before.options.enabled);
      const access = ctx.access();
      if (wantOn && !access.press && !(before && before.options && before.options.enabled)) { t.options.enabled = false; notes.push('Saved switched off: switching a trigger on needs Hands on. The person can switch it on in Companion.'); }
      else t.options.enabled = wantOn;
      guardEntities(ctx, [].concat(t.actions || [], t.condition || []), 'This trigger');
      const backup = before ? ctx.backups.save('trigger', id, { name: (before.options && before.options.name) || id, id, trigger: before }, 'before-change') : null;
      try { await writeTrigger(ctx, id, t); }
      catch (e) { if (before) { try { await writeTrigger(ctx, id, before); } catch (x) { /* backup has it */ } } throw e; }
      const after = (await everything(ctx, true)).triggers[id] || null;
      if (!after) fail('Companion did not keep the trigger. Check the events and actions, or read the log with get_log.');
      const review = ctx.onChange && ctx.onChange({ kind: 'trigger', id, alias: after.options.name, before, after, backup });
      return { saved: id, name: after.options.name, enabled: !!after.options.enabled, [before ? 'changed' : 'created']: true, notes: notes.length ? notes : undefined, review: review || undefined };
    }
  },
  {
    name: 'save_custom_variable', title: 'Create or change a custom variable', needs: 'edit',
    description: 'Create a custom variable, or change its start value, description or whether its value survives a restart. (Setting its current value is set_custom_variable_value, Hands on.)',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Letters, digits and _' }, start_value: {}, description: { type: 'string' }, keeps_value: { type: 'boolean' } }, required: ['name'] },
    async run(a, ctx) {
      const name = str(a.name, 100); if (!VAR_NAME_RE.test(name)) fail('A custom variable name uses only letters, digits and _');
      const all = await everything(ctx, true), cur = all.custom_variables[name];
      const before = cur ? { name, start_value: cur.defaultValue, description: cur.description || '', keeps_value: !!cur.persistCurrentValue } : null;
      const backup = before ? ctx.backups.save('variable', name, Object.assign({ variable: true }, before), 'before-change') : null;
      const cp = ctx.companion;
      if (!cur) { const err = await cp.mutate('customVariables.create', { name, defaultVal: a.start_value == null ? '' : String(a.start_value) }); if (err) fail('Companion: ' + err); }
      else if (a.start_value !== undefined) await cp.mutate('customVariables.setDefault', { name, value: a.start_value });
      if (a.description != null) await cp.mutate('customVariables.setDescription', { name, description: str(a.description, 300) });
      if (typeof a.keeps_value === 'boolean') await cp.mutate('customVariables.setPersistence', { name, value: a.keeps_value });
      forget(ctx);
      const now = (await everything(ctx, true)).custom_variables[name];
      const after = now ? { name, start_value: now.defaultValue, description: now.description || '', keeps_value: !!now.persistCurrentValue } : null;
      const review = ctx.onChange && ctx.onChange({ kind: 'variable', id: name, alias: '$(custom:' + name + ')', before, after, backup });
      return { saved: '$(custom:' + name + ')', [before ? 'changed' : 'created']: true, review: review || undefined };
    }
  },

  // ----- Hands on -----
  {
    name: 'press_button', title: 'Press a button', needs: 'press',
    description: 'Press a button as if someone pushed it on a Stream Deck: runs its actions on the real equipment. how: press (default; down then up), down, up, rotate_left, rotate_right.',
    inputSchema: { type: 'object', properties: Object.assign({}, LOC_PROPS, { how: { type: 'string', enum: ['press', 'down', 'up', 'rotate_left', 'rotate_right'] } }), required: LOC_REQ },
    annotations: { destructiveHint: true },
    async run(a, ctx) {
      const loc = readLoc(a);
      guardPage(ctx, loc.page);
      const all = await everything(ctx);
      if (!controlAt(all, loc.page, loc.row, loc.column)) fail('There is no button at ' + locText(loc.page, loc.row, loc.column));
      const location = { pageNumber: loc.page, row: loc.row, column: loc.column }, surfaceId = 'livecompanion-claude', how = a.how || 'press', cp = ctx.companion;
      if (how === 'rotate_left' || how === 'rotate_right') await cp.mutate('controls.hotRotateControl', { location, direction: how === 'rotate_right', surfaceId });
      else {
        if (how !== 'up') await cp.mutate('controls.hotPressControl', { location, direction: true, surfaceId });
        if (how === 'press') await sleep(ctx.pressMs == null ? 120 : ctx.pressMs);
        if (how !== 'down') await cp.mutate('controls.hotPressControl', { location, direction: false, surfaceId });
      }
      return { pressed: locText(loc.page, loc.row, loc.column), how };
    }
  },
  {
    name: 'run_trigger', title: 'Run a trigger\'s actions now', needs: 'press',
    description: 'Run a trigger\'s actions right now, without waiting for its events or checking its conditions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { destructiveHint: true },
    async run(a, ctx) {
      const id = str(a.id, 80).replace(/^trigger:/, ''), all = await everything(ctx, true), t = all.triggers[id];
      if (!t) fail('No trigger "' + id + '"');
      guardEntities(ctx, t.actions || [], 'This trigger');
      await ctx.companion.mutate('controls.triggers.testActions', { controlId: 'trigger:' + id });
      return { ran: id, name: t.options && t.options.name };
    }
  },
  {
    name: 'set_trigger_enabled', title: 'Switch a trigger on or off', needs: 'press',
    description: 'Switch a trigger on (it then runs by itself when its events happen) or off.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] },
    async run(a, ctx) {
      const id = str(a.id, 80).replace(/^trigger:/, ''), all = await everything(ctx, true), t = all.triggers[id];
      if (!t) fail('No trigger "' + id + '"');
      if (a.enabled) guardEntities(ctx, t.actions || [], 'This trigger');
      await ctx.companion.mutate('controls.setOptionsField', { controlId: 'trigger:' + id, key: 'enabled', value: !!a.enabled });
      forget(ctx);
      return { trigger: id, name: t.options && t.options.name, enabled: !!a.enabled };
    }
  },
  {
    name: 'set_custom_variable_value', title: 'Set a custom variable\'s value', needs: 'press',
    description: 'Set the current value of a custom variable. Buttons, feedbacks and triggers that use it react at once.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] },
    async run(a, ctx) {
      const name = str(a.name, 100).replace(/^\$\(custom:(.+)\)$/, '$1');
      const r = await ctx.companion.mutate('customVariables.setCurrent', { name, value: a.value });
      if (r) fail('Companion: ' + r + '. See list_custom_variables.');
      return { set: '$(custom:' + name + ')', value: a.value };
    }
  },
  {
    name: 'set_connection_enabled', title: 'Switch a connection on or off', needs: 'press',
    description: 'Switch a connection on or off. Off stops Companion talking to that device; switching it off and on again restarts the connection.',
    inputSchema: { type: 'object', properties: { connection: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['connection', 'enabled'] },
    async run(a, ctx) {
      const c = findConn(await connections(ctx), a.connection);
      if (!c || c.id === 'internal') fail('Unknown connection "' + str(a.connection, 80) + '"');
      await ctx.companion.mutate('instances.connections.setEnabled', { connectionId: c.id, enabled: !!a.enabled });
      delete ctx.cache.conns;
      return { connection: c.label, enabled: !!a.enabled };
    }
  },

  // ----- Full -----
  {
    name: 'delete_button', title: 'Delete a button', needs: 'delete',
    description: 'Delete the button at a location. It is backed up first; the person can revert it.',
    inputSchema: { type: 'object', properties: LOC_PROPS, required: LOC_REQ }, annotations: { destructiveHint: true },
    async run(a, ctx) {
      const loc = readLoc(a);
      guardPage(ctx, loc.page);
      const before = controlAt(await everything(ctx, true), loc.page, loc.row, loc.column);
      if (!before) fail('There is no button at ' + locText(loc.page, loc.row, loc.column));
      const backup = backupButton(ctx, loc, before, 'before-delete');
      await ctx.companion.mutate('controls.resetControls', { locations: [{ pageNumber: loc.page, row: loc.row, column: loc.column }], newType: null });
      forget(ctx);
      const review = ctx.onChange && ctx.onChange({ kind: 'button', id: locKey(loc.page, loc.row, loc.column), alias: buttonName(loc, before), before, after: null, backup });
      return { deleted: locText(loc.page, loc.row, loc.column), review: review || undefined };
    }
  },
  {
    name: 'delete_trigger', title: 'Delete a trigger', needs: 'delete',
    description: 'Delete a trigger. It is backed up first; the person can revert it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { destructiveHint: true },
    async run(a, ctx) {
      const id = str(a.id, 80).replace(/^trigger:/, ''), before = (await everything(ctx, true)).triggers[id];
      if (!before) fail('No trigger "' + id + '"');
      const backup = ctx.backups.save('trigger', id, { name: (before.options && before.options.name) || id, id, trigger: before }, 'before-delete');
      await ctx.companion.mutate('controls.triggers.delete', { controlId: 'trigger:' + id });
      forget(ctx);
      const review = ctx.onChange && ctx.onChange({ kind: 'trigger', id, alias: (before.options && before.options.name) || id, before, after: null, backup });
      return { deleted: id, review: review || undefined };
    }
  },
  {
    name: 'delete_custom_variable', title: 'Delete a custom variable', needs: 'delete',
    description: 'Delete a custom variable. Buttons that show it show nothing. It is backed up first; the person can revert it.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, annotations: { destructiveHint: true },
    async run(a, ctx) {
      const name = str(a.name, 100), cur = (await everything(ctx, true)).custom_variables[name];
      if (!cur) fail('No custom variable "' + name + '"');
      const before = { name, start_value: cur.defaultValue, description: cur.description || '', keeps_value: !!cur.persistCurrentValue };
      const backup = ctx.backups.save('variable', name, Object.assign({ variable: true }, before), 'before-delete');
      await ctx.companion.mutate('customVariables.delete', { name });
      forget(ctx);
      const review = ctx.onChange && ctx.onChange({ kind: 'variable', id: name, alias: '$(custom:' + name + ')', before, after: null, backup });
      return { deleted: '$(custom:' + name + ')', review: review || undefined };
    }
  }
];

const INSTRUCTIONS = [
  'LiveCompanion development mode connects you to the person\'s central Bitfocus Companion (version 5) for building and troubleshooting: buttons, pages, triggers, variables and connections. It is used to prepare shows, often at a church; treat anything that presses buttons or runs triggers as acting on live equipment (cameras, video switchers, lights, audio).',
  'Start with get_overview. Locations are page / row / column, with row and column counted from 0 at the top left. Connection labels (list_connections) are what actions, feedbacks and $(label:variable) use.',
  'Before writing a button or trigger, look up the action and feedback ids and their options with get_connection_definitions; read the existing button or trigger first and change only what was asked.',
  'Changes are backed up before they are saved. When change review is on, each change goes live at once and the person is asked in LiveCompanion to keep or revert it; the tool result says so, and get_overview lists changes waiting for review and recent reverts. If a change of yours was reverted, do not simply make it again: ask the person what they want instead.',
  'Saving a button briefly redraws its page in Companion, and resets any buttons on that page that were part way through their steps. Do not change pages during a service unless the person asks.',
  'Protected pages can be read but not changed or pressed, at any level; do not try to work around this. Tools that change or press things are only listed when the person allowed them. Ask before deleting anything.'
].join('\n');

/** Undo one reviewed change (Revert). r: { kind, id, before, after, action } */
async function revert(ctx, r) {
  if (r.kind === 'button') {
    const loc = parseLocKey(r.id); if (!loc) fail('Unknown button');
    const now = controlAt(await everything(ctx, true), loc.page, loc.row, loc.column);
    if (now) backupButton(ctx, loc, now, 'before-revert');
    if (r.action === 'deleted' || r.action === 'changed') await writeButtons(ctx, loc.page, { [loc.row + '/' + loc.column]: r.before });
    else if (now) await ctx.companion.mutate('controls.resetControls', { locations: [{ pageNumber: loc.page, row: loc.row, column: loc.column }], newType: null });
  } else if (r.kind === 'trigger') {
    const now = (await everything(ctx, true)).triggers[r.id];
    if (now) ctx.backups.save('trigger', r.id, { name: (now.options && now.options.name) || r.id, id: r.id, trigger: now }, 'before-revert');
    await writeTrigger(ctx, r.id, r.before || null);
  } else if (r.kind === 'variable') await restoreVariable(ctx, r.id, r.before);
  else if (r.kind === 'page') {
    const all = await everything(ctx, true);
    const num = Object.entries(all.pages).find(([n, p]) => p.id === r.id || 'page' + n === r.id);
    const pageNumber = num ? +num[0] : (r.after && r.after.page);
    if (r.action === 'created') {
      if (pageNumber) {
        const p = all.pages[pageNumber];
        const used = Object.values(p.controls || {}).some((cols) => Object.values(cols || {}).some((c) => c && !['pageup', 'pagedown', 'pagenum'].includes(c.type)));
        if (used) fail('The page has buttons on it now. Delete or revert those first, or keep the page.');
        await ctx.companion.mutate('pages.remove', { pageNumber });
      }
    } else if (r.before && pageNumber) await ctx.companion.mutate('pages.setName', { pageNumber, name: r.before.name });
  }
  forget(ctx);
}
async function restoreVariable(ctx, name, before) {
  const cp = ctx.companion, all = await everything(ctx, true), cur = all.custom_variables[name];
  if (cur) ctx.backups.save('variable', name, { variable: true, name, start_value: cur.defaultValue, description: cur.description || '', keeps_value: !!cur.persistCurrentValue }, 'before-revert');
  if (!before) { if (cur) await cp.mutate('customVariables.delete', { name }); return; }
  if (!cur) { const err = await cp.mutate('customVariables.create', { name, defaultVal: before.start_value == null ? '' : String(before.start_value) }); if (err) fail('Companion: ' + err); }
  else await cp.mutate('customVariables.setDefault', { name, value: before.start_value });
  await cp.mutate('customVariables.setDescription', { name, description: before.description || '' });
  await cp.mutate('customVariables.setPersistence', { name, value: !!before.keeps_value });
}
/** Put a backup back (Backups page). */
async function restore(ctx, kind, id, saved) {
  if (kind === 'button') {
    const loc = parseLocKey(id); if (!loc || !saved.control) fail('That backup cannot be restored');
    const now = controlAt(await everything(ctx, true), loc.page, loc.row, loc.column);
    if (now) backupButton(ctx, loc, now, 'before-restore');
    await writeButtons(ctx, loc.page, { [loc.row + '/' + loc.column]: saved.control });
  } else if (kind === 'trigger') {
    const now = (await everything(ctx, true)).triggers[id];
    if (now) ctx.backups.save('trigger', id, { name: (now.options && now.options.name) || id, id, trigger: now }, 'before-restore');
    await writeTrigger(ctx, id, saved.trigger);
  } else if (kind === 'variable') await restoreVariable(ctx, id, saved);
  else if (kind === 'page') {
    const all = await everything(ctx, true);
    const num = Object.entries(all.pages).find(([, p]) => p.id === saved.pageId);
    if (!num) fail('That page is gone');
    await ctx.companion.mutate('pages.setName', { pageNumber: +num[0], name: saved.name });
  }
  forget(ctx);
}

function create(base) {
  const cache = {};
  const ctx = Object.assign({ cache }, base);
  delete ctx.onChange; // bound per call, with who is asking
  const describe = (a) => ({ level: a.level, can_build: !!a.edit, can_press_and_run: !!a.press, can_delete: !!a.delete, protected_pages: a.protectedPages || [] });
  ctx.describeAccess = () => describe(base.access());
  const enabled = (t, access) => !t.needs || !!(access || base.access())[t.needs];

  function list(access) { return TOOLS.filter((t) => enabled(t, access)); }

  async function call(name, args, access, who) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) return { isError: true, text: 'Unknown tool ' + name };
    if (!enabled(t, access)) return { isError: true, text: name + ' is not allowed for this connection. The person can change that in LiveCompanion (Development mode > Permissions).' };
    const c = Object.assign(Object.create(ctx), access ? { access: () => access, describeAccess: () => describe(access) } : {}, base.onChange ? { onChange: (info) => base.onChange(info, who) } : {});
    try {
      const r = await t.run(args || {}, c);
      return { isError: false, text: fit(r == null ? 'Done' : r) };
    } catch (e) {
      return { isError: true, text: e instanceof ToolError ? e.message : (e && e.message) || String(e) };
    }
  }

  /** For the dashboard: is Companion there, which version, how big. Companion 5 or newer only. */
  async function probe() {
    const ver = await ctx.companion.query('appInfo.version', undefined, { timeoutMs: 8000 });
    const v = String((ver && ver.appVersion) || '');
    const major = parseInt(v, 10);
    if (major && major < 5) throw new Error('This is Companion ' + v + '. Development mode needs Companion 5 or newer; update it from LiveCompanion\'s dashboard first.');
    const out = { version: v || 'unknown' };
    try {
      const [all, conns] = await Promise.all([everything(ctx, true), connections(ctx)]);
      out.pages = Object.keys(all.pages).length; out.connections = conns.length;
      out.connErrors = conns.filter((x) => x.enabled && x.status && x.status.category === 'error').length;
    } catch (e) { out.warning = e.message; }
    return out;
  }

  /** What the person sees in the before and after of a change: the readable form, with connection labels. */
  function view(kind, x) {
    if (x == null) return null;
    const all = ctx.cache.all && ctx.cache.all.v;
    const labelOf = all ? labeler(all) : (cid) => cid;
    if (kind === 'button') return describeButton(x, labelOf);
    if (kind === 'trigger') return { name: x.options && x.options.name, enabled: !!(x.options && x.options.enabled), events: (x.events || []).map((e) => ({ type: e.type, enabled: e.enabled !== false, options: e.options })), conditions: (x.condition || []).map((e) => describeEntity(e, labelOf)), actions: (x.actions || []).map((e) => describeEntity(e, labelOf)) };
    return x;
  }

  return {
    list, call, all: () => TOOLS, ctx, INSTRUCTIONS, probe, view,
    revert: (r) => revert(ctx, r),
    restore: (kind, id, saved) => restore(ctx, kind, id, saved)
  };
}

module.exports = { create, INSTRUCTIONS, TOOLS, fit, buttonText, describeButton, newButton, locKey, parseLocKey };
