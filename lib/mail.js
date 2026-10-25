/*
 * A small SMTP client (no packages): plain, STARTTLS or TLS, with AUTH PLAIN / LOGIN.
 * Used only to send the "updates are available" summary and the test message.
 */
'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

class Reader {
  constructor(sock) {
    this.sock = sock; this.buf = ''; this.queue = []; this.waiting = null; this.closed = false; this.error = null;
    sock.setEncoding('utf8');
    sock.on('data', (d) => { this.buf += d; this.pump(); });
    sock.on('error', (e) => { this.error = e; this.closed = true; this.pump(); });
    sock.on('close', () => { this.closed = true; this.pump(); });
  }
  pump() {
    for (;;) {
      const lines = this.buf.split('\r\n');
      if (lines.length < 2) break;
      // a reply ends at the first line that is "NNN text" (no dash after the code)
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { end = i; break; }
      if (end < 0) break;
      const reply = lines.slice(0, end + 1);
      this.buf = lines.slice(end + 1).join('\r\n');
      this.queue.push({ code: Number(reply[end].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
    }
    if (this.waiting && (this.queue.length || this.closed)) {
      const w = this.waiting; this.waiting = null;
      if (this.queue.length) w.resolve(this.queue.shift());
      else w.reject(this.error || new Error('The mail server closed the connection'));
    }
  }
  read(ms = 15000) {
    return new Promise((resolve, reject) => {
      if (this.queue.length) return resolve(this.queue.shift());
      if (this.closed) return reject(this.error || new Error('The mail server closed the connection'));
      const t = setTimeout(() => { this.waiting = null; reject(new Error('The mail server did not answer in time')); }, ms);
      this.waiting = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
    });
  }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

function buildMessage({ from, to, subject, text, date = new Date(), host = 'livecompanion' }) {
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'Date: ' + date.toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(8).toString('hex') + '@' + host + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ];
  return headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(text)) + '\r\n';
}

/**
 * conf: { host, port, secure: 'tls'|'starttls'|'none', user, pass, from, to, allowSelfSigned }
 * Resolves on success, rejects with an Error whose message is fit to show.
 */
async function send(conf, { subject, text }) {
  if (!conf.host) throw new Error('No mail server set');
  if (!conf.from) throw new Error('No From address set');
  const rcpts = String(conf.to || '').split(/[,;\s]+/).filter(Boolean);
  if (!rcpts.length) throw new Error('No To address set');
  const port = Number(conf.port) || (conf.secure === 'tls' ? 465 : 587);
  const tlsOpts = { host: conf.host, servername: conf.host, rejectUnauthorized: !conf.allowSelfSigned };

  const open = () => new Promise((resolve, reject) => {
    const s = conf.secure === 'tls' ? tls.connect(Object.assign({ port }, tlsOpts)) : net.createConnection({ host: conf.host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('Could not connect to ' + conf.host + ':' + port)); }, 10000);
    s.once(conf.secure === 'tls' ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(new Error('Could not connect to ' + conf.host + ':' + port + ' (' + (e.code || e.message) + ')')); });
  });

  let sock = await open();
  let rd = new Reader(sock);
  const say = async (line, ok) => {
    sock.write(line + '\r\n');
    const r = await rd.read();
    if (ok && ![].concat(ok).includes(r.code)) throw new Error('Mail server said: ' + r.code + ' ' + (r.lines[r.lines.length - 1] || ''));
    return r;
  };
  try {
    let r = await rd.read();
    if (r.code !== 220) throw new Error('Mail server said: ' + r.code + ' ' + r.lines[0]);
    let ehlo = await say('EHLO livecompanion', 250);
    if (conf.secure === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new Error('That mail server does not offer STARTTLS');
      await say('STARTTLS', 220);
      sock = tls.connect({ socket: sock, servername: conf.host, rejectUnauthorized: !conf.allowSelfSigned });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', (e) => rej(new Error('TLS failed: ' + (e.code || e.message)))); });
      rd = new Reader(sock);
      ehlo = await say('EHLO livecompanion', 250);
    }
    if (conf.user) {
      const mech = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '';
      if (/PLAIN/i.test(mech) || !mech) {
        await say('AUTH PLAIN ' + b64('\0' + conf.user + '\0' + (conf.pass || '')), 235);
      } else if (/LOGIN/i.test(mech)) {
        await say('AUTH LOGIN', 334);
        await say(b64(conf.user), 334);
        await say(b64(conf.pass || ''), 235);
      } else throw new Error('The mail server offers no login method LiveCompanion can use');
    }
    const bare = (a) => { const m = /<([^>]+)>/.exec(a); return (m ? m[1] : a).trim(); };
    await say('MAIL FROM:<' + bare(conf.from) + '>', 250);
    for (const a of rcpts) await say('RCPT TO:<' + bare(a) + '>', [250, 251]);
    await say('DATA', 354);
    const msg = buildMessage({ from: conf.from, to: rcpts.join(', '), subject, text }).replace(/^\./gm, '..');
    await say(msg + '.', 250);
    try { sock.write('QUIT\r\n'); } catch (e) { /* done anyway */ }
  } finally {
    setTimeout(() => sock.destroy(), 200).unref();
  }
}

module.exports = { send, buildMessage };
