/*
 * Runs commands on a device with the system's OpenSSH client (the Docker image
 * installs it). No SSH library is needed.
 *
 *  - Key logins use LiveCompanion's own key (created on first start).
 *  - Password logins hand the password to ssh through SSH_ASKPASS, never on the
 *    command line.
 *  - Host keys are remembered on first contact and must match afterwards.
 */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SSH_BIN = process.env.LC_SSH_BIN || 'ssh';
const KEYGEN_BIN = process.env.LC_SSH_KEYGEN_BIN || 'ssh-keygen';

/** Turn ssh's error text into something a person can act on. */
function explain(stderr, code) {
  const s = String(stderr || '');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) {
    return { kind: 'hostkey', message: "The device's SSH host key changed since it was first seen. If you reinstalled it, trust the new key in Settings > Devices." };
  }
  if (/Permission denied|Too many authentication failures|authentication failed/i.test(s)) {
    return { kind: 'auth', message: 'The device refused the login. Check the user name and the password or key.' };
  }
  if (/Connection refused/i.test(s)) return { kind: 'refused', message: 'Nothing is answering on the SSH port. Is SSH turned on?' };
  if (/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(s)) {
    return { kind: 'dns', message: 'That address could not be resolved.' };
  }
  if (/timed out|No route to host|Network is unreachable|Connection closed by|Connection reset|kex_exchange/i.test(s)) {
    return { kind: 'unreachable', message: 'The device did not answer. It may be off, rebooting or on another network.' };
  }
  if (/ENOENT|not found/i.test(s) && /ssh/i.test(s) && code == null) return { kind: 'nossh', message: 'The ssh program is missing on this machine.' };
  const first = s.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return { kind: 'other', message: first || 'The command failed' + (code != null ? ' (exit ' + code + ')' : '') };
}

function create({ dir, askpass }) {
  const keyPath = path.join(dir, 'id_ed25519');
  const knownHosts = path.join(dir, 'known_hosts');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* mounted folder */ }

  /** Make the key pair if it is not there yet. Resolves with the public key line. */
  function ensureKey() {
    return new Promise((resolve) => {
      const pub = keyPath + '.pub';
      if (fs.existsSync(keyPath) && fs.existsSync(pub)) return resolve(fs.readFileSync(pub, 'utf8').trim());
      try { fs.unlinkSync(keyPath); } catch (e) { /* none */ }
      try { fs.unlinkSync(pub); } catch (e) { /* none */ }
      execFile(KEYGEN_BIN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'livecompanion', '-f', keyPath], (err) => {
        if (err) return resolve('');
        try { fs.chmodSync(keyPath, 0o600); } catch (e) { /* ignore */ }
        resolve(fs.existsSync(pub) ? fs.readFileSync(pub, 'utf8').trim() : '');
      });
    });
  }

  function publicKey() {
    try { return fs.readFileSync(keyPath + '.pub', 'utf8').trim(); } catch (e) { return ''; }
  }

  function baseArgs(c) {
    const a = [
      '-T', '-p', String(c.port || 22),
      '-o', 'ConnectTimeout=' + (c.connectTimeout || 8),
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + knownHosts,
      '-o', 'LogLevel=ERROR',
      '-o', 'NumberOfPasswordPrompts=1'
    ];
    if (c.auth === 'password') {
      a.push('-o', 'BatchMode=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no');
    } else {
      a.push('-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no',
        '-o', 'IdentitiesOnly=yes', '-i', keyPath);
    }
    a.push(c.user + '@' + c.host);
    return a;
  }

  /**
   * Run one command on a device.
   * c: { host, port, user, auth: 'key'|'password', password }
   * opts: { input, timeoutMs, stdoutTo (a writable stream for binary output) }
   * Resolves with { code, stdout, stderr, timedOut, err } and never rejects.
   */
  function run(c, command, opts = {}) {
    return new Promise((resolve) => {
      const env = Object.assign({}, process.env);
      if (c.auth === 'password') {
        env.SSH_ASKPASS = askpass;
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.LC_SSH_PASS = c.password || '';
        env.DISPLAY = env.DISPLAY || 'livecompanion:0';
      }
      let child;
      try {
        child = spawn(SSH_BIN, baseArgs(c).concat([command]), { env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { return resolve({ code: null, stdout: '', stderr: String(e.message), timedOut: false, err: explain(String(e.message), null) }); }

      const out = [];
      let err = '', timedOut = false, finished = false;
      const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
      const finish = (code, extra) => {
        if (finished) return; finished = true;
        if (timer) clearTimeout(timer);
        const stdout = opts.stdoutTo ? '' : Buffer.concat(out).toString('utf8');
        const res = { code, stdout, stderr: err, timedOut };
        if (extra) res.stderr += extra;
        if (code !== 0) res.err = timedOut ? { kind: 'timeout', message: 'The device took too long to answer.' } : explain(res.stderr, code);
        resolve(res);
      };

      if (opts.stdoutTo) child.stdout.pipe(opts.stdoutTo);
      else child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => { if (err.length < 20000) err += d.toString('utf8'); });
      child.on('error', (e) => finish(null, e.code === 'ENOENT' ? 'ENOENT: ssh not found' : String(e.message)));
      child.on('close', (code) => finish(code));
      child.stdin.on('error', () => { /* the command ended before reading its input */ });
      if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
    });
  }

  /** Forget a device's remembered host key (after the person confirms it changed). */
  function forgetHost(host, port) {
    return new Promise((resolve) => {
      const name = Number(port) && Number(port) !== 22 ? '[' + host + ']:' + port : host;
      execFile(KEYGEN_BIN, ['-R', name, '-f', knownHosts], () => resolve());
    });
  }

  return { ensureKey, publicKey, run, forgetHost, keyPath, knownHosts };
}

module.exports = { create, explain };
