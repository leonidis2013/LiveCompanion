#!/usr/bin/env node
/*
 * LiveCompanion
 * One dashboard for your Bitfocus Companion installs: it finds controllers and
 * Satellites over SSH, tells you when Companion or the operating system has
 * updates, and runs the updates for you. Everything is set up from the web page
 * and saved in the data folder. No packages to install: Node 18 or newer, plus
 * the OpenSSH client.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Discover = require('./discover.js');
const Sshlib = require('./lib/ssh.js');
const Secrets = require('./lib/secrets.js');
const Releases = require('./lib/releases.js');
const Mail = require('./lib/mail.js');
const { createEngine } = require('./lib/engine.js');
const pkg = require('./package.json');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const cfgPath = process.env.CONFIG || path.join(__dirname, 'data', 'config.json');
const dataDir = path.dirname(path.resolve(cfgPath));
const statePath = path.join(dataDir, 'state.json');
const PORT = Number(process.env.PORT || 8080);
const IN_DOCKER = fs.existsSync('/.dockerenv');

// ---------- config (saved from the web page) ----------
const DEFAULTS = {
  devices: [],
  schedule: { enabled: true, time: '03:30' },
  refreshLists: true,
  backup: { enabled: true, keep: 5 },
  email: { enabled: false, host: '', port: 587, secure: 'starttls', user: '', pass: '', from: '', to: '', allowSelfSigned: false }
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; console.error(file + ' could not be read: ' + e.message); process.exit(1); }
}
function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } fs.writeFileSync(file, text, { mode: 0o600 }); }
}

let cfg = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), DEMO ? {} : readJson(cfgPath, {}));
['schedule', 'backup', 'email'].forEach((k) => { cfg[k] = Object.assign({}, DEFAULTS[k], cfg[k] || {}); });
if (!Array.isArray(cfg.devices)) cfg.devices = [];

function changeConfig(mutator) {
  const next = JSON.parse(JSON.stringify(cfg));
  try {
    const err = mutator(next);
    if (err) return { ok: false, error: err };
    if (!DEMO) writeJson(cfgPath, next);
  } catch (e) {
    return { ok: false, status: 500, error: 'Could not save the settings (' + (e.code || e.message) + '). Is ' + dataDir + ' writable?' };
  }
  cfg = next;
  return { ok: true };
}

const state = DEMO ? {} : readJson(statePath, {});
let saveTimer = null;
function saveState() {
  if (DEMO) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeJson(statePath, state); } catch (e) { console.error('Could not save state: ' + e.message); } }, 300);
}

// ---------- optional control PIN (stored hashed) ----------
const verified = new Set();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pinSet = () => !!cfg.controlPinHash;
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function pinOk(given) {
  if (!pinSet()) return true;
  given = String(given == null ? '' : given);
  const key = sha(given);
  if (verified.has(key)) return true;
  const [alg, salt, hash] = String(cfg.controlPinHash).split(':');
  let good = false;
  if (alg === 'scrypt' && salt && hash) {
    const h = crypto.scryptSync(given, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
    good = h.length === b.length && crypto.timingSafeEqual(h, b);
  }
  if (good) verified.add(key);
  return good;
}

// ---------- engine ----------
const secrets = Secrets.create(path.join(dataDir, 'secret.key'));
let ssh, releases;
if (DEMO) {
  const demo = require('./lib/demo.js');
  ssh = demo.ssh; releases = demo.releases;
  cfg.devices = demo.devices();
} else {
  ssh = Sshlib.create({ dir: path.join(dataDir, 'ssh'), askpass: path.join(__dirname, 'bin', 'askpass.sh') });
  releases = Releases.cache();
}
const engine = createEngine({ ssh, secrets, getCfg: () => cfg, state, save: () => { saveState(); broadcastSoon(); }, dataDir, releases,
  pollMs: DEMO ? 700 : 2000, rebootPollMs: DEMO ? 800 : 5000 });

// ---------- helpers ----------
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const newId = () => crypto.randomBytes(3).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function describeStatus(st) {
  if (!st) return '';
  const bits = (st.installs || []).map((i) => i.label + (i.version ? ' ' + String(i.version).replace(/\+.*$/, '') : ''));
  if (st.sys && st.sys.os) bits.push(st.sys.os);
  return bits.join(', ');
}

function publicDevice(d) {
  const st = state.devices[d.id] || null;
  return {
    id: d.id, name: d.name, host: d.host, port: d.port || 22, user: d.user, auth: d.auth === 'password' ? 'password' : 'key',
    hasPassword: !!d.password, hasSudoPassword: !!d.sudoPassword,
    status: st, busy: engine.isBusy(d.id), jobId: engine.busyJob(d.id), checking: engine.isChecking(d.id)
  };
}

function snapshot() {
  const e = cfg.email;
  return {
    version: pkg.version, now: Date.now(), demo: DEMO,
    devices: cfg.devices.map(publicDevice),
    jobs: engine.jobList(),
    checkingAll: engine.isCheckingAll(),
    lastCheckAllAt: state.lastCheckAllAt || 0,
    settings: {
      schedule: cfg.schedule, refreshLists: cfg.refreshLists, backup: cfg.backup,
      email: { enabled: e.enabled, host: e.host, port: e.port, secure: e.secure, user: e.user, hasPass: !!e.pass, from: e.from, to: e.to, allowSelfSigned: !!e.allowSelfSigned }
    },
    sshKey: DEMO ? 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOnlyForTheDemoMode livecompanion' : ssh.publicKey(),
    pinRequired: pinSet(),
    update: { latest: upd.latest, available: !!upd.latest && newer(upd.latest, pkg.version), checkedAt: upd.checkedAt, failed: upd.failed, enabled: UPDATE_CHECK && !DEMO, image: IMAGE + ':' + upd.latest }
  };
}

// ---------- devices ----------
function validateConn(b, existing) {
  const host = clean(b.host != null ? b.host : existing && existing.host, 253);
  if (!host || !HOST_RE.test(host)) return { error: 'Enter the device\'s IP address or host name' };
  const port = b.port != null && b.port !== '' ? Number(b.port) : (existing && existing.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The SSH port must be a number from 1 to 65535' };
  const user = clean(b.user != null ? b.user : existing && existing.user, 32);
  if (!USER_RE.test(user)) return { error: 'Enter the user name to log in with' };
  const auth = (b.auth || (existing && existing.auth)) === 'password' ? 'password' : 'key';
  return { host, port, user, auth };
}

async function addDevice(b) {
  const v = validateConn(b);
  if (v.error) return { ok: false, error: v.error };
  if (v.auth === 'password' && !b.password) return { ok: false, error: 'Enter the password for ' + v.user };
  if (cfg.devices.some((d) => d.host.toLowerCase() === v.host.toLowerCase() && (d.port || 22) === v.port)) return { ok: false, error: 'That device is already added. Change its login under Your devices instead' };
  if (cfg.devices.length >= 60) return { ok: false, error: 'That is a lot of devices. The limit is 60' };
  const dev = Object.assign({ id: newId(), name: clean(b.name, 40) }, v, { password: secrets.enc(b.password || ''), sudoPassword: secrets.enc(b.sudoPassword || '') });
  if (dev.auth === 'key' && !ssh.publicKey()) await ssh.ensureKey();
  let r = await engine.testDevice(dev);
  if (!r.ok) return { ok: false, error: r.error.message, kind: r.error.kind };
  let keyNote = '';
  if (b.installKey && dev.auth === 'password') {
    const k = await engine.installKey(dev, await ssh.ensureKey());
    if (k.ok) {
      const keyDev = Object.assign({}, dev, { auth: 'key', password: '', sudoPassword: dev.sudoPassword || dev.password });
      const r2 = await engine.testDevice(keyDev);
      if (r2.ok) { Object.assign(dev, keyDev); r = r2; keyNote = 'LiveCompanion\'s key was installed, so it now logs in without the password.'; }
      else keyNote = 'The key was copied but a key login did not work, so the password is still used.';
    } else keyNote = 'Could not install the key (' + k.error + '). The password is used instead.';
  }
  dev.name = dev.name || r.status.sys.hostname || dev.host;
  const res = changeConfig((c) => { c.devices.push(dev); });
  if (!res.ok) return res;
  state.devices[dev.id] = r.status;
  saveState();
  engine.checkDevice(dev.id).catch(() => { /* shows up on the card */ });
  return { ok: true, id: dev.id, found: describeStatus(r.status), note: keyNote };
}

async function editDevice(b) {
  const dev = cfg.devices.find((d) => d.id === b.id);
  if (!dev) return { ok: false, error: 'That device is gone' };
  if (engine.isBusy(dev.id)) return { ok: false, error: 'It is being updated right now' };
  const v = validateConn(b, dev);
  if (v.error) return { ok: false, error: v.error };
  const next = Object.assign({}, dev, v, { name: clean(b.name != null ? b.name : dev.name, 40) || dev.name });
  if (b.password) next.password = secrets.enc(b.password);
  if (b.sudoPassword) next.sudoPassword = secrets.enc(b.sudoPassword);
  if (b.clearSudo) next.sudoPassword = '';
  if (next.auth === 'password' && !next.password) return { ok: false, error: 'Enter the password for ' + next.user };
  if (next.auth === 'key') next.password = '';
  const changedConn = v.host !== dev.host || v.port !== (dev.port || 22) || v.user !== dev.user || v.auth !== dev.auth || !!b.password || !!b.sudoPassword || !!b.clearSudo;
  if (changedConn && !b.force) {
    if (v.host !== dev.host || v.port !== (dev.port || 22)) await ssh.forgetHost(dev.host, dev.port || 22);
    const r = await engine.testDevice(next);
    if (!r.ok) return { ok: false, error: r.error.message, kind: r.error.kind };
  }
  const res = changeConfig((c) => { const i = c.devices.findIndex((d) => d.id === dev.id); c.devices[i] = next; });
  if (res.ok && changedConn) engine.checkDevice(dev.id).catch(() => { /* shows on the card */ });
  return res;
}

function removeDevice(b) {
  const dev = cfg.devices.find((d) => d.id === b.id);
  if (!dev) return { ok: false, error: 'That device is gone' };
  if (engine.isBusy(dev.id)) return { ok: false, error: 'It is being updated right now' };
  const res = changeConfig((c) => { c.devices = c.devices.filter((d) => d.id !== dev.id); });
  if (res.ok) { delete state.devices[dev.id]; saveState(); }
  return res;
}

async function trustKey(b) {
  const dev = cfg.devices.find((d) => d.id === b.id);
  if (!dev) return { ok: false, error: 'That device is gone' };
  await ssh.forgetHost(dev.host, dev.port || 22);
  await engine.checkDevice(dev.id);
  const st = state.devices[dev.id];
  return st && st.reachable ? { ok: true } : { ok: false, error: (st && st.error && st.error.message) || 'Could not connect with the new key' };
}

function devicesAction(b) {
  switch (b.action) {
    case 'add': return addDevice(b);
    case 'edit': return editDevice(b);
    case 'remove': return removeDevice(b);
    case 'trust': return trustKey(b);
    default: return { ok: false, error: 'Unknown action' };
  }
}

// ---------- settings and email ----------
function changeSettings(b) {
  const r = changeConfig((c) => {
    if (b.schedule) {
      if (b.schedule.time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.schedule.time))) return 'Use a time like 03:30';
      if (b.schedule.time != null) c.schedule.time = String(b.schedule.time);
      if (b.schedule.enabled != null) c.schedule.enabled = !!b.schedule.enabled;
    }
    if (b.refreshLists != null) c.refreshLists = !!b.refreshLists;
    if (b.backup) {
      if (b.backup.enabled != null) c.backup.enabled = !!b.backup.enabled;
      if (b.backup.keep != null) {
        const k = Number(b.backup.keep);
        if (!Number.isInteger(k) || k < 1 || k > 50) return 'Keep between 1 and 50 backups';
        c.backup.keep = k;
      }
    }
    if (b.newPin !== undefined) {
      if (b.newPin === null || b.newPin === '') delete c.controlPinHash;
      else if (String(b.newPin).length < 4) return 'Use a PIN of at least 4 characters';
      else c.controlPinHash = hashPin(String(b.newPin));
    }
    return null;
  });
  if (r.ok && b.newPin !== undefined) verified.clear();
  return r;
}

function changeEmail(b) {
  return changeConfig((c) => {
    const e = c.email;
    if (b.host != null) e.host = clean(b.host, 253);
    if (b.port != null) { const p = Number(b.port); if (!Number.isInteger(p) || p < 1 || p > 65535) return 'The mail port must be a number from 1 to 65535'; e.port = p; }
    if (b.secure != null) { if (!['starttls', 'tls', 'none'].includes(b.secure)) return 'Pick a connection type'; e.secure = b.secure; }
    if (b.user != null) e.user = clean(b.user, 200);
    if (b.pass) e.pass = secrets.enc(b.pass);
    if (b.clearPass) e.pass = '';
    if (b.from != null) e.from = clean(b.from, 200);
    if (b.to != null) e.to = clean(b.to, 400);
    if (b.allowSelfSigned != null) e.allowSelfSigned = !!b.allowSelfSigned;
    if (b.enabled != null) {
      if (b.enabled && (!e.host || !e.from || !e.to)) return 'Fill in the mail server, From and To first';
      e.enabled = !!b.enabled;
    }
    return null;
  });
}

const mailConf = () => Object.assign({}, cfg.email, { pass: secrets.dec(cfg.email.pass) });

async function sendTest() {
  try {
    await Mail.send(mailConf(), { subject: 'LiveCompanion test message', text: 'This is a test from LiveCompanion. Mail is working.' });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** After a scheduled check: one email when there is something new to update. */
async function maybeNotify() {
  if (!cfg.email.enabled) return;
  const pend = engine.pending().map((p) => ({ name: p.name, host: p.host, items: p.items.filter((i) => !/^Reboot/.test(i)) })).filter((p) => p.items.length);
  if (!pend.length) { state.lastMailSig = ''; saveState(); return; }
  const sig = sha(JSON.stringify(pend.map((p) => [p.name, p.items])));
  if (sig === state.lastMailSig) return;
  const lines = pend.map((p) => p.name + ' (' + p.host + ')\n' + p.items.map((i) => '  - ' + i).join('\n'));
  const text = 'Updates are waiting:\n\n' + lines.join('\n\n') + '\n\nOpen LiveCompanion to install them.\n';
  try {
    await Mail.send(mailConf(), { subject: 'LiveCompanion: ' + pend.length + ' device' + (pend.length === 1 ? '' : 's') + ' with updates', text });
    state.lastMailSig = sig; saveState();
  } catch (e) { console.error('Could not send the update email: ' + e.message); }
}

// ---------- schedule ----------
const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
let scheduledRunning = false;
async function runScheduled() {
  if (scheduledRunning) return;
  scheduledRunning = true;
  try { await engine.checkAll(); await maybeNotify(); }
  finally { scheduledRunning = false; }
}
function tick() {
  if (!cfg.schedule.enabled || !cfg.devices.length) return;
  const d = new Date();
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (hhmm >= cfg.schedule.time && state.lastScheduled !== dayKey(d)) {
    state.lastScheduled = dayKey(d); saveState();
    runScheduled();
  }
}

// ---------- is there a newer LiveCompanion? (reads a version number from GitHub; changes nothing) ----------
const UPDATE_URL = process.env.LIVECOMPANION_UPDATE_URL || 'https://raw.githubusercontent.com/leonidis2013/LiveCompanion/main/package.json';
const UPDATE_CHECK = process.env.LIVECOMPANION_NO_UPDATE_CHECK !== '1';
const IMAGE = 'ghcr.io/leonidis2013/livecompanion';
let upd = { latest: '', checkedAt: 0, failed: false };

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function checkSelfUpdate() {
  return new Promise((resolve) => {
    let done = false;
    const end = (latest) => {
      if (done) return; done = true;
      upd = latest ? { latest, checkedAt: Date.now(), failed: false } : { latest: upd.latest, checkedAt: Date.now(), failed: true };
      resolve(!!latest);
    };
    try {
      const lib = UPDATE_URL.startsWith('https:') ? https : http;
      const req = lib.get(UPDATE_URL, { timeout: 6000, headers: { 'user-agent': 'LiveCompanion/' + pkg.version } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return end(null); }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        res.on('end', () => { try { const v = String(JSON.parse(raw).version || ''); end(/^\d+\.\d+\.\d+$/.test(v) ? v : null); } catch (e) { end(null); } });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => end(null));
    } catch (e) { end(null); }
  });
}

// ---------- searching the network ----------
let scanState = { id: 0, running: false, total: 0, done: 0, found: [], range: '' };
function startScan(rangeText) {
  if (scanState.running) return { ok: false, error: 'A search is already running' };
  const r = Discover.parseRange(rangeText);
  if (r.error) return { ok: false, error: r.error };
  scanState = { id: scanState.id + 1, running: true, total: r.hosts.length, done: 0, found: [], range: r.label };
  Discover.scan(r.hosts, scanState).catch(() => { scanState.running = false; });
  return { ok: true };
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'] };
const clients = new Set();

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function postJson(req, res, fn, { needPin = true, limit = 16384 } = {}) {
  let raw = '', tooBig = false;
  req.on('data', (d) => { if (tooBig) return; raw += d; if (raw.length > limit) { tooBig = true; raw = ''; } });
  req.on('end', () => {
    if (needPin && !pinOk(req.headers['x-pin'])) return setTimeout(() => json(res, 401, { ok: false, error: 'Wrong or missing PIN' }), 500);
    if (tooBig) return json(res, 413, { ok: false, error: 'That is too large' });
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'Bad JSON' }); }
    Promise.resolve().then(() => fn(body)).then((r) => {
      r = r || { ok: false, error: 'Nothing happened' };
      json(res, r.ok ? 200 : (r.status || 400), Object.assign({}, r, { status: undefined }));
      broadcastSoon();
    }).catch((e) => json(res, 500, { ok: false, error: 'Something went wrong: ' + e.message }));
  });
}

let broadcastTimer = null;
function broadcastSoon() {
  if (!clients.size || broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const c of clients) c.write(msg);
  }, 150);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;

  if (req.method === 'GET' && FILES[url]) {
    const [file, type] = FILES[url];
    return fs.readFile(path.join(PUBLIC, file), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Missing ' + file); }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(data);
    });
  }
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, snapshot());

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && url === '/api/job') {
    const j = engine.getJob(u.searchParams.get('id') || '');
    return j ? json(res, 200, j) : json(res, 404, { ok: false, error: 'That job is gone' });
  }
  if (req.method === 'GET' && url === '/api/backups') {
    const id = u.searchParams.get('id') || '';
    if (!cfg.devices.some((d) => d.id === id)) return json(res, 404, { ok: false, error: 'Unknown device' });
    return json(res, 200, { backups: engine.listBackups(id) });
  }
  if (req.method === 'GET' && url === '/api/backup') {
    if (!pinOk(u.searchParams.get('pin') || req.headers['x-pin'])) { res.writeHead(401); return res.end('Wrong or missing PIN'); }
    const p = engine.backupPath(u.searchParams.get('id') || '', u.searchParams.get('file') || '');
    if (!p) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="' + path.basename(p) + '"' });
    return fs.createReadStream(p).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/discover') {
    const ranges = Discover.suggestRanges({ clientIp: req.socket.remoteAddress, includeInterfaces: !IN_DOCKER });
    const have = new Set(cfg.devices.map((d) => d.host));
    return json(res, 200, Object.assign({}, scanState, { ranges, found: scanState.found.map((f) => Object.assign({}, f, { added: have.has(f.host) })) }));
  }

  if (req.method === 'POST' && url === '/api/devices') return postJson(req, res, devicesAction);
  if (req.method === 'POST' && url === '/api/check') {
    return postJson(req, res, (b) => {
      if (b.id) { if (!cfg.devices.some((d) => d.id === b.id)) return { ok: false, error: 'Unknown device' }; engine.checkDevice(b.id, { refresh: true }).then(broadcastSoon); }
      else engine.checkAll({ refresh: cfg.refreshLists !== false }).then(broadcastSoon);
      return { ok: true };
    });
  }
  if (req.method === 'POST' && url === '/api/update') return postJson(req, res, (b) => engine.startJobs(Array.isArray(b.items) ? b.items.slice(0, 60) : []));
  if (req.method === 'POST' && url === '/api/settings') return postJson(req, res, changeSettings);
  if (req.method === 'POST' && url === '/api/email') return postJson(req, res, changeEmail);
  if (req.method === 'POST' && url === '/api/email-test') return postJson(req, res, () => DEMO ? { ok: false, error: 'Demo mode does not send mail' } : sendTest());
  if (req.method === 'POST' && url === '/api/update-check') {
    return postJson(req, res, () => (UPDATE_CHECK && !DEMO) ? checkSelfUpdate().then((ok) => ({ ok, error: ok ? undefined : 'Could not reach GitHub to check. Is this machine online?' })) : { ok: false, error: 'Update checks are turned off' }, { needPin: false });
  }
  if (req.method === 'POST' && url === '/api/discover') {
    return postJson(req, res, (b) => {
      if (DEMO) return { ok: false, error: 'Demo mode: the devices are simulated' };
      if (b.stop) { scanState.running = false; return { ok: true }; }
      return startScan(b.range);
    });
  }

  res.writeHead(404); res.end('Not found');
});

setInterval(broadcastSoon, 1500).unref();
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => process.exit(0)));

async function start() {
  if (!DEMO) {
    const pub = await ssh.ensureKey();
    if (!pub) console.error('Could not create the SSH key. Is ssh-keygen installed? Password logins still work.');
    if (UPDATE_CHECK) { setTimeout(checkSelfUpdate, 5000).unref(); setInterval(checkSelfUpdate, 6 * 3600 * 1000).unref(); }
  }
  setInterval(tick, 30000).unref();
  setTimeout(() => {
    const stale = !state.lastCheckAllAt || Date.now() - state.lastCheckAllAt > 6 * 3600 * 1000;
    if (cfg.devices.length && (stale || DEMO)) engine.checkAll();
  }, DEMO ? 300 : 15000).unref();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('LiveCompanion v' + pkg.version + ' on http://localhost:' + PORT + (DEMO ? ' (demo: simulated devices)' : ''));
    if (!pinSet()) console.log('Note: anyone on this network can use this dashboard, and it can run updates as root on your devices. Set a control PIN in Settings to require one.');
  });
}

if (require.main === module) start();

module.exports = { engine, cfgGet: () => cfg, snapshot };
