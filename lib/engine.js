/*
 * The part that does the work: look at devices, run updates on them, back up first.
 *
 * Everything that touches a device goes through `ssh.run`, so the tests can swap in
 * a fake. Updates run as a detached script on the device (it keeps going if the
 * connection drops, which matters for apt) and LiveCompanion follows its log.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const S = require('./scripts');
const Probe = require('./probe');
const Rel = require('./releases');
const V = require('./version');

const MAX_LOG = 200000;
const HISTORY = 50;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r(?!\n)/g;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); };
const safe = (s) => String(s || '').replace(/[^0-9A-Za-z.+-]/g, '_').slice(0, 40) || 'unknown';

function createEngine(deps) {
  const { ssh, secrets, getCfg, state, save, dataDir, releases } = deps;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs || 2000;
  const rebootPollMs = deps.rebootPollMs || 5000;
  const rebootMaxMs = deps.rebootMaxMs || 10 * 60 * 1000;

  state.devices = state.devices || {};
  state.history = state.history || [];

  const jobs = new Map();            // this session's jobs, newest last
  const busy = new Map();            // deviceId -> jobId (one job per device at a time)
  const checking = new Set();
  let checkingAll = false;

  const findDev = (id) => ((getCfg().devices) || []).find((d) => d.id === id);

  // ---------- talking to a device ----------
  function conn(dev) {
    const pw = secrets.dec(dev.password);
    const auth = dev.auth === 'password' ? 'password' : 'key';
    const sudoPw = secrets.dec(dev.sudoPassword) || (auth === 'password' ? pw : '');
    return { host: dev.host, port: dev.port || 22, user: dev.user, auth, password: pw, sudoPw };
  }

  function exec(c, script, o = {}) {
    const needPw = c.user !== 'root' && !!c.sudoPw;
    return ssh.run(c, S.command(script, { pw: needPw, env: o.env }), {
      input: needPw ? c.sudoPw + '\n' : undefined, timeoutMs: o.timeoutMs || 90000, stdoutTo: o.stdoutTo
    });
  }

  const feedFor = async (product, arch) => {
    const target = Rel.targetFor(arch);
    if (!target) return { ok: true, latest: null };
    return releases.get(product, target);
  };

  /** Probe one device and turn the answer into a status record. */
  async function probeDev(dev, { refresh }) {
    const c = conn(dev);
    const r = await exec(c, S.probe(), { env: refresh ? { LC_REFRESH: '1' } : {}, timeoutMs: refresh ? 240000 : 60000 });
    const parsed = Probe.parse(r.stdout);
    if (!parsed.map.lc_probe) {
      const err = r.err || { kind: 'other', message: 'The device did not answer the check' };
      return { ok: false, error: err };
    }
    const built = await Probe.buildStatus(dev, parsed, feedFor);
    return { ok: true, status: Object.assign(built, { reachable: true, error: null, checkedAt: now() }) };
  }

  async function checkDevice(id, opts = {}) {
    const dev = findDev(id);
    if (!dev) return null;
    if (checking.has(id) || (busy.has(id) && !opts.force)) return state.devices[id] || null;
    checking.add(id);
    try {
      const refresh = opts.refresh !== undefined ? opts.refresh : getCfg().refreshLists !== false;
      const r = await probeDev(dev, { refresh });
      const prev = state.devices[id];
      if (r.ok) state.devices[id] = r.status;
      else state.devices[id] = Object.assign({ installs: [], sys: {}, os: null, reboot: { required: false } }, prev || {}, { reachable: false, error: r.error, checkedAt: now() });
      save();
      return state.devices[id];
    } finally { checking.delete(id); }
  }

  async function checkAll(opts = {}) {
    if (checkingAll) return;
    checkingAll = true;
    try {
      const ids = ((getCfg().devices) || []).map((d) => d.id);
      let next = 0;
      const worker = async () => { while (next < ids.length) { const id = ids[next++]; try { await checkDevice(id, opts); } catch (e) { /* one device never stops the rest */ } } };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      state.lastCheckAllAt = now();
      save();
    } finally { checkingAll = false; }
  }

  /** Probe a device that is not saved yet (used when adding one). */
  const testDevice = (dev) => probeDev(dev, { refresh: false });

  async function installKey(dev, pub) {
    const c = conn(dev);
    const r = await exec(c, S.installKey({ pub }), { timeoutMs: 30000 });
    return r.code === 0 && /done/.test(r.stdout) ? { ok: true } : { ok: false, error: (r.err && r.err.message) || 'Could not install the key' };
  }

  // ---------- jobs ----------
  function log(job, text) {
    // wget download progress would drown the log ("253650K .......... 65% 31.5M 4s")
    const t = String(text).replace(ANSI, '').split('\n').filter((l) => !/^\s*\d+K [. ]+\d+%/.test(l) && !/^[. ]{10,}.*\d+%\s+[\d.]+[KMG]\s/.test(l)).join('\n');
    if (!t.trim() && String(text).trim()) return;
    job.log += t.endsWith('\n') ? t : t + '\n';
    if (job.log.length > MAX_LOG) job.log = '...\n' + job.log.slice(job.log.length - MAX_LOG + 4);
  }
  const note = (job, text) => log(job, '> ' + text);

  /** Run a script on the device in the background and follow its output until it ends. */
  async function detached(job, dev, script, { timeoutMs = 30 * 60 * 1000 } = {}) {
    const c = conn(dev);
    const id = 'j' + job.id + crypto.randomBytes(2).toString('hex');
    const needPw = c.user !== 'root' && !!c.sudoPw;
    const r = await ssh.run(c, S.launch(id, script, { pw: needPw }), { input: needPw ? c.sudoPw + '\n' : undefined, timeoutMs: 45000 });
    if (!/LC_STARTED/.test(r.stdout)) throw new Error('Could not start the job on the device: ' + ((r.err && r.err.message) || String(r.stderr).trim().split('\n')[0] || 'no answer'));
    let offset = 0, lostSince = 0;
    const t0 = now();
    for (;;) {
      await sleep(pollMs);
      const p = await ssh.run(c, S.poll(id, offset), { timeoutMs: 30000 });
      const at = p.stdout.indexOf('LC_DATA\n');
      if (p.code !== 0 || at < 0) {
        if (!lostSince) { lostSince = now(); note(job, 'Lost contact with the device, still trying...'); }
        if (now() - lostSince > 5 * 60 * 1000) throw new Error('Lost contact with the device. The job may still be running there. Check it again in a few minutes.');
        continue;
      }
      if (lostSince) { lostSince = 0; note(job, 'Back in contact.'); }
      const head = p.stdout.slice(0, at), data = p.stdout.slice(at + 8);
      const size = Number((/LC_SIZE=(\d+)/.exec(head) || [])[1] || 0);
      const next = Number((/LC_NEXT=(\d+)/.exec(head) || [])[1] || offset);
      const rc = (/LC_RC=(\d*)/.exec(head) || [])[1];
      if (data) log(job, data.replace(/\n$/, ''));
      offset = next;
      if (rc !== undefined && rc !== '' && offset >= size) {
        ssh.run(c, S.cleanup(id), { timeoutMs: 15000 }).catch(() => { /* leftovers in /tmp are harmless */ });
        if (Number(rc) !== 0) throw new Error('The command failed on the device (exit ' + rc + ')');
        return;
      }
      if (now() - t0 > timeoutMs) throw new Error('Gave up waiting after ' + Math.round(timeoutMs / 60000) + ' minutes. It may still be running on the device.');
    }
  }

  // ---------- backups ----------
  const backupDir = (id) => path.join(dataDir, 'backups', id);
  const BACKUP_NAME = /^[0-9]{8}-[0-9]{6}-[0-9A-Za-z.+_-]+\.tgz$/;

  function listBackups(id) {
    try {
      return fs.readdirSync(backupDir(id)).filter((f) => BACKUP_NAME.test(f)).sort().reverse().map((f) => {
        const st = fs.statSync(path.join(backupDir(id), f));
        return { file: f, bytes: st.size, at: st.mtimeMs };
      });
    } catch (e) { return []; }
  }
  function backupPath(id, file) {
    if (!BACKUP_NAME.test(String(file))) return null;
    const p = path.join(backupDir(id), file);
    return fs.existsSync(p) ? p : null;
  }
  function prune(id, instId) {
    const keep = Math.max(1, Number((getCfg().backup || {}).keep) || 5);
    const mine = listBackups(id).filter((b) => b.file.split('-').slice(2).join('-').startsWith(safe(instId) + '-'));
    mine.slice(keep).forEach((b) => { try { fs.unlinkSync(path.join(backupDir(id), b.file)); } catch (e) { /* gone */ } });
  }
  const checkTgz = (file) => new Promise((resolve) => execFile('tar', ['-tzf', file], { maxBuffer: 64 * 1024 * 1024 }, (err) => resolve(!err)));

  /** Copy a device's configuration to this server before anything is changed. */
  async function backup(job, dev, inst) {
    const script = inst.id === 'companion' && inst.cfg ? S.backupCompanion({ cfg: inst.cfg })
      : inst.id === 'satellite' && inst.cfg ? S.backupFile({ file: inst.cfg }) : null;
    if (!script && inst.id === 'companion') {
      throw new Error('Could not find the Companion configuration folder on the device, so no backup could be made. Nothing was changed. Run a Check again, or turn off "Back up before updating" in Settings to update without one.');
    }
    if (!script) { note(job, 'No configuration file found to back up for ' + inst.label + ', continuing without a backup.'); return; }
    fs.mkdirSync(backupDir(dev.id), { recursive: true });
    const name = stamp(now()) + '-' + safe(inst.id) + '-' + safe(V.short(inst.version)) + '.tgz';
    const tmp = path.join(backupDir(dev.id), name + '.part');
    const out = fs.createWriteStream(tmp);
    const closed = new Promise((res) => out.on('close', res));
    note(job, 'Backing up the ' + inst.label + ' configuration' + (inst.id === 'companion' ? ' (Companion stops for a moment)' : '') + '...');
    const r = await exec(conn(dev), script, { stdoutTo: out, timeoutMs: 15 * 60 * 1000 });
    if (!out.writableEnded) out.end();
    await closed;
    let size = 0;
    try { size = fs.statSync(tmp).size; } catch (e) { /* none */ }
    if (r.code !== 0 || size < 20 || !(await checkTgz(tmp))) {
      try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
      throw new Error('The configuration backup did not work (' + ((r.err && r.err.message) || 'the file was empty or damaged') + '). Nothing was changed.');
    }
    fs.renameSync(tmp, path.join(backupDir(dev.id), name));
    note(job, 'Backup saved: ' + name + ' (' + Math.max(1, Math.round(size / 1024)) + ' KB)');
    prune(dev.id, inst.id);
  }

  // ---------- steps ----------
  const findInst = (st, id) => ((st && st.installs) || []).find((i) => i.id === id);

  async function stepSoftware(job, dev, step) {
    const inst = findInst(state.devices[dev.id], step.key);
    if (!inst) throw new Error('That program is no longer on the device');
    if ((getCfg().backup || {}).enabled !== false) await backup(job, dev, inst);
    else note(job, 'Backups are turned off, going straight to the update.');
    const before = inst.version;
    note(job, 'Updating ' + inst.label + ' from ' + (V.short(before) || 'unknown') + '...');
    await detached(job, dev, inst.id === 'companion' ? S.companionUpdate() : S.satelliteUpdate(), { timeoutMs: 25 * 60 * 1000 });
    await sleep(Math.min(pollMs, 3000));
    const re = await probeDev(dev, { refresh: false });
    if (!re.ok) throw new Error('The update ran, but the device did not answer the follow-up check: ' + re.error.message);
    const after = findInst(re.status, inst.id);
    if (!after) throw new Error('The update ran, but ' + inst.label + ' is not found on the device any more');
    if (after.version === before) throw new Error('The updater finished, but ' + inst.label + ' is still on ' + (V.short(before) || 'the same version') + '. See the log above.');
    note(job, inst.label + ' is now ' + V.short(after.version) + (after.service && after.service !== 'active' ? ' (service is ' + after.service + ')' : ''));
    step.detail = V.short(before) + ' to ' + V.short(after.version);
  }

  async function stepDocker(job, dev, step) {
    const inst = findInst(state.devices[dev.id], step.key);
    if (!inst) throw new Error('That container is no longer on the device');
    note(job, 'Configuration lives in the container\'s own volume and is not backed up by LiveCompanion.');
    await detached(job, dev, S.dockerUpdate({ cwd: inst.cwd, svc: inst.svc }), { timeoutMs: 20 * 60 * 1000 });
    step.detail = 'new image running';
  }

  async function stepOs(job, dev, step) {
    note(job, 'Installing operating system updates...');
    await detached(job, dev, S.osUpdate(), { timeoutMs: 90 * 60 * 1000 });
    const re = await probeDev(dev, { refresh: false });
    if (re.ok) {
      step.detail = re.status.os.count ? re.status.os.count + ' left (held back)' : 'all installed';
      note(job, re.status.os.count ? re.status.os.count + ' package(s) were held back by apt.' : 'All updates are installed.');
      if (re.status.reboot.required) note(job, 'A reboot is needed to finish.');
    }
  }

  async function stepReboot(job, dev, step) {
    const c = conn(dev);
    const before = (state.devices[dev.id] && state.devices[dev.id].sys && state.devices[dev.id].sys.bootId) || '';
    const needPw = c.user !== 'root' && !!c.sudoPw;
    const id = 'j' + job.id + 'rb';
    const r = await ssh.run(c, S.launch(id, S.reboot(), { pw: needPw }), { input: needPw ? c.sudoPw + '\n' : undefined, timeoutMs: 45000 });
    if (!/LC_STARTED/.test(r.stdout)) throw new Error('Could not ask the device to reboot: ' + ((r.err && r.err.message) || 'no answer'));
    note(job, 'Reboot requested. Waiting for the device to come back...');
    const t0 = now();
    let wentDown = false;
    await sleep(Math.min(rebootPollMs * 3, 15000));
    while (now() - t0 < rebootMaxMs) {
      const p = await ssh.run(c, 'cat /proc/sys/kernel/random/boot_id', { timeoutMs: 12000 });
      const id2 = p.code === 0 ? p.stdout.trim() : null;
      if (id2 === null) wentDown = true;
      else if ((before && id2 !== before) || (!before && wentDown)) { note(job, 'The device is back.'); step.detail = 'back online'; return; }
      await sleep(rebootPollMs);
    }
    throw new Error('The device did not come back within ' + Math.round(rebootMaxMs / 60000) + ' minutes.');
  }

  async function runStep(job, dev, step) {
    if (step.key === 'os') return stepOs(job, dev, step);
    if (step.key === 'reboot') return stepReboot(job, dev, step);
    if (step.key.startsWith('docker:')) return stepDocker(job, dev, step);
    return stepSoftware(job, dev, step);
  }

  async function runJob(job) {
    const dev = findDev(job.deviceId);
    job.status = 'running';
    job.startedAt = now();
    try {
      if (!dev) throw new Error('That device was removed');
      note(job, 'Starting on ' + dev.name + ' (' + dev.host + ')');
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i];
        step.status = 'running';
        note(job, '== ' + step.label + ' ==');
        try { await runStep(job, dev, step); step.status = 'ok'; }
        catch (e) {
          step.status = 'failed'; step.detail = e.message;
          log(job, 'FAILED: ' + e.message);
          job.failed = true;
          for (let j = i + 1; j < job.steps.length; j++) job.steps[j].status = 'skipped';
          break;
        }
      }
    } catch (e) { job.failed = true; log(job, 'FAILED: ' + e.message); }
    job.status = job.failed ? 'failed' : 'done';
    job.endedAt = now();
    job.summary = job.failed
      ? (job.steps.find((s) => s.status === 'failed') || {}).detail || 'Failed'
      : job.steps.map((s) => s.label + (s.detail ? ' (' + s.detail + ')' : '')).join(', ');
    note(job, job.failed ? 'Stopped.' : 'Finished.');
    busy.delete(job.deviceId);
    try { await checkDevice(job.deviceId, { refresh: false, force: true }); } catch (e) { /* the status will catch up on the next check */ }
    state.history.unshift({ id: job.id, deviceId: job.deviceId, name: job.name, steps: job.steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail || '' })),
      status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, summary: job.summary, log: job.log.slice(-60000) });
    state.history.length = Math.min(state.history.length, HISTORY);
    save();
  }

  /** Which steps will actually run for what the person asked for. */
  function planSteps(st, wanted) {
    const steps = [];
    const want = new Set(wanted || []);
    ((st && st.installs) || []).filter((i) => !i.docker && !i.hidden).forEach((i) => {
      if (want.has(i.id) && i.available && i.canUpdate) steps.push({ key: i.id, label: 'Update ' + i.label + ' to ' + V.short(i.latest) });
    });
    ((st && st.installs) || []).filter((i) => i.docker && !i.hidden).forEach((i) => {
      if (want.has(i.id) && i.available && i.canUpdate) steps.push({ key: i.id, label: 'Update ' + i.label + ' (' + i.name + ')' });
    });
    if (want.has('os') && st && st.os && !st.os.disabled && st.os.supported && st.os.canUpdate && st.os.count > 0) steps.push({ key: 'os', label: 'Operating system updates (' + st.os.count + ')' });
    if (want.has('reboot') && st && st.reachable && !(st.reboot && st.reboot.disabled)) steps.push({ key: 'reboot', label: 'Reboot' });
    return steps.map((s) => Object.assign({ status: 'pending', detail: '' }, s));
  }

  /** items: [{ id, steps: [...] }]. Each device gets one job; different devices run side by side. */
  function startJobs(items) {
    const created = [], errors = [];
    for (const it of items || []) {
      const dev = findDev(it.id);
      if (!dev) { errors.push('Unknown device'); continue; }
      if (busy.has(dev.id)) { errors.push(dev.name + ' is already busy'); continue; }
      const st = state.devices[dev.id];
      if (!st || !st.reachable) { errors.push(dev.name + ' is not reachable'); continue; }
      const steps = planSteps(st, it.steps);
      if (!steps.length) { errors.push('There is nothing to do on ' + dev.name); continue; }
      const job = { id: crypto.randomBytes(4).toString('hex'), deviceId: dev.id, name: dev.name, steps, status: 'queued', log: '', startedAt: 0, endedAt: 0, summary: '' };
      jobs.set(job.id, job);
      busy.set(dev.id, job.id);
      created.push(job);
    }
    created.forEach((job) => { runJob(job).catch((e) => { job.status = 'failed'; job.summary = e.message; busy.delete(job.deviceId); }); });
    while (jobs.size > 60) jobs.delete(jobs.keys().next().value);
    return { ok: created.length > 0, jobs: created.map((j) => j.id), error: errors.length ? errors.join(' ') : undefined };
  }

  function getJob(id) {
    const live = jobs.get(id);
    if (live) return { id: live.id, deviceId: live.deviceId, name: live.name, status: live.status, steps: live.steps, startedAt: live.startedAt, endedAt: live.endedAt, summary: live.summary, log: live.log };
    const h = state.history.find((x) => x.id === id);
    return h ? Object.assign({}, h) : null;
  }

  /** Small version of every job for the dashboard: running ones with the last bit of their log. */
  function jobList() {
    const live = Array.from(jobs.values()).map((j) => ({
      id: j.id, deviceId: j.deviceId, name: j.name, status: j.status, steps: j.steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail || '' })),
      startedAt: j.startedAt, endedAt: j.endedAt, summary: j.summary, tail: j.log.split('\n').filter(Boolean).slice(-4).join('\n')
    }));
    const liveIds = new Set(live.map((j) => j.id));
    const old = state.history.filter((h) => !liveIds.has(h.id)).map((h) => ({ id: h.id, deviceId: h.deviceId, name: h.name, status: h.status, steps: h.steps, startedAt: h.startedAt, endedAt: h.endedAt, summary: h.summary, tail: '' }));
    return live.reverse().concat(old).slice(0, 30);
  }

  // ---------- what is waiting (for the badge and the email) ----------
  function pending() {
    const out = [];
    ((getCfg().devices) || []).forEach((d) => {
      const st = state.devices[d.id];
      const items = Probe.pendingItems(st);
      if (items.length) out.push({ id: d.id, name: d.name, host: d.host, items });
    });
    return out;
  }

  return {
    conn, checkDevice, checkAll, testDevice, installKey, startJobs, getJob, jobList, pending,
    listBackups, backupPath, planSteps, isBusy: (id) => busy.has(id), busyJob: (id) => busy.get(id) || '', isChecking: (id) => checking.has(id), isCheckingAll: () => checkingAll,
    _internal: { detached, stepReboot, findDev }
  };
}

module.exports = { createEngine };
