/*
 * Passwords for devices are stored encrypted (AES-256-GCM) with a key that lives
 * next to the config in the data folder. That keeps them out of casual view
 * (backups, screenshots of the file); anyone who can read the whole data folder
 * can still decrypt them, so use SSH keys where you can.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function create(keyFile) {
  let key = null;
  function load() {
    if (key) return key;
    try { key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch (e) { key = null; }
    if (!key || key.length !== 32) {
      key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
    }
    return key;
  }
  function enc(text) {
    if (text == null || text === '') return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', load(), iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function dec(blob) {
    if (!blob) return '';
    if (!String(blob).startsWith('enc1:')) return String(blob);          // plain text typed into the file by hand
    try {
      const raw = Buffer.from(String(blob).slice(5), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', load(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch (e) { return ''; }
  }
  return { enc, dec };
}

module.exports = { create };
