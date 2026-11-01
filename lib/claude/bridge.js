/*
 * Claude in LiveCompanion: an MCP endpoint for Claude that works on the central Companion
 * (buttons, pages, triggers, variables, connections), built the same way as HomeClaude:
 *
 *  - one scale of permission levels: Look only < Help build < Hands on < Full
 *  - keep or revert: every change Claude makes goes live at once, is backed up, and waits
 *    on the dashboard until you keep it or revert it
 *  - protected pages: Claude can read them, but never change or press anything on them
 *  - local mode (Claude Code on your network, access token) and exposed mode (claude.ai and
 *    the phone app through a reverse proxy, OAuth sign-in approved at home or with an
 *    authenticator code, a time limit per connection)
 *
 * server.js owns the settings file, the state file and the web page; this module owns
 * cfg.claude and state.claude and everything Claude-related.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Mcp = require('./mcp.js');
const Net = require('./netsec.js');
const OAuth = require('./oauth.js');
const Totp = require('./totp.js');
const QR = require('./qr.js');
const Backups = require('./backups.js');
const Tools = require('./tools.js');
const Companion = require('../companion.js');

const LEVELS = ['read', 'build', 'hands', 'full'];
const LEVEL_FLAGS = { read: {}, build: { edit: true }, hands: { edit: true, press: true }, full: { edit: true, press: true, delete: true } };
const LVL_TEXT = { read: 'Look only', build: 'Help build', hands: 'Hands on', full: 'Full' };
const lowerLevel = (a, b) => LEVELS[Math.min(LEVELS.indexOf(a), LEVELS.indexOf(b))];
const REVIEW_TIMES = [0, 15, 60, 240, 1440];
const SETUP_MARKS = ['welcome', 'companion', 'perms', 'pin', 'claude'];
const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

const DEFAULTS = {
  companion: { url: '', deviceId: '' },
  access: { enabled: true, local: 'read', outsideMax: 'hands', protectedPages: [] },
  mcpToken: '',
  publicUrl: '',
  backup: { keep: 30 },
  review: { enabled: true, timeoutMin: 0, ifNoAnswer: 'revert' },
  security: { mode: 'local', allowTokenRemote: false, tokenScope: 'read', accessDefault: 'none', totp: { enabled: false, secret: '', pending: '', since: 0, lastCounter: 0, maxScope: 'build', off: false } },
  setup: { completed: false, marks: {} }
};

/** Fill in missing settings (new installs, and installs from before Claude was added). */
function normalize(c) {
  const out = Object.assign(clone(DEFAULTS), c || {});
  ['companion', 'access', 'backup', 'review', 'security', 'setup'].forEach((k) => { out[k] = Object.assign(clone(DEFAULTS[k]), (c && c[k]) || {}); });
  out.security.totp = Object.assign(clone(DEFAULTS.security.totp), out.security.totp || {});
  if (!LEVELS.includes(out.access.local)) out.access.local = 'read';
  if (!['read', 'build', 'hands'].includes(out.access.outsideMax)) out.access.outsideMax = 'hands';
  out.access.protectedPages = cleanPages(out.access.protectedPages);
  if (!out.setup.marks || typeof out.setup.marks !== 'object') out.setup.marks = {};
  return out;
}
function cleanPages(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  return Array.from(new Set(list.map((x) => Math.round(Number(x))).filter((n) => Number.isInteger(n) && n >= 1 && n <= 999))).sort((a, b) => a - b).slice(0, 200);
}

/**
 * h.getCfg() / h.changeConfig(fn) : the whole settings object; this module only touches cfg.claude
 * h.state, h.saveState(), h.broadcast() : state.claude lives here
 * h.secrets, h.dataDir, h.demo, h.version, h.pinSet(), h.verifiedClear()
 * h.publicPort, h.adminPort, h.insecurePublic (tests), h.demoCompanion (demo client)
 * h.devices() -> LiveCompanion's devices, to offer the ones that run Companion
 */
function create(h) {
  const cfg = () => h.getCfg().claude;
  const change = (fn) => h.changeConfig((c) => { c.claude = normalize(c.claude); return fn(c.claude, c); });
  const st = () => h.state.claude;
  if (!h.state.claude || typeof h.state.claude !== 'object') h.state.claude = {};
  ['activity', 'security', 'reviews', 'totpFails'].forEach((k) => { if (!Array.isArray(st()[k])) st()[k] = []; });
  const save = () => h.saveState();
  const changed = () => { save(); h.broadcast(); };

  // ---------- levels ----------
  /** What a level allows. From outside: never above the outside ceiling, never above Hands on. */
  function accessFor(level, remote) {
    let l = LEVELS.includes(level) ? level : 'read';
    if (remote) l = lowerLevel(lowerLevel(l, cfg().access.outsideMax), 'hands');
    const f = LEVEL_FLAGS[l];
    return { enabled: cfg().access.enabled, level: l, edit: !!f.edit, press: !!f.press, delete: !!f.delete, protectedPages: cfg().access.protectedPages.slice() };
  }
  const localAccess = () => accessFor(cfg().access.local, false);

  // ---------- secrets ----------
  const DEMO_TOKEN = 'demo';
  function mcpToken() {
    if (h.demo) return DEMO_TOKEN;
    let t = h.secrets.dec(cfg().mcpToken);
    if (!t) {
      t = crypto.randomBytes(24).toString('base64url');
      const r = change((c) => { c.mcpToken = h.secrets.enc(t); });
      if (!r.ok) console.error(r.error);
    }
    return t;
  }
  function tokenOk(given) {
    const want = Buffer.from(mcpToken()), got = Buffer.from(String(given || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  // ---------- Companion ----------
  const companion = h.demoCompanion || Companion.create({ getUrl: () => cfg().companion.url });
  // demo mode keeps its backups in a temporary folder, so the Backups page and Revert work without touching the data folder
  const backups = Backups.create({ dir: h.demo ? path.join(require('os').tmpdir(), 'livecompanion-demo-backups-' + process.pid) : path.join(h.dataDir, 'claude-backups'), keep: () => cfg().backup.keep });
  const tools = Tools.create({ companion, backups, access: localAccess, onChange: (info, who) => recordChange(info, who), reviewInfo: () => reviewInfo() });

  let compStatus = { ok: false, configured: false, checking: false, checkedAt: 0, error: '', version: '', ms: 0 };
  async function checkCompanion() {
    if (!companion.configured()) { compStatus = { ok: false, configured: false, checkedAt: Date.now(), error: '', version: '' }; h.broadcast(); return compStatus; }
    compStatus = Object.assign({}, compStatus, { checking: true }); h.broadcast();
    const t0 = Date.now();
    try {
      const info = await tools.probe();
      compStatus = Object.assign({ ok: true, configured: true, checking: false, checkedAt: Date.now(), error: '', ms: Date.now() - t0 }, info);
    } catch (e) {
      compStatus = { ok: false, configured: true, checking: false, checkedAt: Date.now(), error: e.message, version: compStatus.version, ms: 0 };
    }
    h.broadcast();
    return compStatus;
  }

  // ---------- activity and security events ----------
  function logActivity(entry) {
    st().activity.unshift(entry);
    if (st().activity.length > 300) st().activity.length = 300;
    st().lastCallAt = entry.t;
    changed();
  }
  function securityEvent(type, detail) {
    st().security.unshift(Object.assign({ t: Date.now(), type }, detail || {}));
    if (st().security.length > 300) st().security.length = 300;
    changed();
  }
  function argSummary(a) {
    try { const s = JSON.stringify(a || {}); return s === '{}' ? '' : s.length > 220 ? s.slice(0, 217) + '...' : s; } catch (e) { return ''; }
  }

  // ---------- keep or revert ----------
  function recordChange(info, who) {
    if (!cfg().review.enabled) return null;
    const now = Date.now();
    // a second change to the same thing before you answered: Revert still goes back to the very first version
    let r = st().reviews.find((x) => x.status === 'waiting' && x.kind === info.kind && x.id === String(info.id));
    if (!r) {
      r = { rid: crypto.randomBytes(6).toString('hex'), kind: info.kind, id: String(info.id), before: clone(info.before), beforeView: viewOf(info.kind, info.before), backup: info.backup || null, at: now, status: 'waiting', changes: 0 };
      st().reviews.unshift(r);
    }
    r.alias = String(info.alias || r.alias || r.id).slice(0, 160);
    r.after = clone(info.after); r.afterView = viewOf(info.kind, info.after); r.who = who && who.remote ? who.label : 'Claude'; r.where = who && who.remote ? 'outside' : 'home'; r.updatedAt = now; r.changes++;
    r.action = r.before ? (r.after ? 'changed' : 'deleted') : (r.after ? 'created' : null);
    if (!r.action) { r.status = 'withdrawn'; r.decidedAt = now; } // made and deleted again: nothing left to review
    r.autoAt = cfg().review.timeoutMin ? now + cfg().review.timeoutMin * 60e3 : null;
    trimReviews(); changed();
    if (!r.action) return null;
    return 'Applied now. The person is asked in LiveCompanion to keep or revert this change' +
      (r.autoAt ? '; if they do not answer within ' + cfg().review.timeoutMin + ' minutes it is ' + (cfg().review.ifNoAnswer === 'revert' ? 'reverted' : 'kept') + ' automatically' : '') + '.';
  }
  function viewOf(kind, x) { try { return clone(tools.view(kind, x)); } catch (e) { return clone(x); } }
  function trimReviews() {
    const waiting = st().reviews.filter((x) => x.status === 'waiting');
    const done = st().reviews.filter((x) => x.status !== 'waiting').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 60);
    st().reviews = waiting.concat(done);
  }
  function reviewInfo() {
    const day = Date.now() - 86400e3;
    return {
      waiting: st().reviews.filter((x) => x.status === 'waiting').map((x) => ({ kind: x.kind, id: x.id, name: x.alias, action: x.action, since: new Date(x.at).toISOString() })),
      recently_reverted: st().reviews.filter((x) => x.status === 'reverted' && x.decidedAt > day).map((x) => ({ kind: x.kind, id: x.id, name: x.alias, action: x.action, reverted: new Date(x.decidedAt).toISOString() }))
    };
  }
  async function decideReview(rid, keep, by) {
    const r = st().reviews.find((x) => x.rid === rid);
    if (!r || r.status !== 'waiting') return { ok: false, error: 'That change was already answered' };
    if (!keep) {
      try { await tools.revert(r); }
      catch (e) { return { ok: false, error: 'Could not revert: ' + e.message }; }
    }
    r.status = keep ? 'kept' : 'reverted'; r.decidedAt = Date.now(); r.by = by;
    logActivity({ t: r.decidedAt, tool: (keep ? 'kept' : 'reverted') + ' (' + by + ')', args: r.kind + ' ' + r.alias + ' (' + r.action + ')', ok: true, ms: 0, write: !keep });
    trimReviews(); changed();
    return { ok: true };
  }
  let reviewTimerBusy = false;
  async function reviewTimer() {
    if (reviewTimerBusy) return;
    reviewTimerBusy = true;
    try {
      for (const r of st().reviews.filter((x) => x.status === 'waiting' && x.autoAt && x.autoAt <= Date.now())) {
        const res = await decideReview(r.rid, cfg().review.ifNoAnswer !== 'revert', 'no answer in time');
        if (!res.ok) { r.autoAt = Date.now() + 5 * 60e3; save(); } // Companion away: try again later
      }
    } finally { reviewTimerBusy = false; }
  }
  function setReview(b) {
    return change((c) => {
      if (typeof b.enabled === 'boolean') c.review.enabled = b.enabled;
      if (b.timeoutMin != null) { const m = Number(b.timeoutMin); if (!REVIEW_TIMES.includes(m)) return 'Unknown time'; c.review.timeoutMin = m; }
      if (b.ifNoAnswer != null) { if (!['keep', 'revert'].includes(b.ifNoAnswer)) return 'Choose keep or revert'; c.review.ifNoAnswer = b.ifNoAnswer; }
    });
  }

  // ---------- the MCP endpoint ----------
  const capAccess = (scope) => accessFor(scope, true);
  const callLimit = Net.limiter({ max: 120, windowMs: 60e3, lockMs: 60e3 });
  const listed = new Map(); // who.key -> { names: Set, told: string }
  function noteListed(who, names) { if (who && who.key) listed.set(who.key, { names: new Set(names), told: '' }); }
  /** Claude's apps keep the tool list they loaded. After a permission change, say so once. */
  function toolsNotice(who) {
    const seen = who && who.key && listed.get(who.key);
    if (!seen) return '';
    const now = tools.list(who.access).map((t) => t.name);
    const added = now.filter((n) => !seen.names.has(n)), removed = [...seen.names].filter((n) => !now.includes(n));
    if (!added.length && !removed.length) return '';
    const sig = added.join(',') + '|' + removed.join(',');
    if (seen.told === sig) return '';
    seen.told = sig;
    const level = (who.access && who.access.level) || cfg().access.local;
    return '[LiveCompanion: this connection\'s permissions changed since your tool list was loaded. It is now ' + (LVL_TEXT[level] || level) + '.' +
      (added.length ? ' Now allowed, but not in your current tool list: ' + added.join(', ') + '.' : '') +
      (removed.length ? ' No longer allowed: ' + removed.join(', ') + '.' : '') +
      (added.length ? ' To use the new tools, the person needs to reload the LiveCompanion connector (reconnect it, or start a new chat). Tell them so if they ask for something these tools do.' : '') + ']\n\n';
  }
  const mcp = Mcp.create({
    serverInfo: { name: 'livecompanion', title: 'LiveCompanion (Bitfocus Companion)', version: h.version },
    instructions: Tools.INSTRUCTIONS,
    listTools: (who) => tools.list(who && who.access),
    onListed: noteListed,
    async callTool(name, a, who) {
      const t0 = Date.now(), def = tools.all().find((x) => x.name === name);
      if (who && who.remote && callLimit.locked(who.key)) return { isError: true, text: 'Too many requests from this connection. Wait a minute.' };
      if (who && who.remote) callLimit.hit(who.key);
      const r = await tools.call(name, a, who && who.access, who);
      const notice = toolsNotice(who);
      if (notice) r.text = notice + r.text;
      if (def && def.needs) backupsChanged();
      logActivity({ t: t0, tool: name, args: argSummary(a), ok: !r.isError, ms: Date.now() - t0, write: !!(def && def.needs), error: r.isError ? r.text.slice(0, 300) : undefined, who: who ? who.label : undefined, remote: !!(who && who.remote), ip: who ? who.ip : undefined });
      return r;
    }
  });

  const bearerOf = (req) => (/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')) || [])[1];
  function sendJson(res, code, obj, extra) {
    res.writeHead(code, Net.securityHeaders(Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {})));
    res.end(obj == null ? '' : JSON.stringify(obj));
  }
  /** /mcp on the private port: the access token, from the header or the address. */
  function serveMcpLocal(req, res, pathToken) {
    if (!tokenOk(pathToken || bearerOf(req))) return setTimeout(() => sendJson(res, 401, { error: 'Missing or wrong LiveCompanion access token' }, { 'www-authenticate': 'Bearer realm="LiveCompanion"' }), 400);
    runMcp(req, res, { label: 'This network', access: null, remote: false, ip: Net.clientIp(req, false), key: 'lan' });
  }
  function runMcp(req, res, who) {
    // a web page in a browser must not be able to use this (DNS rebinding); Claude's apps send no Origin
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return sendJson(res, 403, { error: 'Requests from web pages are not allowed' }); } catch (e) { return sendJson(res, 403, { error: 'Bad Origin' }); } }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    if (!cfg().access.enabled) return sendJson(res, 503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Claude access is switched off in LiveCompanion' } });
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (d) => { size += d.length; if (size > 2 * 1024 * 1024) tooBig = true; else chunks.push(d); });
    req.on('end', async () => {
      if (tooBig) return sendJson(res, 413, { error: 'Request too large' });
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return sendJson(res, 400, Mcp.parseError()); }
      try {
        const out = await mcp.handle(body, req.headers, who);
        if (out == null) { res.writeHead(202); return res.end(); }
        sendJson(res, 200, out);
      } catch (e) {
        sendJson(res, 500, { jsonrpc: '2.0', id: body && body.id !== undefined ? body.id : null, error: { code: -32603, message: 'Internal error: ' + e.message } });
      }
    });
  }

  // ---------- settings from the page ----------
  function setCompanion(b) {
    if (h.demo) return { ok: false, error: 'Demo mode: Companion is simulated' };
    let url = clean(b.url, 300).replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
    if (url && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(url)) return { ok: false, error: 'The address should look like http://192.168.1.20:8000' };
    const r = change((c) => { c.companion.url = url; c.companion.deviceId = clean(b.deviceId, 20); });
    if (r.ok) { companion.reset(); checkCompanion(); }
    return r;
  }
  function setAccess(b) {
    return change((c) => {
      if (typeof b.enabled === 'boolean') c.access.enabled = b.enabled;
      if (b.local != null) { if (!LEVELS.includes(b.local)) return 'Unknown level'; c.access.local = b.local; }
      if (b.outsideMax != null) { if (!['read', 'build', 'hands'].includes(b.outsideMax)) return 'From outside the highest level is Hands on'; c.access.outsideMax = b.outsideMax; }
      if (b.protectedPages != null) c.access.protectedPages = cleanPages(b.protectedPages);
    });
  }
  function changeSettings(b) {
    return change((c) => {
      if (b.publicUrl != null) {
        const u = clean(b.publicUrl, 300).replace(/\/+$/, '').replace(/\/mcp$/, '');
        if (u && !(h.insecurePublic ? /^https?:\/\/[^\s/]+(:\d+)?$/i : /^https:\/\/[^\s/]+(:\d+)?$/i).test(u)) return 'The public address must be https://, just the host name (for example https://companion.example.com)';
        if (u !== c.publicUrl && c.security.mode === 'exposed' && !u) return 'Switch to local mode before removing the public address';
        c.publicUrl = u;
      }
      if (b.backupKeep != null) c.backup.keep = Math.min(200, Math.max(1, parseInt(b.backupKeep, 10) || 30));
    });
  }
  function newToken() {
    if (h.demo) return { ok: false, error: 'Demo mode uses the token "demo"' };
    const t = crypto.randomBytes(24).toString('base64url');
    const r = change((c) => { c.mcpToken = h.secrets.enc(t); });
    if (r.ok) securityEvent('token-replaced', {});
    return r.ok ? { ok: true, token: t } : r;
  }
  async function restore(b) {
    const kind = String(b.kind || ''), id = String(b.id || ''), file = String(b.file || '');
    const bk = backups.read(kind, id, file);
    if (!bk || !bk.config) return { ok: false, error: 'That backup is gone' };
    try {
      await tools.restore(kind, id, bk.config);
      backupsChanged();
      logActivity({ t: Date.now(), tool: 'restore (LiveCompanion page)', args: kind + ' ' + (bk.config.name || id) + ' from ' + file, ok: true, ms: 0, write: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- exposed mode ----------
  const exposed = () => cfg().security.mode === 'exposed';
  function totpAvailable() {
    const t = cfg().security.totp;
    return { ok: !!(t.enabled && t.secret && !t.off && exposed()), maxScope: t.maxScope, span: cfg().security.accessDefault };
  }
  function totpCheck(code, ip) {
    const t = cfg().security.totp, now = Date.now();
    if (t.off) return 'off';
    st().totpFails = st().totpFails.filter((x) => x > now - 86400e3);
    if (st().totpFails.filter((x) => x > now - 3600e3).length >= 5) return 'paused';
    const step = Totp.verify(h.secrets.dec(t.secret), code, t.lastCounter, now);
    if (step != null) { change((c) => { c.security.totp.lastCounter = step; }); return 'ok'; }
    st().totpFails.push(now); save();
    securityEvent('code-wrong', { ip });
    if (st().totpFails.length >= 20) {
      change((c) => { c.security.totp.off = true; });
      securityEvent('codes-switched-off', { why: '20 wrong codes in 24 hours' });
    } else if (st().totpFails.filter((x) => x > now - 3600e3).length >= 5) securityEvent('codes-paused', { why: '5 wrong codes in an hour' });
    return 'wrong';
  }
  function totpAction(b) {
    const t = cfg().security.totp;
    if (b.action === 'setup') {
      const secret = Totp.newSecret();
      const r = change((c) => { c.security.totp.pending = h.secrets.enc(secret); });
      if (!r.ok) return r;
      let account = 'LiveCompanion';
      try { if (cfg().publicUrl) account = new URL(cfg().publicUrl).host; } catch (e) { /* keep */ }
      const uri = Totp.uri(secret, account, 'LiveCompanion');
      return { ok: true, secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, svg: QR.svg(uri, 5) };
    }
    if (b.action === 'confirm') {
      const secret = h.secrets.dec(t.pending);
      if (!secret) return { ok: false, error: 'Start the setup again' };
      const step = Totp.verify(secret, b.code, null, Date.now());
      if (step == null) return { ok: false, error: 'That code does not match. Check the app shows LiveCompanion, and that the phone\'s clock is right.' };
      const r = change((c) => { Object.assign(c.security.totp, { enabled: true, secret: c.security.totp.pending, pending: '', since: Date.now(), lastCounter: step, off: false }); });
      if (r.ok) { st().totpFails = []; save(); securityEvent('codes-enabled', {}); }
      return r;
    }
    if (b.action === 'disable') {
      const r = change((c) => { Object.assign(c.security.totp, { enabled: false, secret: '', pending: '', since: 0, lastCounter: 0, off: false }); });
      if (r.ok) securityEvent('codes-disabled', {});
      return r;
    }
    if (b.action === 'resume') {
      const r = change((c) => { c.security.totp.off = false; });
      if (r.ok) { st().totpFails = []; save(); securityEvent('codes-resumed', {}); }
      return r;
    }
    if (b.maxScope != null) {
      if (!OAuth.SCOPES.includes(b.maxScope)) return { ok: false, error: 'Unknown permission level' };
      return change((c) => { c.security.totp.maxScope = b.maxScope; });
    }
    return { ok: false, error: 'Unknown action' };
  }

  const oauthPath = path.join(h.dataDir, 'oauth.json');
  let oauthSaveTimer = null;
  const oauth = OAuth.create({
    totp: { available: totpAvailable, check: totpCheck },
    load: () => { if (h.demo) return {}; try { return JSON.parse(fs.readFileSync(oauthPath, 'utf8')); } catch (e) { return {}; } },
    save: (db) => {
      if (h.demo) return;
      clearTimeout(oauthSaveTimer);
      oauthSaveTimer = setTimeout(() => { try { h.writeJson(oauthPath, db); } catch (e) { console.error('Could not save Claude connections: ' + e.message); } }, 100);
    },
    base: () => cfg().publicUrl,
    event: (type, d) => securityEvent(type, d)
  });

  function setSecurity(b) {
    let changedMode = null;
    const r = change((c, all) => {
      if (b.mode != null) {
        if (!['local', 'exposed'].includes(b.mode)) return 'Unknown mode';
        if (b.mode === 'exposed') {
          if (!all.controlPinHash) return 'Set a control PIN first (Settings > Settings > Control). In exposed mode this page must not be open to anyone on your network.';
          if (!c.publicUrl) return 'Enter the public https address first.';
        }
        if (c.security.mode !== b.mode) changedMode = b.mode;
        c.security.mode = b.mode;
      }
      if (typeof b.allowTokenRemote === 'boolean') c.security.allowTokenRemote = b.allowTokenRemote;
      if (b.accessDefault != null) { if (!(b.accessDefault in OAuth.SPANS)) return 'Unknown access time'; c.security.accessDefault = b.accessDefault; }
      if (b.tokenScope != null) { if (!OAuth.SCOPES.includes(b.tokenScope)) return 'Unknown permission level'; c.security.tokenScope = b.tokenScope; }
    });
    if (r.ok && changedMode) securityEvent('mode-changed', { mode: changedMode });
    if (r.ok && b.allowTokenRemote != null) securityEvent('token-remote', { allowed: !!b.allowTokenRemote });
    return r;
  }

  /** From inside: can the public address reach the public port, and does it hide this page? */
  let selfTest = null, selfNonce = '';
  async function runSelfTest() {
    const base = cfg().publicUrl;
    if (!base) return { ok: false, error: 'Enter the public address first' };
    selfNonce = crypto.randomBytes(12).toString('hex');
    const checks = [];
    const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-store' } }); return { status: r.status, text: await r.text() }; };
    try {
      const hz = await get('/healthz?n=' + selfNonce);
      let j = null; try { j = JSON.parse(hz.text); } catch (e) { /* not ours */ }
      checks.push({ name: 'The public address reaches LiveCompanion\'s public port', ok: !!(j && j.match), detail: j && j.match ? 'Yes' : j && j.mode === 'local' ? 'It reaches LiveCompanion, but exposed mode is off' : j ? 'It reaches a different LiveCompanion' : 'Got ' + hz.status + ' from something else. Point the proxy at port ' + h.publicPort + ' of this container' });
      const root = await get('/');
      checks.push({ name: 'This dashboard is not reachable from outside', ok: root.status === 404 && !/<title>LiveCompanion<\/title>/.test(root.text), detail: root.status === 404 ? 'Hidden' : 'Got ' + root.status + '. The proxy may point at the dashboard port ' + h.adminPort + ' instead of ' + h.publicPort });
      const sp = await get('/api/state');
      checks.push({ name: 'Settings, devices and tokens are not reachable from outside', ok: sp.status === 404, detail: sp.status === 404 ? 'Hidden' : 'Got ' + sp.status });
      const prm = await get('/.well-known/oauth-protected-resource');
      let pj = null; try { pj = JSON.parse(prm.text); } catch (e) { /* no */ }
      checks.push({ name: 'Claude can find the sign-in', ok: !!(pj && pj.resource === base + '/mcp'), detail: pj ? (pj.resource === base + '/mcp' ? 'Yes' : 'It reports ' + pj.resource) : 'Got ' + prm.status });
      const noAuth = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
      checks.push({ name: 'Claude\'s endpoint refuses requests without sign-in', ok: noAuth.status === 401, detail: 'Got ' + noAuth.status });
      selfTest = { at: Date.now(), ok: checks.every((c) => c.ok), checks };
    } catch (e) {
      selfTest = { at: Date.now(), ok: false, checks, error: 'Could not reach ' + base + ' from inside LiveCompanion (' + ((e.cause && e.cause.code) || e.message) + '). Some networks cannot loop back to their own public address; try it from your phone on mobile data.' };
    }
    selfNonce = '';
    return { ok: true };
  }

  function setupAction(b) {
    return change((c) => {
      if (b.reset) { c.setup = { completed: false, marks: {} }; return; }
      if (b.mark != null) {
        if (!SETUP_MARKS.includes(b.mark)) return 'Unknown step';
        if (b.value === false || b.value == null) delete c.setup.marks[b.mark];
        else c.setup.marks[b.mark] = b.value === 'skip' ? 'skip' : true;
      }
      if (typeof b.completed === 'boolean') c.setup.completed = b.completed;
    });
  }

  // ---------- what the page sees ----------
  let bkCache = { n: 0, at: 0 };
  function backupCount() {
    if (Date.now() - bkCache.at > 5000) { try { bkCache = { n: backups.list().length, at: Date.now() }; } catch (e) { bkCache.at = Date.now(); } }
    return bkCache.n;
  }
  const backupsChanged = () => { bkCache.at = 0; };
  function companionDevices() {
    return (h.devices() || []).filter((d) => d.status && (d.status.installs || []).some((i) => /companion/i.test(i.kind || i.label || '') && !/satellite/i.test(i.kind || i.label || '')))
      .map((d) => ({ id: d.id, name: d.name, host: d.host }));
  }
  function snapshot() {
    const c = cfg(), a = localAccess(), now = Date.now();
    return {
      companion: { url: h.demo ? companion.base() : c.companion.url, deviceId: c.companion.deviceId, status: compStatus, candidates: companionDevices() },
      access: Object.assign({}, c.access, a),
      tools: tools.all().map((t) => ({ name: t.name, title: t.title, needs: t.needs || null, on: !t.needs || !!a[t.needs] })),
      publicUrl: c.publicUrl,
      backup: { keep: c.backup.keep },
      backupCount: backupCount(),
      activity: st().activity.slice(0, 60),
      activityTotal: st().activity.length,
      lastCallAt: st().lastCallAt || 0,
      review: c.review,
      reviews: st().reviews.slice(0, 40).map((r) => Object.assign({}, r, { before: undefined, after: undefined, backup: undefined, hasBefore: !!r.before, hasAfter: !!r.after })),
      setup: c.setup,
      everConnected: !!(st().lastCallAt || st().activity.length),
      security: {
        mode: c.security.mode, publicUrl: c.publicUrl, accessDefault: c.security.accessDefault, publicPort: h.publicPort, adminPort: h.adminPort,
        allowTokenRemote: c.security.allowTokenRemote, tokenScope: c.security.tokenScope,
        keyWhere: h.demo ? 'demo' : h.secrets.where(), keyFileOnVolume: !h.demo && h.secrets.hasFileKey(), keyMismatch: !!h.keyMismatch,
        pending: oauth.listPending(), connections: oauth.connections().map((x) => Object.assign(x, { effective: accessFor(x.scope, true).level })), events: st().security.slice(0, 80), selfTest,
        totp: { enabled: !!c.security.totp.enabled, since: c.security.totp.since, maxScope: c.security.totp.maxScope, off: !!c.security.totp.off, failsToday: st().totpFails.filter((x) => x > now - 86400e3).length, paused: st().totpFails.filter((x) => x > now - 3600e3).length >= 5 }
      }
    };
  }

  // ---------- routes on the dashboard port ----------
  /** In exposed mode the dashboard port refuses anything that came through a proxy or from outside. */
  function adminRefusal(req) {
    if (!exposed()) return null;
    if (Net.cameThroughProxy(req)) return 'This is LiveCompanion\'s dashboard port. Point your reverse proxy at port ' + h.publicPort + ' (the public port for Claude) instead.';
    if (!Net.isPrivate(req.socket.remoteAddress)) return 'While Claude is exposed, the dashboard only opens from your own network.';
    return null;
  }
  function refuse(req, res, url, why) {
    securityEvent('admin-refused', { ip: Net.clientIp(req, Net.cameThroughProxy(req)), path: url.slice(0, 60) });
    res.writeHead(403, Net.securityHeaders({ 'content-type': 'text/plain; charset=utf-8' })); res.end(why);
  }

  /** Returns true when the request was handled here. postJson is server.js's (it checks the PIN). */
  function route(req, res, u, postJson, json, pinOk) {
    const url = u.pathname;
    const m = /^\/mcp(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/.exec(url);
    if (m) { serveMcpLocal(req, res, m[1]); return true; }
    if (!url.startsWith('/api/claude/')) return false;
    const p = url.slice('/api/claude/'.length), post = req.method === 'POST';
    if (req.method === 'GET' && p === 'backups') { json(res, 200, { backups: backups.list() }); return true; }
    if (req.method === 'GET' && p === 'backup') {
      if (!pinOk(u.searchParams.get('pin') || req.headers['x-pin'], req)) { res.writeHead(401); res.end('Wrong or missing PIN'); return true; }
      const f = backups.filePath(u.searchParams.get('kind') || '', u.searchParams.get('id') || '', u.searchParams.get('file') || '');
      if (!f) { res.writeHead(404); res.end('Not found'); return true; }
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="' + ('companion-' + u.searchParams.get('kind') + '-' + u.searchParams.get('id') + '-' + path.basename(f)).replace(/[^A-Za-z0-9_.-]/g, '_') + '"' });
      fs.createReadStream(f).pipe(res);
      return true;
    }
    if (!post) return false;
    const routes = {
      companion: [setCompanion],
      'companion-test': [() => checkCompanion().then((s) => ({ ok: s.ok, error: s.ok ? undefined : (s.error || 'Companion is not set up yet') })), { needPin: false }],
      access: [setAccess],
      token: [(b) => (b.regenerate ? newToken() : { ok: true, token: mcpToken() })],
      settings: [changeSettings],
      restore: [restore],
      setup: [setupAction],
      security: [setSecurity],
      'security/selftest': [runSelfTest],
      'connections/decide': [(b) => oauth.decide(b.id, !!b.approve, b.scope, Net.clientIp(req, false), b.span == null ? cfg().security.accessDefault : b.span)],
      'connections/span': [(b) => (oauth.setSpan(String(b.id || ''), b.span) ? { ok: true } : { ok: false, error: 'Could not change it' })],
      'connections/revoke': [(b) => {
        if (b.all) return { ok: true, revoked: oauth.revokeAll('all connections revoked on the LiveCompanion page') };
        return oauth.revokeGrant(String(b.id || ''), 'revoked on the LiveCompanion page') ? { ok: true } : { ok: false, error: 'That connection is gone' };
      }],
      'connections/scope': [(b) => (oauth.setScope(String(b.id || ''), b.scope) ? { ok: true } : { ok: false, error: 'Could not change it' })],
      review: [(b) => (b.rid ? decideReview(String(b.rid), !!b.keep, 'you') : setReview(b)), { limit: 4096 }],
      totp: [totpAction],
      'security/clear': [() => { st().security = []; save(); return { ok: true }; }],
      'activity-clear': [() => { st().activity = []; save(); return { ok: true }; }]
    };
    const r = routes[p];
    if (!r) return false;
    postJson(req, res, r[0], r[1] || {});
    return true;
  }

  // ---------- the public port: only Claude's endpoint and the sign-in ----------
  const failLimit = Net.limiter({ max: 10, windowMs: 10 * 60e3, lockMs: 30 * 60e3 });
  const failGlobal = Net.limiter({ max: 300, windowMs: 10 * 60e3, lockMs: 10 * 60e3 });
  const regLimit = Net.limiter({ max: 5, windowMs: 60 * 60e3, lockMs: 60 * 60e3 });
  const authzLimit = Net.limiter({ max: 6, windowMs: 10 * 60e3, lockMs: 20 * 60e3 });
  function publicFail(ip, why) {
    if (failLimit.hit(ip)) securityEvent('address-locked', { ip, why });
    if (failGlobal.hit('all')) securityEvent('public-paused', { why: 'too many failed attempts from many addresses' });
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let raw = '', big = false;
      req.on('data', (d) => { if (big) return; raw += d; if (raw.length > limit) { big = true; raw = ''; } });
      req.on('end', () => (big ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(raw)));
      req.on('error', reject);
    });
  }
  function parseForm(req, raw) {
    if (/application\/json/i.test(req.headers['content-type'] || '')) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
    return Object.fromEntries(new URLSearchParams(raw));
  }
  function basicAuth(req) {
    const mm = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!mm) return null;
    const t = Buffer.from(mm[1], 'base64').toString('utf8'), i = t.indexOf(':');
    return i < 0 ? null : { id: decodeURIComponent(t.slice(0, i)), secret: decodeURIComponent(t.slice(i + 1)) };
  }

  const publicServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const url = u.pathname, ip = Net.clientIp(req, true);
    const base = () => Net.securityHeaders({ 'cache-control': 'no-store', 'strict-transport-security': 'max-age=31536000' });
    const send = (code, obj, extra) => { res.writeHead(code, Object.assign(base(), { 'content-type': 'application/json' }, extra || {})); res.end(obj == null ? '' : JSON.stringify(obj)); };
    const html = (code, page) => {
      const hs = Net.inlineHashes(page);
      res.writeHead(code, Object.assign(base(), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src " + hs.scripts.join(' ') + '; style-src ' + hs.styles.join(' ') + "; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }));
      res.end(page);
    };
    try {
      if (url === '/healthz' && req.method === 'GET') return send(200, { ok: true, mode: cfg().security.mode, match: !!selfNonce && u.searchParams.get('n') === selfNonce });
      if (!exposed()) return send(404, { error: 'LiveCompanion is in local mode for Claude. Nothing is served on the public port.' });
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (proto !== 'https' && !h.insecurePublic) return send(403, { error: 'LiveCompanion only answers over https. The reverse proxy must send X-Forwarded-Proto: https.' });
      const want = (() => { try { return new URL(cfg().publicUrl).host.toLowerCase(); } catch (e) { return ''; } })();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
      if (want && host !== want && !h.insecurePublic) return send(421, { error: 'This address is not the one LiveCompanion is set up for (' + want + ').' });
      const left = Math.max(failLimit.locked(ip), failGlobal.locked('all'));
      if (left) return send(429, { error: 'Too many failed attempts. Try again later.' }, { 'retry-after': String(left) });

      if (req.method === 'GET' && (url === '/.well-known/oauth-protected-resource' || url === '/.well-known/oauth-protected-resource/mcp')) return send(200, oauth.resourceMetadata(), { 'cache-control': 'max-age=300' });
      if (req.method === 'GET' && url === '/.well-known/oauth-authorization-server') return send(200, oauth.serverMetadata(), { 'cache-control': 'max-age=300' });

      if (req.method === 'POST' && url === '/oauth/register') {
        if (regLimit.locked(ip)) return send(429, { error: 'too_many_requests' });
        regLimit.hit(ip);
        const r = oauth.register(parseForm(req, await readBody(req, 16384)));
        return send(r.status, r.body);
      }
      if (req.method === 'GET' && url === '/oauth/authorize') {
        if (authzLimit.locked(ip)) return html(429, oauth.errorPage(429, 'Too many requests', 'Wait a while before trying to connect again.').html);
        authzLimit.hit(ip);
        const r = await oauth.authorize(Object.fromEntries(u.searchParams), ip);
        if (r.location) { res.writeHead(302, Object.assign(base(), { location: r.location })); return res.end(); }
        return html(r.status, r.html);
      }
      if (req.method === 'POST' && url === '/oauth/approve') {
        const b = parseForm(req, await readBody(req, 4096));
        const r = oauth.approveWithCode(b.id, b.s, b.code, b.scope, ip);
        if (r.status === 401) publicFail(ip, 'wrong authenticator code');
        return send(r.status, r.body);
      }
      if (req.method === 'GET' && url === '/oauth/status') { const r = oauth.status(u.searchParams.get('id'), u.searchParams.get('s')); return send(r.status, r.body); }
      if (req.method === 'POST' && url === '/oauth/token') {
        const r = await oauth.token(parseForm(req, await readBody(req, 16384)), basicAuth(req));
        if (r.status >= 400) publicFail(ip, 'token: ' + r.body.error);
        return send(r.status, r.body, { pragma: 'no-cache' });
      }
      if (req.method === 'POST' && url === '/oauth/revoke') { const r = await oauth.revokeToken(parseForm(req, await readBody(req, 16384)), basicAuth(req)); return send(r.status, r.body); }

      if (url === '/mcp' || url === '/mcp/') {
        const tok = bearerOf(req);
        const challenge = 'Bearer resource_metadata="' + cfg().publicUrl + '/.well-known/oauth-protected-resource", scope="livecompanion"';
        const grant = oauth.verify(tok, ip);
        let who = null;
        if (grant) who = { label: grant.clientName, access: capAccess(grant.scope), remote: true, ip, key: grant.id };
        else if (tok && cfg().security.allowTokenRemote && tokenOk(tok)) who = { label: 'Access token (outside)', access: capAccess(cfg().security.tokenScope), remote: true, ip, key: 'token' };
        if (!who) {
          if (tok) publicFail(ip, 'bad token on /mcp');
          return setTimeout(() => send(401, { error: tok ? 'invalid_token' : 'Sign-in required' }, { 'www-authenticate': challenge + (tok ? ', error="invalid_token"' : '') }), tok ? 300 : 0);
        }
        return runMcp(req, res, who);
      }
      return send(404, { error: 'Not found' });
    } catch (e) {
      return send(e.status || 500, { error: e.status === 413 ? 'Request too large' : 'Something went wrong' });
    }
  });
  publicServer.headersTimeout = 20000; publicServer.requestTimeout = 60000;

  function start() {
    mcpToken();
    setTimeout(checkCompanion, h.demo ? 200 : 1500).unref();
    setInterval(checkCompanion, 60000).unref();
    setInterval(reviewTimer, Number(process.env.LIVECOMPANION_REVIEW_TICK_MS) || 15000).unref();
    publicServer.on('error', (e) => console.error('Public port ' + h.publicPort + ': ' + e.message));
    publicServer.listen(h.publicPort, '0.0.0.0', () => console.log('Public port ' + h.publicPort + ': ' + (exposed() ? 'exposed mode, Claude sign-in and /mcp only' : 'local mode, serves nothing')));
  }

  return { start, route, adminRefusal, refuse, snapshot, exposed, mcpToken, tools, companion, checkCompanion, decideReview, publicServer, oauth };
}

module.exports = { create, normalize, DEFAULTS, LEVELS };
