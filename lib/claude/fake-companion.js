/*
 * A pretend Companion 5, in memory: for demo mode (node server.js --demo) and the tests.
 * It answers the same tRPC paths and HTTP routes LiveCompanion's tools use, with a small
 * church setup (ATEM, ProPresenter, an SQ-5, OBS). Nothing here talks to real equipment.
 */
'use strict';
const crypto = require('crypto');

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const id = () => crypto.randomBytes(6).toString('base64url');
const E = (v) => ({ value: v, isExpression: false });

function layers(text, bg, fg) {
  return [
    { id: 'canvas', type: 'canvas', name: 'Canvas', usage: 'auto', decoration: E('default'), showStatusIcons: E('default') },
    { id: 'box0', type: 'box', name: 'Background', usage: 'auto', enabled: E(true), color: E(bg == null ? 0 : bg) },
    { id: 'text0', type: 'text', name: 'Text', usage: 'auto', enabled: E(true), text: E(text), color: E(fg == null ? 0xffffff : fg), fontsize: E(100) }
  ];
}
function action(conn, def, opts) { return { type: 'action', id: id(), definitionId: def, connectionId: conn, options: Object.fromEntries(Object.entries(opts || {}).map(([k, v]) => [k, E(v)])), upgradeIndex: 3 }; }
function feedback(conn, def, opts, bg) { return { type: 'feedback', id: id(), definitionId: def, connectionId: conn, options: Object.fromEntries(Object.entries(opts || {}).map(([k, v]) => [k, E(v)])), upgradeIndex: 3, styleOverrides: bg == null ? [] : [{ overrideId: id(), elementId: 'box0', elementProperty: 'color', override: E(bg) }] }; }
function button(text, bg, down, fbs) {
  return { type: 'button-layered', options: { stepProgression: 'auto', rotaryActions: false, canModifyStyleInApis: false }, style: { layers: layers(text, bg) }, feedbacks: fbs || [], steps: { 0: { action_sets: { down: down || [], up: [] }, options: { runWhileHeld: [] } } }, localVariables: [] };
}
const nav = () => ({ 0: { 0: { type: 'pageup' } }, 1: { 0: { type: 'pagenum' } }, 2: { 0: { type: 'pagedown' } } });

function model() {
  const m = {
    version: '5.1.1',
    gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 },
    connections: {
      c_atem: { id: 'c_atem', label: 'atem', moduleId: 'bmd-atem', moduleVersionId: '3.14.1', enabled: true, lastUpgradeIndex: 3 },
      c_pro: { id: 'c_pro', label: 'propresenter', moduleId: 'renewedvision-propresenter-api', moduleVersionId: '2.6.0', enabled: true, lastUpgradeIndex: 3 },
      c_sq: { id: 'c_sq', label: 'sq5', moduleId: 'allenheath-sq', moduleVersionId: '3.1.0', enabled: true, lastUpgradeIndex: 3 },
      c_obs: { id: 'c_obs', label: 'obs', moduleId: 'obs-studio', moduleVersionId: '3.12.0', enabled: true, lastUpgradeIndex: 3 }
    },
    statuses: { c_atem: { category: 'good', level: 'ok', message: null }, c_pro: { category: 'good', level: 'ok', message: null }, c_sq: { category: 'error', level: 'Connection Failure', message: 'connect ETIMEDOUT 10.20.30.15:51326' }, c_obs: { category: 'warning', level: 'Disconnected', message: 'OBS is not running' } },
    pages: [], triggers: {}, customVars: {}, customValues: {}, presses: [], logs: [], imports: 0, pending: null, upload: null
  };
  const p1 = { id: 'pg_sun', name: 'Sunday', controls: nav() };
  p1.controls[0][1] = button('WALK IN', 0x003366, [action('c_pro', 'trigger_playlist', { playlist: 'Walk In' }), action('c_atem', 'program', { mixeffect: 0, input: 3 })]);
  p1.controls[0][2] = button('SERMON', 0x333333, [action('c_atem', 'program', { mixeffect: 0, input: 1 }), action('c_sq', 'mute_on', { channel: 12 })], [feedback('c_atem', 'program_tally', { mixeffect: 0, input: 1 }, 0xcc0000)]);
  p1.controls[0][3] = button('WORSHIP', 0x333333, [action('c_atem', 'program', { mixeffect: 0, input: 2 }), action('c_sq', 'mute_off', { channel: 12 })]);
  p1.controls[1][1] = button('GO LIVE', 0x006600, [action('c_obs', 'start_streaming', {}), action('internal', 'custom_variable_set_value', { name: 'service_live', value: '1' })]);
  const p2 = { id: 'pg_cam', name: 'Cameras', controls: nav() };
  [1, 2, 3, 4].forEach((n, i) => { p2.controls[0][i + 1] = button('CAM ' + n, 0x222222, [action('c_atem', 'program', { mixeffect: 0, input: n })], [feedback('c_atem', 'program_tally', { mixeffect: 0, input: n }, 0xcc0000)]); });
  p2.controls[1][1] = button('$(atem:pgm1_input)', 0x000000, []);
  const p3 = { id: 'pg_aud', name: 'Audio', controls: nav() };
  p3.controls[0][1] = button('PASTOR MIC', 0x444400, [action('c_sq', 'mute_toggle', { channel: 12 })]);
  m.pages.push(p1, p2, p3);
  m.triggers.t_count = { type: 'trigger', options: { name: 'Countdown at 9:55', enabled: true, sortOrder: 0 }, events: [{ id: id(), type: 'timeofday', enabled: true, options: { time: '09:55:00', days: [0] } }], condition: [], actions: [action('c_pro', 'trigger_playlist', { playlist: 'Countdown' })], localVariables: [] };
  m.triggers.t_live = { type: 'trigger', options: { name: 'Stream started', enabled: false, sortOrder: 1 }, events: [{ id: id(), type: 'variable_changed', enabled: true, options: { variableId: 'obs:streaming' } }], condition: [], actions: [action('internal', 'custom_variable_set_value', { name: 'service_live', value: '1' })], localVariables: [] };
  m.customVars.service_live = { defaultValue: '0', description: 'Set to 1 while the service is streaming', persistCurrentValue: false, sortOrder: 0 };
  m.customValues.service_live = '0';
  const now = Date.now();
  m.logs = [
    { time: now - 600e3, source: 'Instance/sq5', level: 'error', message: 'connect ETIMEDOUT 10.20.30.15:51326' },
    { time: now - 300e3, source: 'Instance/obs', level: 'warn', message: 'Disconnected from OBS websocket' },
    { time: now - 60e3, source: 'Instance/atem', level: 'info', message: 'Connected to ATEM Mini Extreme ISO' }
  ];
  return m;
}

const DEFS = {
  action: {
    c_atem: { program: { label: 'Set program input', options: [{ id: 'mixeffect', type: 'number', label: 'M/E', default: 0, min: 0, max: 3 }, { id: 'input', type: 'dropdown', label: 'Input', default: 1, choices: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, label: 'Cam ' + n })) }] }, preview: { label: 'Set preview input', options: [{ id: 'mixeffect', type: 'number', label: 'M/E', default: 0 }, { id: 'input', type: 'number', label: 'Input', default: 1 }] }, cut: { label: 'Cut', options: [{ id: 'mixeffect', type: 'number', label: 'M/E', default: 0 }] }, auto: { label: 'Auto transition', options: [{ id: 'mixeffect', type: 'number', label: 'M/E', default: 0 }] } },
    c_pro: { trigger_playlist: { label: 'Trigger playlist', options: [{ id: 'playlist', type: 'textinput', label: 'Playlist', default: '' }] }, next_slide: { label: 'Next slide', options: [] }, prev_slide: { label: 'Previous slide', options: [] } },
    c_sq: { mute_on: { label: 'Mute on', options: [{ id: 'channel', type: 'number', label: 'Input', default: 1, min: 1, max: 48 }] }, mute_off: { label: 'Mute off', options: [{ id: 'channel', type: 'number', label: 'Input', default: 1 }] }, mute_toggle: { label: 'Mute toggle', options: [{ id: 'channel', type: 'number', label: 'Input', default: 1 }] } },
    c_obs: { start_streaming: { label: 'Start streaming', options: [] }, stop_streaming: { label: 'Stop streaming', options: [] }, set_scene: { label: 'Set program scene', options: [{ id: 'scene', type: 'textinput', label: 'Scene', default: '' }] } },
    internal: { button_pressrelease: { label: 'Press and release a button', options: [{ id: 'location', type: 'textinput', label: 'Location', default: '$(this:page)/$(this:row)/$(this:column)' }] }, custom_variable_set_value: { label: 'Set custom variable', options: [{ id: 'name', type: 'custom-variable', label: 'Variable', default: '' }, { id: 'value', type: 'textinput', label: 'Value', default: '' }] }, wait: { label: 'Wait', options: [{ id: 'time', type: 'number', label: 'Milliseconds', default: 1000 }] }, set_page: { label: 'Set surface to page', options: [{ id: 'page', type: 'number', label: 'Page', default: 1 }] } }
  },
  feedback: {
    c_atem: { program_tally: { label: 'Program tally', feedbackType: 'boolean', options: [{ id: 'mixeffect', type: 'number', label: 'M/E', default: 0 }, { id: 'input', type: 'number', label: 'Input', default: 1 }] } },
    c_obs: { streaming: { label: 'Streaming', feedbackType: 'boolean', options: [] } },
    internal: { variable_value: { label: 'Variable has value', feedbackType: 'boolean', options: [{ id: 'variable', type: 'textinput', label: 'Variable', default: '' }, { id: 'value', type: 'textinput', label: 'Value', default: '' }] } }
  }
};
const EVENTS = { interval: { name: 'Every X seconds', options: [{ id: 'seconds', type: 'number', default: 10 }] }, timeofday: { name: 'Time of day', options: [{ id: 'time', type: 'textinput', default: '00:00:00' }, { id: 'days', type: 'multidropdown', default: [0, 1, 2, 3, 4, 5, 6] }] }, startup: { name: 'Startup', options: [{ id: 'delay', type: 'number', default: 10000 }] }, variable_changed: { name: 'On variable change', options: [{ id: 'variableId', type: 'textinput', default: '' }] }, button_press: { name: 'On any button press', options: [] } };

function create() {
  let m = model();
  const pageFile = (n) => {
    const p = m.pages[n - 1];
    return { id: p.id, name: p.name, controls: clone(p.controls), gridSize: clone(m.gridSize), pageVariables: [] };
  };
  const instances = (only) => {
    const out = {};
    for (const c of Object.values(m.connections)) if (!only || only.has(c.id)) out[c.id] = { label: c.label, moduleId: c.moduleId, moduleVersionId: c.moduleVersionId, lastUpgradeIndex: c.lastUpgradeIndex, enabled: c.enabled, config: { host: '10.20.30.' + (c.id.length * 3) } };
    return out;
  };
  /** Like Companion: entities for connections the import does not know are dropped. */
  function fixEntities(list, map) {
    return (list || []).filter((e) => e.connectionId === 'internal' || (map[e.connectionId] && map[e.connectionId] !== '_ignore')).map((e) => Object.assign({}, e, { connectionId: e.connectionId === 'internal' ? 'internal' : map[e.connectionId] }));
  }
  function fixControl(ctl, map) {
    const c = clone(ctl);
    if (c.type !== 'button-layered') return c;
    c.feedbacks = fixEntities(c.feedbacks, map);
    for (const s of Object.values(c.steps || {})) for (const k of Object.keys(s.action_sets || {})) s.action_sets[k] = fixEntities(s.action_sets[k], map);
    return c;
  }
  const loc = (l) => { const p = m.pages[l.pageNumber - 1]; if (!p) throw new Error('Invalid page'); return p; };
  const onGrid = (l) => l.row >= m.gridSize.minRow && l.row <= m.gridSize.maxRow && l.column >= m.gridSize.minColumn && l.column <= m.gridSize.maxColumn;

  const Q = {
    'appInfo.version': () => ({ appVersion: m.version, appBuild: m.version + '+demo', logsDir: '/tmp', shellCommandSupportEnabled: false, customModuleImportAllowed: false, runningUnderLauncher: true }),
    'userConfig.getConfig': () => ({ gridSize: clone(m.gridSize), http_api_enabled: true }),
    'variables.values.connection': (i) => {
      if (i.label === 'custom') return clone(m.customValues);
      if (i.label === 'atem') return { pgm1_input: '1', pvw1_input: '2', model: 'ATEM Mini Extreme ISO' };
      if (i.label === 'obs') return { streaming: 'false', scene_active: 'Service' };
      if (i.label === 'internal') return { time_hms: new Date().toTimeString().slice(0, 8), instance_errors: 1 };
      return undefined;
    },
    'instances.definitions.events': () => clone(EVENTS)
  };
  const S = {
    'instances.connections.watch': () => [{ type: 'init', info: Object.fromEntries(Object.values(m.connections).map((c, i) => [c.id, { id: c.id, label: c.label, moduleType: 'connection', moduleId: c.moduleId, moduleVersionId: c.moduleVersionId, enabled: c.enabled, sortOrder: i, collectionId: null }])) }],
    'instances.statuses.watch': () => ({ type: 'init', statuses: Object.fromEntries(Object.keys(m.connections).map((k) => [k, m.connections[k].enabled ? m.statuses[k] : { category: null, level: 'Disabled', message: null }])) }),
    'instances.definitions.actions': () => ({ type: 'init', definitions: clone(DEFS.action) }),
    'instances.definitions.feedbacks': () => ({ type: 'init', definitions: clone(DEFS.feedback) }),
    'surfaces.watchSurfaces': () => [{ type: 'init', info: { g1: { id: 'g1', displayName: 'Booth', surfaces: [{ id: 'sd1', type: 'Stream Deck XL', name: 'Booth XL', displayName: 'Booth XL', isConnected: true }, { id: 'sat1', type: 'Satellite', name: 'Stage Pi', displayName: 'Stage Pi (Satellite)', isConnected: false }] } } }],
    'logs.watch': () => ({ type: 'lines', lines: clone(m.logs) }),
    'variables.definitions.watch': () => ({ type: 'init', variables: { atem: { pgm1_input: { name: 'Program input on M/E 1' }, pvw1_input: { name: 'Preview input on M/E 1' }, model: { name: 'Model' } }, obs: { streaming: { name: 'Streaming' }, scene_active: { name: 'Program scene' } } } }),
    'customVariables.watch': () => [{ type: 'init', info: clone(m.customVars) }],
    'pages.watch': () => ({ type: 'init', order: m.pages.map((p) => p.id), pages: Object.fromEntries(m.pages.map((p) => [p.id, { id: p.id, name: p.name, controls: {} }])) })
  };
  const M = {
    'importExport.prepareImport.start': (i) => { if (m.upload) throw new Error('Another upload is in progress'); m.upload = { sessionId: id(), size: i.size, parts: [] }; return m.upload.sessionId; },
    'importExport.prepareImport.uploadChunk': (i) => { if (!m.upload || m.upload.sessionId !== i.sessionId) throw new Error('Unknown session'); m.upload.parts.push(Buffer.from(i.data, 'base64')); return 0.5; },
    'importExport.prepareImport.complete': (i) => {
      const up = m.upload; m.upload = null;
      if (!up || up.sessionId !== i.sessionId) throw new Error('Unknown session');
      const buf = Buffer.concat(up.parts);
      if (buf.length !== up.size) return ['Size mismatch', null];
      if (crypto.createHash('sha1').update(buf).digest('hex') !== i.expectedChecksum) return ['Checksum mismatch', null];
      let obj; try { obj = JSON.parse(buf.toString('utf8')); } catch (e) { return ['Not JSON', null]; }
      m.pending = obj.type === 'trigger_list' ? Object.assign({}, obj, { type: 'full' }) : obj;
      return [null, { type: m.pending.type }];
    },
    'importExport.importSinglePage': (i) => {
      const data = m.pending; if (!data) throw new Error('No in-progress import object');
      if (data.type !== 'page') throw new Error('Cannot import page ');
      const p = m.pages[i.targetPage - 1]; if (!p) throw new Error('Invalid target page');
      for (const k of Object.keys(data.instances || {})) if (!(k in i.connectionIdRemapping)) m.connections['new_' + k] = Object.assign({ id: 'new_' + k, enabled: false }, data.instances[k]);
      const map = i.connectionIdRemapping, controls = {};
      for (const [r, cols] of Object.entries(data.page.controls || {})) for (const [c, ctl] of Object.entries(cols || {})) if (ctl) (controls[r] = controls[r] || {})[c] = fixControl(ctl, map);
      p.controls = controls; p.name = data.page.name || p.name; m.imports++;
      return Object.assign({}, map);
    },
    'importExport.importTriggers': (i) => {
      const data = m.pending; if (!data || !data.triggers) throw new Error('No triggers in import');
      for (const tid of i.selectedTriggerIds) {
        const t = clone(data.triggers[tid]); if (!t) continue;
        t.actions = fixEntities(t.actions, i.connectionIdRemapping); t.condition = fixEntities(t.condition, i.connectionIdRemapping);
        m.triggers[m.triggers[tid] ? id() : tid] = t;
      }
      m.imports++;
      return {};
    },
    'controls.triggers.delete': (i) => { const k = i.controlId.replace(/^trigger:/, ''); const had = !!m.triggers[k]; delete m.triggers[k]; return had; },
    'controls.triggers.testActions': (i) => { const k = i.controlId.replace(/^trigger:/, ''); if (!m.triggers[k]) throw new Error('Trigger not found'); m.presses.push({ trigger: k }); return true; },
    'controls.setOptionsField': (i) => { const k = i.controlId.replace(/^trigger:/, ''); const t = m.triggers[k]; if (!t) throw new Error('Control not found'); t.options[i.key] = i.value; return true; },
    'controls.hotPressControl': (i) => { loc(i.location); m.presses.push({ location: i.location, down: i.direction }); return true; },
    'controls.hotRotateControl': (i) => { loc(i.location); m.presses.push({ location: i.location, rotate: i.direction ? 'right' : 'left' }); return true; },
    'controls.resetControls': (i) => {
      for (const l of i.locations) {
        const p = loc(l);
        if (p.controls[l.row]) { delete p.controls[l.row][l.column]; if (!Object.keys(p.controls[l.row]).length) delete p.controls[l.row]; }
        if (i.newType && onGrid(l)) (p.controls[l.row] = p.controls[l.row] || {})[l.column] = i.newType === 'button-layered' ? button('', 0) : { type: i.newType };
      }
    },
    'customVariables.create': (i) => { if (!/^\w+$/.test(i.name)) return 'Invalid name'; if (m.customVars[i.name]) return 'Name already exists'; m.customVars[i.name] = { defaultValue: i.defaultVal, description: '', persistCurrentValue: false, sortOrder: Object.keys(m.customVars).length }; m.customValues[i.name] = i.defaultVal; return null; },
    'customVariables.setDefault': (i) => { if (!m.customVars[i.name]) return 'Unknown name'; m.customVars[i.name].defaultValue = i.value; return null; },
    'customVariables.setDescription': (i) => { if (!m.customVars[i.name]) return 'Unknown name'; m.customVars[i.name].description = i.description; return null; },
    'customVariables.setPersistence': (i) => { if (!m.customVars[i.name]) return 'Unknown name'; m.customVars[i.name].persistCurrentValue = i.value; return null; },
    'customVariables.setCurrent': (i) => { if (!m.customVars[i.name]) return 'Unknown name'; m.customValues[i.name] = i.value; return null; },
    'customVariables.delete': (i) => { delete m.customVars[i.name]; delete m.customValues[i.name]; return null; },
    'pages.insert': (i) => { if (i.asPageNumber < 1 || i.asPageNumber > m.pages.length + 1) throw new Error('Invalid page'); m.pages.splice(i.asPageNumber - 1, 0, ...i.pageNames.map((n) => ({ id: 'pg_' + id(), name: n, controls: nav() }))); return 'ok'; },
    'pages.setName': (i) => { loc({ pageNumber: i.pageNumber }).name = i.name; },
    'pages.remove': (i) => { if (m.pages.length <= 1) return 'fail'; loc({ pageNumber: i.pageNumber }); m.pages.splice(i.pageNumber - 1, 1); return 'ok'; },
    'instances.connections.setEnabled': (i) => { const c = m.connections[i.connectionId]; if (!c) throw new Error('Unknown connection'); c.enabled = i.enabled; }
  };

  function http(method, path) {
    const u = new URL(path, 'http://x');
    if (method === 'GET' && u.pathname === '/int/export/custom') {
      if (u.searchParams.get('format') !== 'json') return { gz: true };
      const used = new Set(Object.keys(m.connections));
      return { version: 12, type: 'full', companionBuild: m.version, pages: Object.fromEntries(m.pages.map((p, i) => [i + 1, pageFile(i + 1)])), triggers: clone(m.triggers), custom_variables: clone(m.customVars), expressionVariables: {}, instances: instances(used) };
    }
    const pm = /^\/int\/export\/page\/(\d+)$/.exec(u.pathname);
    if (method === 'GET' && pm) {
      const n = +pm[1]; if (!m.pages[n - 1]) { const e = new Error('Companion answered 404'); e.status = 404; throw e; }
      const used = new Set();
      for (const cols of Object.values(m.pages[n - 1].controls)) for (const ctl of Object.values(cols)) JSON.stringify(ctl).replace(/"connectionId":"([^"]+)"/g, (x, c) => used.add(c));
      return { version: 12, type: 'page', companionBuild: m.version, page: pageFile(n), instances: instances(used), connectionCollections: [], oldPageNumber: n };
    }
    const e = new Error('Companion answered 404 to ' + method + ' ' + path); e.status = 404; throw e;
  }

  /** One tRPC call. */
  function handle(method, path, input) {
    const table = method === 'subscription' ? S : method === 'mutation' ? M : Q;
    const fn = table[path];
    if (!fn) { const e = new Error('No "' + method + '"-procedure on path "' + path + '"'); e.trpcCode = 'NOT_FOUND'; throw e; }
    return clone(fn(input || {}));
  }

  return { handle, http, state: () => m, reset: () => { m = model(); } };
}

/** The same interface as lib/companion.js, answered in memory. */
function client(core) {
  const c = core || create();
  const wrap = (method) => async (path, input) => {
    await null;
    try { return c.handle(method, path, input); }
    catch (e) { const err = new Error('Companion refused ' + path + ': ' + e.message); err.code = 'refused'; throw err; }
  };
  return {
    configured: () => true, base: () => 'http://demo-companion:8000', reset() {}, close() {},
    query: wrap('query'), mutate: wrap('mutation'), snapshot: wrap('subscription'),
    async http(method, path) { await null; return c.http(method, path); },
    core: c
  };
}

module.exports = { create, client };
