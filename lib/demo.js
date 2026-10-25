/*
 * Demo mode (node server.js --demo): a handful of pretend devices so you can look
 * around, try the update buttons and see the log, without touching anything real.
 * It stands in for the SSH layer and the Bitfocus release feed.
 */
'use strict';

const zlib = require('zlib');

const T0 = Date.now();
const sim = {
  d1: { host: '10.0.20.10', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'x86_64', host_name: 'sanctuary-companion', companion: 'v4.2.1', apt: 7, sec: 2, reboot: 0, boot: 'b1' },
  d2: { host: '10.0.20.21', os: 'Raspberry Pi OS (Debian 12)', arch: 'aarch64', host_name: 'lobby-satellite', satellite: '2.2.0', apt: 0, sec: 0, reboot: 0, boot: 'b2' },
  d3: { host: '10.0.20.22', os: 'Raspberry Pi OS (Debian 12)', arch: 'aarch64', host_name: 'stage-satellite', satellite: '2.3.1', apt: 12, sec: 5, reboot: 1, boot: 'b3' },
  d4: { host: '10.0.20.30', os: 'Ubuntu 24.04.1 LTS', arch: 'x86_64', host_name: 'video-rack', docker: { cid: 'a1b2c3d4e5f6', name: 'companion', image: 'ghcr.io/bitfocus/companion/companion:latest', ver: 'v4.3.4', newer: true }, apt: 3, sec: 0, reboot: 0, boot: 'b4' },
  d5: { host: '10.0.20.40', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'aarch64', host_name: 'office-pi', apt: 0, sec: 0, reboot: 0, boot: 'b5' },
  d6: { host: '10.0.20.50', offline: true }
};
const byHost = {};
Object.keys(sim).forEach((k) => { byHost[sim[k].host] = sim[k]; sim[k].id = k; });

function devices() {
  const mk = (id, name, user) => ({ id, name, host: sim[id].host, port: 22, user, auth: 'key', password: '', sudoPassword: '' });
  return [mk('d1', 'Sanctuary Controller', 'root'), mk('d2', 'Lobby Satellite', 'satellite-admin'), mk('d3', 'Stage Satellite', 'satellite-admin'),
    mk('d4', 'Video Rack', 'avl'), mk('d5', 'Office Pi', 'pi'), mk('d6', 'Backup Controller', 'root')];
}

function tgz(name, text) {
  const body = Buffer.from(text), head = Buffer.alloc(512);
  head.write(name, 0); head.write('0000644\0', 100); head.write('0000000\0', 108); head.write('0000000\0', 116);
  head.write(body.length.toString(8).padStart(11, '0') + '\0', 124); head.write('00000000000\0', 136); head.write('        ', 148); head.write('0', 156);
  head.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of head) sum += b; head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([head, body, pad, Buffer.alloc(1024)]));
}

const jobs = new Map();       // id -> { lines: [{at, text}], rc, endAt, start }

function scriptOf(command) {
  const m = /printf %s ([A-Za-z0-9+/=]+) \|/.exec(command);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
}

function probeText(s) {
  const L = [];
  const kv = (k, v) => L.push(k + '=' + v);
  kv('lc_probe', 1); kv('user', 'root'); kv('uid', 0); kv('sudo', 1); kv('hostname', s.host_name); kv('arch', s.arch); kv('kernel', '6.1.0-demo');
  kv('boot_id', s.boot); kv('uptime', Math.floor((Date.now() - T0) / 1000) + 86400 * 12);
  kv('os', s.os); kv('os_id', 'debian'); kv('os_ver', '12');
  kv('reboot_required', s.reboot); if (s.reboot) { kv('reboot_why', 'file'); kv('reboot_pkgs', 'linux-image-rpi-v8,'); }
  kv('pkg_mgr', 'apt'); kv('apt_refreshed', 1); kv('apt_lists_age', 600);
  kv('apt_count', s.apt); kv('apt_security', s.sec); kv('apt_kept', 0);
  kv('apt_pkgs', ['openssl', 'libssl3', 'curl', 'libcurl4', 'tzdata', 'systemd', 'linux-image-rpi-v8', 'bash', 'sudo', 'git', 'ca-certificates', 'python3'].slice(0, Math.min(12, s.apt)).join(',') + (s.apt ? ',' : ''));
  if (s.companion) {
    kv('companion_present', 1); kv('companion_build', s.companion); kv('companion_managed', 1); kv('companion_service', 'active'); kv('companion_port', 8000);
    kv('companion_cfg', '/home/companion/.config/companion-nodejs');
  }
  if (s.satellite) {
    kv('satellite_present', 1); kv('satellite_build', s.satellite); kv('satellite_managed', 1); kv('satellite_service', 'active'); kv('satellite_port', 9999);
    kv('satellite_cfg', '/home/satellite/satellite-config.json');
  }
  if (s.docker) {
    kv('docker_ok', 1);
    const d = s.docker;
    kv('docker', [d.cid, d.name, d.image, 'running', '/srv/companion', 'companion', d.ver, 'ghcr.io/bitfocus/companion/companion@sha256:aaa', d.newer ? 'bbb' : 'aaa'].join('|'));
  }
  kv('lc_done', 1);
  return L.join('\n') + '\n';
}

function startJob(s, script, id) {
  const lines = [];
  let t = 400;
  const add = (text, gap = 700) => { t += gap; lines.push({ at: t, text }); };
  let apply = () => {};
  if (/companion-update/.test(script)) {
    add('Updating Companion to the newest stable build...'); add('Selected stable: v4.3.4', 900); add('Installing from https://s4.bitfocus.io/builds/companion/companion-linux-x64-v4.3.4.tar.gz', 600);
    add('Extracting...', 2200); add('Finishing', 1200); add('Update is complete', 800); add('companion-update finished.', 200);
    apply = () => { s.companion = 'v4.3.4'; };
  } else if (/satellite-update/.test(script)) {
    add('Updating Companion Satellite to the newest stable build...'); add('Selected stable: 2.3.1', 900); add('Extracting...', 1800); add('Finishing', 900); add('Update is complete', 600); add('satellite-update finished.', 200);
    apply = () => { s.satellite = '2.3.1'; };
  } else if (/apt-get/.test(script)) {
    add('Refreshing package lists...'); add('Hit:1 http://deb.debian.org/debian bookworm InRelease', 400); add('Get:2 http://security.debian.org/debian-security bookworm-security InRelease [48.0 kB]', 600);
    add('Installing updates...', 800); add('Reading package lists...', 500);
    for (let i = 1; i <= Math.min(6, s.apt); i++) add('Setting up package-' + i + ' (1.2.' + i + ') ...', 450);
    add('Package upgrade finished.', 300);
    apply = () => { if (s.apt > 3) s.reboot = 1; s.apt = 0; s.sec = 0; };
  } else if (/docker/.test(script)) {
    add('Pulling the newer image for companion...'); add('latest: Pulling from bitfocus/companion/companion', 600); add('Status: Downloaded newer image', 2200);
    add('Restarting the container...', 400); add('Container companion  Started', 1400); add('Docker update finished.', 300);
    apply = () => { s.docker.newer = false; };
  } else if (/reboot/.test(script)) {
    add('Rebooting in 3 seconds...', 100);
    setTimeout(() => { s.down = Date.now() + 7000; s.reboot = 0; s.boot = 'boot-' + Date.now(); }, 1500);
  }
  jobs.set(id, { lines, endAt: Date.now() + t + 300, apply, applied: false, start: Date.now() });
}

const ssh = {
  publicKey: () => 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOnlyForTheDemoMode livecompanion',
  ensureKey: async () => ssh.publicKey(),
  forgetHost: async () => {},
  async run(c, command, opts = {}) {
    await new Promise((r) => setTimeout(r, 120));
    const s = byHost[c.host];
    if (!s || s.offline) return { code: 255, stdout: '', stderr: 'ssh: connect to host ' + c.host + ' port 22: No route to host', timedOut: false, err: { kind: 'unreachable', message: 'The device did not answer. It may be off, rebooting or on another network.' } };
    if (s.down && Date.now() < s.down) return { code: 255, stdout: '', stderr: 'Connection refused', timedOut: false, err: { kind: 'refused', message: 'Nothing is answering on the SSH port.' } };
    const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false });
    if (/cat \/proc\/sys\/kernel\/random\/boot_id/.test(command) && !/base64/.test(command)) return ok(s.boot + '\n');
    if (/LC_SIZE=/.test(command)) {
      const jb = Array.from(jobs.entries()).find(([k]) => command.includes(k));
      const off = Number((/o=(\d+);/.exec(command) || [])[1] || 0);
      if (!jb) return ok('LC_SIZE=0\nLC_NEXT=0\nLC_RC=\nLC_DATA\n');
      const j = jb[1];
      const el = Date.now() - j.start;
      const shown = j.lines.filter((l) => l.at <= el);
      const text = shown.map((l) => l.text).join('\n') + (shown.length ? '\n' : '');
      const done = Date.now() >= j.endAt;
      if (done && !j.applied) { j.applied = true; j.apply(); }
      const buf = Buffer.from(text);
      return ok('LC_SIZE=' + buf.length + '\nLC_NEXT=' + buf.length + '\nLC_RC=' + (done ? '0' : '') + '\nLC_DATA\n' + buf.subarray(off).toString());
    }
    if (/LC_STARTED/.test(command)) {
      const jid = (/"\$d\/(j[0-9a-f]+)\.sh"/.exec(command) || [])[1] || ('j' + jobs.size);
      startJob(s, scriptOf(command), jid);
      return ok('LC_STARTED\n');
    }
    if (/rm -f "\$d\//.test(command) && /echo ok/.test(command)) return ok('ok\n');
    const script = scriptOf(command);
    if (/kv lc_probe/.test(script)) return ok(probeText(s));
    if (/tar -czf -/.test(script)) {
      const file = s.companion ? 'companion-nodejs/db' : 'satellite-config.json';
      const data = tgz(file, 'demo configuration for ' + s.host_name + '\n'.repeat(3));
      if (opts.stdoutTo) { opts.stdoutTo.end(data); return { code: 0, stdout: '', stderr: '', timedOut: false }; }
      return ok(data.toString('latin1'));
    }
    return ok('');
  }
};

const releases = {
  async get(product) {
    return { ok: true, latest: product === 'satellite' ? { version: '2.3.1', uri: '' } : { version: 'v4.3.4', uri: '' } };
  },
  clear() {}
};

module.exports = { ssh, releases, devices };
