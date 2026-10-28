/*
 * Authenticator codes (TOTP, RFC 6238): the 6-digit codes Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy and the iPhone Passwords app show.
 * SHA-1, 6 digits, 30-second steps: the settings every one of those apps uses.
 */
'use strict';
const crypto = require('crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('not base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
const counterAt = (ms) => Math.floor(ms / 1000 / 30);
const newSecret = () => base32Encode(crypto.randomBytes(20));

/**
 * Checks a code against the current 30-second step and one step either side (phone
 * clocks drift). Returns the step it matched, or null. A step at or before
 * `lastCounter` never matches again, so a code cannot be replayed.
 */
function verify(secretB32, code, lastCounter, now) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32), c = counterAt(now || Date.now());
  for (const d of [0, -1, 1]) {
    const step = c + d;
    if (lastCounter != null && step <= lastCounter) continue;
    const want = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(code))) return step;
  }
  return null;
}

function uri(secretB32, account, issuer) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return 'otpauth://totp/' + label + '?secret=' + secretB32 + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

module.exports = { base32Encode, base32Decode, hotp, verify, uri, newSecret, counterAt };
