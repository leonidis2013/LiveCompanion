/*
 * Turns the text a device prints for the probe script into a status record:
 * what is installed, what version, whether something newer is out, whether the
 * operating system has updates, whether a reboot is waiting.
 */
'use strict';

const V = require('./version');
const Rel = require('./releases');

const int = (s, d = 0) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : d; };
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** key=value lines -> { map, docker: [...] }. Values may contain "=" and "|". */
function parse(text) {
  const map = {}, docker = [];
  String(text || '').split('\n').forEach((line) => {
    const i = line.indexOf('=');
    if (i < 1) return;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).replace(/\r$/, '');
    if (k === 'docker') docker.push(v); else map[k] = v;
  });
  return { map, docker };
}

function parseDocker(line) {
  const f = line.split('|');
  const [cid, name, image, state, cwd, svc, ver, rdig, remote] = f;
  return { cid: cid || '', name: name || '', image: image || '', state: state || '', cwd: cwd || '', svc: svc || '', ver: ver || '', digests: list(rdig), remote: (remote || '').trim() };
}

/** Where a person would open each program in a browser. */
function webUrl(host, port) { return 'http://' + host + (port && Number(port) !== 80 ? ':' + port : ''); }

/**
 * feedFor(product, arch) -> Promise<{ ok, latest: {version,uri}|null, error? }>
 * Returns { status, installs } ready to store.
 */
async function buildStatus(dev, parsed, feedFor) {
  const p = parsed.map;
  const root = p.uid === '0';
  const sys = {
    hostname: p.hostname || '', os: p.os || '', osId: p.os_id || '', osVer: p.os_ver || '', arch: p.arch || '', kernel: p.kernel || '',
    uptime: int(p.uptime, 0), user: p.user || dev.user, root, sudo: p.sudo === '1', bootId: p.boot_id || ''
  };
  const canAdmin = root || sys.sudo;
  const adminWhy = 'The SSH user needs root or sudo rights to do this';

  const os = p.pkg_mgr === 'apt'
    ? {
      mgr: 'apt', supported: true, count: int(p.apt_count), security: int(p.apt_security), kept: int(p.apt_kept),
      packages: list(p.apt_pkgs), listsAge: p.apt_lists_age != null && p.apt_lists_age !== '' ? int(p.apt_lists_age) : null,
      refreshed: p.apt_refreshed === undefined ? null : p.apt_refreshed === '1', canUpdate: canAdmin, why: canAdmin ? '' : adminWhy
    }
    : { mgr: p.pkg_mgr || 'none', supported: false, count: 0, security: 0, kept: 0, packages: [], listsAge: null, refreshed: null, canUpdate: false, why: 'Only apt based systems (Debian, Ubuntu, Raspberry Pi OS) can be updated from here' };

  const reboot = { required: p.reboot_required === '1', why: p.reboot_why || '', packages: list(p.reboot_pkgs) };
  const installs = [];
  const feedNotes = [];
  const feedFailed = (r) => { if (r && !r.ok && r.error) feedNotes.push(r.error); };

  async function software(id, kind, label, build, service, port, managed, legacy, cfg, product, managedWhy, defaultPort) {
    const version = String(build || '').trim();
    const feed = await feedFor(product, sys.arch);
    feedFailed(feed);
    const inst = {
      id, kind, label, version, channel: V.channel(version), service: service || 'unknown',
      url: webUrl(dev.host, port || defaultPort), latest: '', available: false, note: '', cfg: cfg || '',
      canUpdate: false, why: ''
    };
    if (!version) inst.note = 'Version could not be read';
    if (!feed.ok) inst.note = inst.note || 'Could not check for a newer build';
    else if (!feed.latest) inst.note = 'Bitfocus lists no stable build for this CPU';
    else {
      inst.latest = feed.latest.version;
      const c = V.compare(version, feed.latest.version);
      if (c === -1) inst.available = true;
      else if (c === null) inst.note = inst.note || 'Version could not be compared';
      else if (inst.channel === 'beta') inst.note = 'Beta build, not older than the newest stable';
    }
    if (legacy) { inst.canUpdate = false; inst.why = 'This is an old Companion 2.x install. Upgrading it asks questions, so do it once by hand with sudo companion-update'; }
    else if (!managed) { inst.canUpdate = false; inst.why = managedWhy; }
    else if (!canAdmin) { inst.canUpdate = false; inst.why = adminWhy; }
    else inst.canUpdate = true;
    if (inst.available && !inst.canUpdate) inst.available = true;      // still worth showing
    installs.push(inst);
  }

  if (p.companion_present === '1') {
    await software('companion', 'controller', 'Companion', p.companion_build, p.companion_service, p.companion_port,
      p.companion_managed === '1', p.companion_legacy === '1', p.companion_cfg, 'companion',
      'Companion is here, but not installed with Companion Pi, so it cannot be updated from here', 8000);
  }
  if (p.satellite_present === '1') {
    await software('satellite', 'satellite', 'Satellite', p.satellite_build, p.satellite_service, p.satellite_port,
      p.satellite_managed === '1', false, p.satellite_cfg, 'satellite',
      'Satellite is here, but not installed as a Satellite Pi, so it cannot be updated from here', 9999);
  }

  parsed.docker.map(parseDocker).forEach((d) => {
    const isSat = /satellite/i.test(d.image);
    const tag = (d.image.split(':')[1] || '').replace(/@.*$/, '');
    const version = d.ver || (tag && tag !== 'latest' ? tag : '');
    let available = null;
    if (d.remote && d.digests.length) available = !d.digests.some((x) => x.endsWith(d.remote));
    const inst = {
      id: 'docker:' + d.cid.slice(0, 12), kind: isSat ? 'satellite' : 'controller', label: (isSat ? 'Satellite' : 'Companion') + ' (Docker)',
      docker: true, name: d.name, image: d.image, version, channel: V.channel(version), service: d.state || 'unknown',
      url: '', latest: available ? 'newer image' : '', available: available === true, unknown: available === null,
      note: available === null ? 'Run a check to compare with the published image' : '', cfg: '', cwd: d.cwd, svc: d.svc, canUpdate: false, why: ''
    };
    if (!d.cwd || !d.svc) inst.why = 'This container was not started with Docker Compose, so it cannot be recreated from here';
    else if (/\.ix-apps|\/ix-applications\//.test(d.cwd)) inst.why = 'This app is managed by TrueNAS. Update it from the Apps screen';
    else if (!canAdmin && p.docker_ok !== '1') inst.why = adminWhy;
    else inst.canUpdate = true;
    installs.push(inst);
  });

  return { sys, os, reboot, installs, dockerChecked: p.docker_ok === '1', feedNotes: Array.from(new Set(feedNotes)) };
}

/** One-line description of what is pending on a device, for the dashboard and the email. */
function pendingItems(status) {
  const out = [];
  if (!status) return out;
  (status.installs || []).forEach((i) => {
    if (i.available) out.push(i.label + (i.version && i.latest && !i.docker ? ' ' + V.short(i.version) + ' to ' + V.short(i.latest) : ': newer image published'));
  });
  if (status.os && status.os.count > 0) out.push('Operating system: ' + status.os.count + ' update' + (status.os.count === 1 ? '' : 's') + (status.os.security ? ' (' + status.os.security + ' security)' : ''));
  if (status.reboot && status.reboot.required) out.push('Reboot needed');
  return out;
}

module.exports = { parse, parseDocker, buildStatus, pendingItems, webUrl, Rel };
