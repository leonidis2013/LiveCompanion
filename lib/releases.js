/*
 * What is the newest STABLE build Bitfocus has published?
 *
 * This is the same feed the devices' own update scripts use
 * (companion-update / satellite-update): api.bitfocus.io, branch=stable.
 * LiveCompanion reads it from this container, so each device only needs
 * internet access when it actually runs its update.
 */
'use strict';

const https = require('https');
const V = require('./version');

const FEED = process.env.LIVECOMPANION_FEED || 'https://api.bitfocus.io/v1/product';
const PRODUCTS = { companion: 'companion', satellite: 'companion-satellite' };

/** Build target the feed uses for a CPU, same rule as the devices' updaters. */
function targetFor(arch) {
  const a = String(arch || '').trim();
  if (a === 'x86_64' || a === 'amd64' || a === 'x64') return 'linux-tgz';
  if (a === 'aarch64' || a === 'arm64') return 'linux-arm64-tgz';
  return null;
}

function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'LiveCompanion', accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Bitfocus answered ' + res.statusCode)); }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; if (raw.length > 2e6) req.destroy(new Error('Answer too large')); });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Bitfocus sent something unreadable')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Bitfocus did not answer in time')));
    req.on('error', (e) => reject(new Error(e.message && e.message.startsWith('Bitfocus') ? e.message : 'Could not reach Bitfocus (' + (e.code || e.message) + ')')));
  });
}

/** Newest stable package for a product + target, or null when the feed has none. */
async function latestStable(product, target, getter = getJson) {
  const name = PRODUCTS[product] || product;
  const data = await getter(FEED + '/' + name + '/packages?branch=stable&limit=1&target=' + encodeURIComponent(target));
  const pkg = (data && data.packages || []).find((p) => p && p.target === target && V.parse(p.version));
  return pkg ? { version: String(pkg.version), uri: pkg.uri || '', published: pkg.published || null } : null;
}

/** Remembers answers for a few minutes so a "check all" asks Bitfocus once per product and CPU. */
function cache(getter = getJson, ttlMs = 10 * 60 * 1000) {
  const map = new Map();
  return {
    async get(product, target) {
      const key = product + '|' + target;
      const hit = map.get(key);
      if (hit && Date.now() - hit.at < (hit.ok ? ttlMs : 30000)) return hit.value;
      let value;
      try { value = { ok: true, latest: await latestStable(product, target, getter) }; }
      catch (e) { value = { ok: false, error: e.message }; }
      map.set(key, { at: Date.now(), ok: value.ok, value });
      return value;
    },
    clear() { map.clear(); }
  };
}

module.exports = { targetFor, latestStable, cache, getJson, FEED };
