'use strict';
/* node test/run.js  -  no test framework needed */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const V = R('lib/version'), Secrets = R('lib/secrets'), Rel = R('lib/releases'), Scripts = R('lib/scripts'), Probe = R('lib/probe'), Mail = R('lib/mail'), Disc = R('discover'), Ssh = R('lib/ssh');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-' + p + '-'));

// ---------- a fake device ----------
function fakeDevice(opts = {}) {
  const t = tmp('dev'), bin = path.join(t, 'stubs'), w = (f, c, mode) => { const p = path.join(t, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, { mode }); };
  w('etc/os-release', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n');
  w('etc/hostname', 'fake-pi\n');
  if (opts.companion !== false) {
    w('opt/companion/BUILD', (opts.companionBuild || 'v4.2.1') + '\n');
    fs.mkdirSync(path.join(t, 'usr/local/src/companionpi'), { recursive: true });
    w('etc/companion/config.yaml', 'adminPort: 8001\n');
    w('home/companion/.config/companion-nodejs/db', 'settings');
  }
  if (opts.satellite) {
    w('opt/companion-satellite/BUILD', 'v2.2.0\n');
    fs.mkdirSync(path.join(t, 'usr/local/src/companion-satellite'), { recursive: true });
  }
  if (opts.reboot) { w('var/run/reboot-required', ''); w('var/run/reboot-required.pkgs', 'linux-image\n'); }
  const stub = (n, body) => w('stubs/' + n, '#!/bin/sh\n' + body + '\n', 0o755);
  stub('apt-get', `case "$*" in *" -s "*|"-s "*) cat <<'X'
Inst openssl [3.0.1] (3.0.2 Debian-Security:12/stable-security [arm64])
Inst curl [7.1] (7.2 Debian:12/stable [arm64])
2 not upgraded.
X
;; *) echo "apt-get $*";; esac`);
  stub('systemctl', 'case "$1" in is-active) echo active;; *) echo "systemctl $*";; esac');
  stub('docker', 'exit 1');
  // CI runs as a normal user with real sudo, which ignores PATH: run the command directly instead
  stub('sudo', 'while [ $# -gt 0 ]; do case "$1" in -n|-S) shift;; -p) shift 2;; *) break;; esac; done; exec "$@"');
  stub('companion-update', `echo "fake companion-update $*"; echo v4.3.4 > "${t}/opt/companion/BUILD"`);
  stub('satellite-update', `echo "fake satellite-update $*"; echo v2.3.1 > "${t}/opt/companion-satellite/BUILD"`);
  return { root: t, bin, env: { LC_ROOT: t, PATH: bin + ':' + process.env.PATH } };
}
function sh(dev, script, input) {
  const r = spawnSync('sh', ['-c', script], { env: { ...process.env, ...dev.env }, input: input || '', encoding: 'utf8', timeout: 20000 });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

// ---------- tests ----------
test('version: compare and channel', () => {
  assert.strictEqual(V.compare('v4.2.1', 'v4.3.4'), -1);
  assert.strictEqual(V.compare('4.3.4', 'v4.3.4'), 0);
  assert.strictEqual(V.compare('v4.10.0', 'v4.9.9'), 1);
  assert.strictEqual(V.compare('5.0.0+9502-main-2026', 'v4.3.4'), 1);
  assert.strictEqual(V.compare('junk', 'v1.0.0'), null);
  assert.strictEqual(V.channel('v4.3.4'), 'stable');
  assert.strictEqual(V.channel('5.0.0+9502-main'), 'beta');
  assert.strictEqual(V.channel('v1.0.0-rc.1'), 'beta');
  assert.strictEqual(V.channel('x'), 'unknown');
  assert.strictEqual(V.short('5.0.0+95'), '5.0.0');
});

test('secrets: round trip and tamper', () => {
  const f = path.join(tmp('sec'), 'key'), s = Secrets.create(f);
  const e = s.enc('hunter2');
  assert.ok(e.startsWith('enc1:') && !e.includes('hunter2'));
  assert.strictEqual(s.dec(e), 'hunter2');
  assert.strictEqual(Secrets.create(f).dec(e), 'hunter2');
  assert.notStrictEqual(s.dec(e.slice(0, -2) + 'AA'), 'hunter2');
});

test('releases: targets, stable feed, cache', async () => {
  assert.strictEqual(Rel.targetFor('x86_64'), 'linux-tgz');
  assert.strictEqual(Rel.targetFor('aarch64'), 'linux-arm64-tgz');
  assert.strictEqual(Rel.targetFor('armv7l'), null);
  let urls = [];
  const getter = async (u) => { urls.push(u); return { packages: [{ target: 'linux-tgz', version: 'v4.3.4', uri: 'http://x' }] }; };
  const l = await Rel.latestStable('companion', 'linux-tgz', getter);
  assert.strictEqual(l.version, 'v4.3.4');
  assert.ok(/companion\/packages\?branch=stable&limit=1&target=linux-tgz/.test(urls[0]));
  await Rel.latestStable('satellite', 'linux-tgz', getter);
  assert.ok(/companion-satellite\/packages/.test(urls[1]));
  const c = Rel.cache(getter, 60000);
  urls = []; await c.get('companion', 'linux-tgz'); await c.get('companion', 'linux-tgz');
  assert.strictEqual(urls.length, 1);
  const bad = Rel.cache(async () => { throw new Error('offline'); });
  const r = await bad.get('companion', 'linux-tgz');
  assert.strictEqual(r.ok, false);
});

test('scripts: every script is valid sh, command() round trips', () => {
  const all = [Scripts.probe(), Scripts.companionUpdate(), Scripts.satelliteUpdate(), Scripts.osUpdate(), Scripts.dockerUpdate({ cwd: "/srv/it's", svc: 'companion' }),
    Scripts.reboot(), Scripts.backupCompanion({ cfg: '/home/companion/.config/companion-nodejs' }), Scripts.backupFile({ file: '/home/satellite/satellite-config.json' }), Scripts.installKey({ pub: 'ssh-ed25519 AAAA lc' })];
  all.forEach((s, i) => { const r = spawnSync('sh', ['-n'], { input: s, encoding: 'utf8' }); assert.strictEqual(r.status, 0, 'script ' + i + ': ' + r.stderr); });
  const r = sh({ env: {} }, Scripts.command('echo "hello $((1+2))"'));
  assert.strictEqual(r.out.trim(), 'hello 3');
  const p = sh({ env: {} }, Scripts.command('echo "[$LC_PWV]"', { pw: true }), 'secret\n');
  assert.strictEqual(p.out.trim(), '[secret]');
  assert.strictEqual(Scripts.shq("a'b"), "'a'\\''b'");
});

test('probe.sh on a fake Companion Pi, parsed into a status', async () => {
  const dev = fakeDevice({ satellite: true, reboot: true });
  const r = sh(dev, Scripts.command(Scripts.probe()));
  assert.ok(/lc_done=1/.test(r.out), r.out + r.err);
  const parsed = Probe.parse(r.out);
  const m = parsed.map;
  assert.strictEqual(m.companion_build, 'v4.2.1');
  assert.strictEqual(m.companion_managed, '1');
  assert.strictEqual(m.companion_port, '8001');
  assert.strictEqual(m.satellite_build, 'v2.2.0');
  assert.strictEqual(m.apt_count, '2');
  assert.strictEqual(m.apt_security, '1');
  assert.strictEqual(m.reboot_required, '1');
  const feed = async (product) => ({ ok: true, latest: { version: product === 'companion' ? 'v4.3.4' : 'v2.3.1' } });
  const st = await Probe.buildStatus({ host: '10.0.0.1', user: 'root' }, parsed, feed);
  const c = st.installs.find((i) => i.kind === 'controller'), s = st.installs.find((i) => i.kind === 'satellite');
  assert.ok(c.available && c.canUpdate && c.latest === 'v4.3.4');
  assert.ok(s.available);
  assert.strictEqual(st.os.count, 2);
  assert.ok(st.reboot.required);
  assert.strictEqual(Probe.pendingItems(st).length, 4);
  const current = await Probe.buildStatus({ host: 'h', user: 'root' }, parsed, async () => ({ ok: true, latest: { version: 'v4.2.1' } }));
  assert.ok(!current.installs[0].available);
});

test('probe: no Bitfocus software, not root without sudo, beta build', async () => {
  const dev = fakeDevice({ companion: false });
  const parsed = Probe.parse(sh(dev, Scripts.command(Scripts.probe())).out);
  const st = await Probe.buildStatus({ host: 'h', user: 'root' }, parsed, async () => ({ ok: true, latest: null }));
  assert.strictEqual(st.installs.length, 0);
  const p2 = Probe.parse('uid=1000\nsudo=0\npkg_mgr=apt\napt_count=3\ncompanion_present=1\ncompanion_build=5.0.0+9502-main\ncompanion_managed=1\nlc_done=1\n');
  const s2 = await Probe.buildStatus({ host: 'h', user: 'pi' }, p2, async () => ({ ok: true, latest: { version: 'v4.3.4' } }));
  assert.ok(!s2.installs[0].canUpdate && /root or sudo/.test(s2.installs[0].why));
  assert.ok(!s2.installs[0].available, 'beta newer than stable is not an update');
  assert.ok(!s2.os.canUpdate);
});

test('probe: docker line parsing and TrueNAS refusal', async () => {
  const line = 'abc123def4567890|companion|ghcr.io/bitfocus/companion:latest|running|/srv/c|companion|4.3.4|ghcr.io/bitfocus/companion@sha256:aaa|bbb';
  const p = Probe.parse('uid=0\ndocker_ok=1\ndocker=' + line + '\ndocker=' + line.replace('/srv/c', '/mnt/.ix-apps/app_configs/x') + '\n');
  const st = await Probe.buildStatus({ host: 'h', user: 'root' }, p, async () => ({ ok: true, latest: null }));
  assert.strictEqual(st.installs.length, 2);
  assert.ok(st.installs[0].available && st.installs[0].canUpdate);
  assert.ok(!st.installs[1].canUpdate && /TrueNAS/.test(st.installs[1].why));
});

test('update scripts run on a fake device and the jobs can be polled', () => {
  const dev = fakeDevice({ satellite: true });
  const id = 'job1';
  const started = sh(dev, Scripts.launch(id, Scripts.companionUpdate()));
  assert.ok(/LC_STARTED/.test(started.out), started.err);
  let res = '';
  for (let i = 0; i < 40; i++) {
    res = sh(dev, Scripts.poll(id, 0)).out;
    if (/LC_RC=\d/.test(res)) break;
    spawnSync('sleep', ['0.25']);
  }
  assert.ok(/LC_RC=0/.test(res), res);
  assert.ok(/fake companion-update stable/.test(res));
  assert.strictEqual(fs.readFileSync(path.join(dev.root, 'opt/companion/BUILD'), 'utf8').trim(), 'v4.3.4');
  const next = /LC_NEXT=(\d+)/.exec(res)[1];
  assert.ok(!/fake companion/.test(sh(dev, Scripts.poll(id, +next)).out.split('LC_DATA')[1]));
  assert.ok(/ok/.test(sh(dev, Scripts.cleanup(id)).out));
  assert.ok(!fs.existsSync(path.join(dev.root, 'tmp/livecompanion', id + '.log')));
  const o = sh(dev, Scripts.osUpdate());
  assert.strictEqual(o.code, 0, o.err);
  assert.ok(/apt-get .*upgrade/.test(o.out));
});

test('failed update script reports a non zero exit', () => {
  const dev = fakeDevice();
  fs.writeFileSync(path.join(dev.bin, 'companion-update'), '#!/bin/sh\necho boom; exit 3\n', { mode: 0o755 });
  sh(dev, Scripts.launch('j2', Scripts.companionUpdate()));
  let res = '';
  for (let i = 0; i < 40; i++) { res = sh(dev, Scripts.poll('j2', 0)).out; if (/LC_RC=\d/.test(res)) break; spawnSync('sleep', ['0.25']); }
  assert.ok(/LC_RC=3/.test(res), res);
});

test('backup scripts stream a valid tgz', () => {
  const dev = fakeDevice();
  const cfg = path.join(dev.root, 'home/companion/.config/companion-nodejs');
  const r = spawnSync('sh', ['-c', Scripts.command(Scripts.backupCompanion({ cfg }))], { env: { ...process.env, ...dev.env }, maxBuffer: 1e7 });
  assert.strictEqual(r.status, 0, String(r.stderr));
  const out = tmp('bk'), f = path.join(out, 'b.tgz');
  fs.writeFileSync(f, r.stdout);
  assert.strictEqual(spawnSync('tar', ['xzf', f, '-C', out]).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(out, 'companion-nodejs/db'), 'utf8'), 'settings');
});

test('ssh: error explanations', () => {
  assert.strictEqual(Ssh.explain('Permission denied (publickey).').kind, 'auth');
  assert.strictEqual(Ssh.explain('ssh: connect to host x port 22: Connection refused').kind, 'refused');
  assert.strictEqual(Ssh.explain('Host key verification failed.').kind, 'hostkey');
  assert.strictEqual(Ssh.explain('ssh: Could not resolve hostname nope').kind, 'dns');
  assert.strictEqual(Ssh.explain('ssh: connect to host x port 22: Operation timed out').kind, 'unreachable');
});

test('mail: message encoding and a send to a fake SMTP server', async () => {
  const m = Mail.buildMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'Updates é', text: 'Body line' });
  assert.ok(/^Subject: =\?UTF-8\?B\?/m.test(m));
  const got = { cmds: [], data: '' };
  const srv = net.createServer((s) => {
    let inData = false, buf = '';
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else got.data += line + '\n'; continue; }
        got.cmds.push(line);
        if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(line)) s.write('235 ok\r\n');
        else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await Mail.send({ host: '127.0.0.1', port: srv.address().port, secure: 'none', user: 'u', pass: 'p', from: 'a@b.c', to: 'x@y.z, q@y.z' }, { subject: 'Hi', text: 'Hello body' });
  srv.close();
  assert.ok(got.cmds.some((c) => /RCPT TO:<x@y.z>/i.test(c)) && got.cmds.some((c) => /RCPT TO:<q@y.z>/i.test(c)), got.cmds.join('|'));
  await assert.rejects(Mail.send({ host: '', from: 'a', to: 'b' }, { subject: 's', text: 't' }));
});

test('discover: ranges', () => {
  assert.deepStrictEqual(Disc.parseRange('192.168.1.0/30').hosts, ['192.168.1.1', '192.168.1.2']);
  assert.strictEqual(Disc.parseRange('10.0.0.5-10.0.0.7').hosts.length, 3);
  assert.ok(Disc.parseRange('8.8.8.0/24').error);
  assert.ok(Disc.parseRange('nonsense').error);
  assert.ok(Disc.isPrivate('192.168.4.4') && !Disc.isPrivate('1.1.1.1'));
});

test('engine: check, backup, update and verify on a fake Pi (real scripts, fake ssh)', async () => {
  const { createEngine } = R('lib/engine');
  const dev = fakeDevice({ satellite: true });
  const dataDir = tmp('eng');
  const fakeSsh = {
    run(c, command, opts = {}) {
      return new Promise((resolve) => {
        command = command.replace(/printf %s ([A-Za-z0-9+\/=]{20,})/, (m, b) => { const t = Buffer.from(b, 'base64').toString('utf8'); return 'printf %s ' + Buffer.from(/tar -czf/.test(t) ? t.split("='/home/companion/").join("='" + dev.root + '/home/companion/') : t).toString('base64'); });
        const ch = spawn('sh', ['-c', command], { env: { ...process.env, ...dev.env } });
        const out = []; let err = '';
        if (opts.stdoutTo) ch.stdout.pipe(opts.stdoutTo); else ch.stdout.on('data', (d) => out.push(d));
        ch.stderr.on('data', (d) => { err += d; });
        ch.stdin.on('error', () => {});
        ch.stdin.end(opts.input || '');
        ch.on('close', (code) => resolve({ code, stdout: opts.stdoutTo ? '' : Buffer.concat(out).toString(), stderr: err, timedOut: false, err: code ? { kind: 'other', message: err.trim() } : undefined }));
      });
    }
  };
  const secrets = Secrets.create(path.join(dataDir, 'secret.key'));
  const cfg = { devices: [{ id: 'd1', name: 'Fake Pi', host: 'fake', port: 22, user: 'root', auth: 'key', password: '', sudoPassword: '' }], refreshLists: false, backup: { enabled: true, keep: 2 } };
  const state = {};
  const feeds = { companion: 'v4.3.4', satellite: 'v2.3.1' };
  const releases = { get: async (product) => ({ ok: true, latest: { version: feeds[product] } }) };
  const eng = createEngine({ ssh: fakeSsh, secrets, getCfg: () => cfg, state, save() {}, dataDir, releases, pollMs: 50, rebootPollMs: 50, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });

  let st = await eng.checkDevice('d1');
  assert.ok(st.reachable, JSON.stringify(st.error));
  assert.ok(eng.pending()[0].items.length >= 3);
  assert.ok(st.installs.every((i) => i.available && i.canUpdate));
  // refused: nothing selected
  assert.ok(!eng.startJobs([{ id: 'd1', steps: [] }]).ok);
  const r = eng.startJobs([{ id: 'd1', steps: ['companion', 'satellite', 'os'] }]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!eng.startJobs([{ id: 'd1', steps: ['os'] }]).ok, 'second job on a busy device is refused');
  let job;
  for (let i = 0; i < 200; i++) { job = eng.getJob(r.jobs[0]); if (job.status === 'done' || job.status === 'failed') break; await new Promise((x) => setTimeout(x, 100)); }
  assert.strictEqual(job.status, 'done', job.log);
  assert.ok(/Backup saved/.test(job.log), job.log);
  const bk = eng.listBackups('d1');
  assert.ok(bk.length >= 1 && /companion-v4\.2\.1\.tgz$/.test(bk.map((b) => b.file).find((f) => /companion-v/.test(f))), JSON.stringify(bk));
  assert.ok(eng.backupPath('d1', bk[0].file));
  assert.strictEqual(eng.backupPath('d1', '../../etc/passwd'), null);
  while (eng.isChecking('d1') || eng.isBusy('d1')) await new Promise((x) => setTimeout(x, 50));
  st = await eng.checkDevice('d1', { force: true });
  assert.strictEqual(st.installs.find((i) => i.id === 'companion').version, 'v4.3.4');
  assert.ok(!st.installs.find((i) => i.id === 'companion').available);
  // a failing updater must fail the step, skip the rest and keep the backup
  fs.writeFileSync(path.join(dev.bin, 'companion-update'), '#!/bin/sh\necho nope; exit 5\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dev.root, 'opt/companion/BUILD'), 'v4.2.1\n');
  feeds.companion = 'v4.4.0';
  while (eng.isChecking('d1')) await new Promise((x) => setTimeout(x, 50));
  await eng.checkDevice('d1', { force: true });
  const r2 = eng.startJobs([{ id: 'd1', steps: ['companion', 'os'] }]);
  for (let i = 0; i < 200; i++) { job = eng.getJob(r2.jobs[0]); if (job.status === 'done' || job.status === 'failed') break; await new Promise((x) => setTimeout(x, 100)); }
  assert.strictEqual(job.status, 'failed');
  assert.ok(/exit 5/.test(job.summary) && job.steps[1].status === 'skipped', JSON.stringify(job.steps));
});

test('HTTP API in demo mode: state, check, update job, settings, PIN', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000), dir = tmp('api');
  const child = spawn(process.execPath, [path.join(root, 'server.js'), '--demo'], { env: { ...process.env, PORT: String(port), CONFIG: path.join(dir, 'config.json'), LIVECOMPANION_NO_UPDATE_CHECK: '1' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  const get = (p) => fetch(base + p).then((r) => r.json());
  const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(h || {}) }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    let s;
    for (let i = 0; i < 50; i++) { try { s = await get('/api/state'); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
    assert.ok(s && s.demo && s.devices.length >= 5);
    const html = await fetch(base + '/').then((r) => r.text());
    assert.ok(/LiveCompanion/.test(html));
    // wait for the first demo check to land
    for (let i = 0; i < 40 && !s.devices.some((d) => d.status); i++) { await new Promise((r) => setTimeout(r, 200)); s = await get('/api/state'); }
    const dev = s.devices.find((d) => d.status && d.status.reachable && d.status.installs.some((x) => x.available && x.canUpdate));
    assert.ok(dev, 'a device with an update');
    const inst = dev.status.installs.find((x) => x.available && x.canUpdate);
    const up = await post('/api/update', { items: [{ id: dev.id, steps: [inst.id] }] });
    assert.ok(up.j.ok, JSON.stringify(up.j));
    let job;
    for (let i = 0; i < 100; i++) { s = await get('/api/state'); job = s.jobs.find((j) => j.deviceId === dev.id); if (job && (job.status === 'done' || job.status === 'failed')) break; await new Promise((r) => setTimeout(r, 300)); }
    assert.ok(job && job.status === 'done', JSON.stringify(job));
    const log = await get('/api/job?id=' + job.id);
    assert.ok(log.log && log.log.length > 5);
    const bad = await post('/api/update', { items: [{ id: 'nope', steps: ['os'] }] });
    assert.ok(!bad.j.ok);
    const st = await post('/api/settings', { schedule: { enabled: true, time: '04:30' }, backup: { keep: 3 } });
    assert.ok(st.j.ok);
    s = await get('/api/state');
    assert.strictEqual(s.settings.schedule.time, '04:30'); assert.strictEqual(s.settings.backup.keep, 3);
    // PIN
    assert.ok((await post('/api/settings', { newPin: '1234' })).j.ok);
    assert.strictEqual((await post('/api/check', {})).status, 401);
    assert.ok((await post('/api/check', {}, { 'x-pin': '1234' })).j.ok);
    s = await get('/api/state');
    assert.strictEqual(s.pinRequired, true);
    assert.ok(JSON.stringify(s).indexOf('1234') < 0);
  } finally { child.kill(); }
});

// ---------- run ----------
(async () => {
  let fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e) { fail++; console.log('  FAIL ' + t.name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log(fail ? '\n' + fail + ' of ' + tests.length + ' failed' : '\nall ' + tests.length + ' passed');
  process.exit(fail ? 1 : 0);
})();
