/*
 * Network-side safety: who is asking (private network or not), how often they may
 * fail before being locked out, and the security headers every response carries.
 */
'use strict';
const net = require('net');
const crypto = require('crypto');

// ---------- addresses ----------
function v4ToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + (Number(b) & 255), 0) >>> 0; }
function inV4(ip, cidr) { const [base, bits] = cidr.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask); }
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'];

/** Loopback, RFC 1918, link-local, CGNAT/Tailscale (100.64/10), IPv6 ULA and link-local. */
function isPrivate(ip) {
  ip = String(ip || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) return PRIVATE_V4.some((c) => inV4(ip, c));
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l); }
  return false;
}

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip', 'true-client-ip', 'x-forwarded-host'];
const cameThroughProxy = (req) => PROXY_HEADERS.some((h) => req.headers[h] != null);

/** The address of the person asking. On the public port the peer is the reverse proxy, so take what it reports. */
function clientIp(req, behindProxy) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!behindProxy) return peer;
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.headers['x-real-ip'];
  if (cf) return String(cf).trim();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // the last entry was added by the proxy in front of us; anything before it the client could have made up
  if (xff.length) return xff[xff.length - 1];
  return peer;
}

// ---------- rate limits and lockouts ----------
/** Counts events per key in a window; after `max` the key is locked for `lockMs`. */
function limiter({ max, windowMs, lockMs }) {
  const hits = new Map();
  function sweep(now) { if (hits.size > 5000) for (const [k, v] of hits) if (v.until < now && v.start + windowMs < now) hits.delete(k); }
  return {
    /** Is this key locked right now? Returns seconds left, or 0. */
    locked(key) { const v = hits.get(key), now = Date.now(); return v && v.until > now ? Math.ceil((v.until - now) / 1000) : 0; },
    /** Count one event. Returns true when this pushed the key into a lockout. */
    hit(key) {
      const now = Date.now(); sweep(now);
      let v = hits.get(key);
      if (!v || v.start + windowMs < now) { v = { start: now, n: 0, until: 0 }; hits.set(key, v); }
      v.n++;
      if (v.n >= max && v.until < now) { v.until = now + lockMs; v.n = 0; v.start = now; return true; }
      return false;
    },
    reset(key) { hits.delete(key); },
    size: () => hits.size
  };
}

// ---------- headers ----------
/** sha256 hashes of the inline <script> and <style> blocks, for a Content-Security-Policy without 'unsafe-inline'. */
function inlineHashes(html) {
  const grab = (tag) => [...html.matchAll(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'))].map((m) => "'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'");
  return { scripts: grab('script'), styles: grab('style') };
}

function securityHeaders(extra) {
  return Object.assign({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  }, extra || {});
}

function pageCsp(h) {
  // style="" attributes are allowed (they cannot run code); scripts must match a hash
  return "default-src 'none'; script-src " + h.scripts.join(' ') + '; style-src-elem ' + h.styles.join(' ') + "; style-src-attr 'unsafe-inline'" +
    "; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEqual(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }

module.exports = { isPrivate, clientIp, cameThroughProxy, limiter, inlineHashes, securityHeaders, pageCsp, sha256, safeEqual };
