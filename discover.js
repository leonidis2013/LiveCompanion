/*
 * Network search for devices that can be managed over SSH.
 *
 * Tries SSH (port 22) on every address in a private range, reads the SSH banner,
 * and peeks at the Companion web interface (8000) and the Satellite REST port
 * (9999) so likely Bitfocus devices are listed first. No logins are attempted.
 * No dependencies.
 */
'use strict';

const net = require('net');
const http = require('http');
const os = require('os');
const dns = require('dns');

const MAX_HOSTS = 1024;                 // a /22

const ipToInt = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);

/** Private, link-local or loopback: the only places a scan may point. */
function isPrivate(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** "192.168.1.0/24", "192.168.1.50" or "192.168.1.10-192.168.1.40" -> { hosts, label } */
function parseRange(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { error: 'Enter an address range, for example 192.168.1.0/24' };
  let lo, hi, label, m;
  if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/))) {
    if (!isIPv4(m[1])) return { error: 'That is not a valid address' };
    const bits = Number(m[2]);
    if (bits < 22 || bits > 32) return { error: 'Use a range of /22 (1,024 addresses) or smaller, for example /24' };
    const size = 2 ** (32 - bits);
    const base = Math.floor(ipToInt(m[1]) / size) * size;
    lo = base; hi = base + size - 1;
    if (bits <= 30) { lo += 1; hi -= 1; }
    label = intToIp(base) + '/' + bits;
  } else if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/))) {
    if (!isIPv4(m[1]) || !isIPv4(m[2])) return { error: 'That is not a valid address' };
    lo = ipToInt(m[1]); hi = ipToInt(m[2]); label = m[1] + '-' + m[2];
  } else if (isIPv4(s)) {
    lo = hi = ipToInt(s); label = s;
  } else {
    return { error: 'Use a range like 192.168.1.0/24' };
  }
  if (hi < lo) return { error: 'The range ends before it starts' };
  if (hi - lo + 1 > MAX_HOSTS) return { error: 'That range is too large (at most 1,024 addresses)' };
  if (!isPrivate(intToIp(lo)) || !isPrivate(intToIp(hi))) return { error: 'Only private network addresses can be searched (10.x, 172.16-31.x, 192.168.x)' };
  const hosts = [];
  for (let n = lo; n <= hi; n++) hosts.push(intToIp(n));
  return { hosts, label };
}

const cidr24 = (ip) => ip.split('.').slice(0, 3).join('.') + '.0/24';

function suggestRanges({ clientIp, includeInterfaces = true } = {}) {
  const out = [];
  const add = (r) => { if (r && !out.includes(r)) out.push(r); };
  const c = String(clientIp || '').replace(/^::ffff:/, '');
  if (isIPv4(c) && isPrivate(c) && !c.startsWith('127.')) add(cidr24(c));
  if (includeInterfaces) {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((name) => ifs[name].forEach((i) => {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address)) add(cidr24(i.address));
    }));
  }
  return out;
}

/** Is something listening on host:port? */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

/** Read the SSH greeting ("SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3"). */
function banner(host, port, waitMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let buf = '', done = false;
    const end = () => { if (!done) { done = true; clearTimeout(t); s.destroy(); resolve(/^SSH-/.test(buf) ? buf.split(/\r?\n/)[0].slice(0, 120) : ''); } };
    const t = setTimeout(end, waitMs);
    s.setEncoding('ascii');
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) end(); });
    s.on('error', end); s.on('close', end);
  });
}

function httpGet(host, port, path, waitMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: waitMs, headers: { 'user-agent': 'LiveCompanion' } }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; if (raw.length > 6000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      res.on('close', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const reverse = (ip) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(''), 800);
  dns.reverse(ip, (err, names) => { clearTimeout(t); resolve(!err && names && names[0] ? names[0].replace(/\.$/, '') : ''); });
});

/** What kind of device is this likely to be? */
async function describe(host, { port = 22, ports = {}, answerMs = 1200 } = {}) {
  const b = await banner(host, port, answerMs);
  const info = { host, port, banner: b, hint: '', name: '', system: '' };
  if (/Debian|Raspbian/i.test(b)) info.system = /Raspbian/i.test(b) ? 'Raspberry Pi OS' : 'Debian';
  else if (/Ubuntu/i.test(b)) info.system = 'Ubuntu';
  else if (/OpenSSH/i.test(b)) info.system = 'Linux / OpenSSH';
  const [adm, sat, nm] = await Promise.all([
    probe(host, ports.admin || 8000, 400).then((ok) => ok ? httpGet(host, ports.admin || 8000, '/', answerMs) : null),
    probe(host, ports.satellite || 9999, 400).then((ok) => ok ? httpGet(host, ports.satellite || 9999, '/api/status', answerMs) : null),
    reverse(host)
  ]);
  info.name = nm;
  if (sat && sat.status === 200 && /"connected"\s*:/.test(sat.body)) info.hint = 'Companion Satellite';
  else if (adm && /companion/i.test(adm.body)) info.hint = 'Companion';
  return info;
}

/** state is updated as it goes so a page can poll it: { running, total, done, found: [...] } */
async function scan(hosts, state, { port = 22, ports = {}, concurrency = 64, connectMs = 700, answerMs = 1200 } = {}) {
  state.running = true; state.total = hosts.length; state.done = 0; state.found = [];
  let next = 0;
  async function worker() {
    while (next < hosts.length && state.running) {
      const host = hosts[next++];
      try {
        if (await probe(host, port, connectMs)) {
          const d = await describe(host, { port, ports, answerMs });
          if (d.banner) state.found.push(d);
        }
      } catch (e) { /* skip this address */ }
      state.done++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  state.found.sort((a, b) => (b.hint ? 1 : 0) - (a.hint ? 1 : 0) || ipToInt(a.host) - ipToInt(b.host));
  state.running = false;
  return state;
}

module.exports = { parseRange, suggestRanges, probe, banner, describe, scan, isPrivate, isIPv4, MAX_HOSTS };
