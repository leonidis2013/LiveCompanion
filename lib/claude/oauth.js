/*
 * Sign-in for Claude over the public address (exposed mode): OAuth 2.1 with PKCE.
 *
 * There is no password on the internet-facing side. When Claude asks to connect, its
 * sign-in page shows a short code; you approve that code on LiveCompanion's own page on your
 * home network and choose what this connection may do. Only then does Claude get a token.
 *
 *  - Discovery: protected resource metadata (RFC 9728) and authorization server
 *    metadata (RFC 8414).
 *  - Clients: dynamic registration (RFC 7591), or a client ID metadata document (an https
 *    client_id, which is how claude.ai identifies itself by default).
 *  - PKCE S256 is required; codes live 60 s and work once.
 *  - Access tokens live 1 hour; refresh tokens rotate on every use and expire after
 *    30 days unused. Re-using an old refresh token revokes the whole connection.
 *  - Only hashes of tokens are stored.
 */
'use strict';
const crypto = require('crypto');
const dns = require('dns');
const { isPrivate, sha256, safeEqual } = require('./netsec.js');

const ACCESS_TTL = 3600e3, REFRESH_TTL = 30 * 86400e3, CODE_TTL = 60e3, PENDING_TTL = 10 * 60e3;
const SCOPES = ['read', 'build', 'hands'];
/** How long an approved connection may be used. 'none' = until revoked (or 30 days unused). */
const SPANS = { '1h': 3600e3, '8h': 8 * 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, none: null };
const rand = (n) => crypto.randomBytes(n).toString('base64url');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
function shortCode() { let s = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; return s.slice(0, 3) + '-' + s.slice(3); }
const b64urlSha = (s) => crypto.createHash('sha256').update(s).digest('base64url');

function isLoopback(u) { return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); }
function okRedirect(s) {
  let u; try { u = new URL(s); } catch (e) { return false; }
  if (u.hash) return false;
  return u.protocol === 'https:' || isLoopback(u);
}
/** Exact match, except that loopback redirects may use any port (RFC 8252). */
function redirectMatches(registered, given) {
  if (registered === given) return true;
  try {
    const a = new URL(registered), b = new URL(given);
    return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch (e) { return false; }
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * opts.load() -> stored object, opts.save(obj), opts.base() -> "https://livecompanion.example.com",
 * opts.event(type, detail), opts.fetchDoc(url) for tests
 */
function create(opts) {
  let db = Object.assign({ clients: {}, grants: {} }, opts.load() || {});
  const pending = new Map(), codes = new Map(), usedCodes = new Map(), docCache = new Map();
  const accessIndex = new Map(); // access hash -> grant id
  function reindex() { accessIndex.clear(); for (const g of Object.values(db.grants)) (g.access || []).forEach((a) => accessIndex.set(a.h, g.id)); }
  reindex();
  const save = () => opts.save(db);
  const event = (t, d) => { try { opts.event && opts.event(t, d); } catch (e) { /* never break sign-in */ } };
  const base = () => String(opts.base() || '').replace(/\/+$/, '');
  const resourceUrl = () => base() + '/mcp';

  // ---------- discovery ----------
  function resourceMetadata() {
    return { resource: resourceUrl(), authorization_servers: [base()], scopes_supported: ['livecompanion'], bearer_methods_supported: ['header'], resource_name: 'LiveCompanion' };
  }
  function serverMetadata() {
    const b = base();
    return {
      issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token',
      registration_endpoint: b + '/oauth/register', revocation_endpoint: b + '/oauth/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['livecompanion'], client_id_metadata_document_supported: true,
      service_documentation: 'https://github.com/leonidis2013/LiveCompanion'
    };
  }

  // ---------- clients ----------
  function register(body) {
    body = body && typeof body === 'object' ? body : {};
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http on localhost) addresses' } };
    const method = String(body.token_endpoint_auth_method || 'none');
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'unsupported token_endpoint_auth_method' } };
    // keep the store small: drop the oldest registrations that never got a connection
    const ids = Object.keys(db.clients);
    if (ids.length >= 50) {
      const used = new Set(Object.values(db.grants).map((g) => g.clientId));
      ids.filter((i) => !used.has(i)).sort((a, b) => db.clients[a].createdAt - db.clients[b].createdAt).slice(0, ids.length - 49).forEach((i) => delete db.clients[i]);
    }
    const id = 'hc_' + rand(12), secret = method === 'none' ? null : rand(32), now = Date.now();
    db.clients[id] = { id, name: String(body.client_name || 'Unnamed app').slice(0, 80), redirectUris: uris, authMethod: method, secretHash: secret ? sha256(secret) : null, createdAt: now };
    save();
    event('client-registered', { client: db.clients[id].name });
    const out = { client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: db.clients[id].name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method };
    if (secret) { out.client_secret = secret; out.client_secret_expires_at = 0; }
    return { status: 201, body: out };
  }

  async function defaultFetchDoc(url) {
    const u = new URL(url);
    const addrs = await dns.promises.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('client metadata host resolves to a private address');
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('client metadata answered ' + res.status);
    const text = await res.text();
    if (text.length > 65536) throw new Error('client metadata document too large');
    return JSON.parse(text);
  }

  /** client_id -> { id, name, redirectUris, authMethod, secretHash, kind } or null */
  async function resolveClient(clientId) {
    clientId = String(clientId || '');
    if (db.clients[clientId]) return Object.assign({ kind: 'registered' }, db.clients[clientId]);
    let u; try { u = new URL(clientId); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.hash || u.username || u.password) return null;
    const hit = docCache.get(clientId);
    if (hit && hit.at > Date.now() - 3600e3) return hit.client;
    try {
      const doc = await (opts.fetchDoc || defaultFetchDoc)(clientId);
      if (!doc || doc.client_id !== clientId) throw new Error('client_id in the document does not match');
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String).filter(okRedirect) : [];
      if (!uris.length) throw new Error('no usable redirect_uris');
      const client = { id: clientId, name: String(doc.client_name || u.hostname).slice(0, 80), redirectUris: uris, authMethod: 'none', secretHash: null, kind: 'metadata', host: u.hostname };
      docCache.set(clientId, { at: Date.now(), client });
      return client;
    } catch (e) { event('client-metadata-failed', { client: clientId, error: e.message }); return null; }
  }

  function clientAuth(client, body, basic) {
    if (!client.secretHash) return true;
    let secret = body.client_secret;
    if (basic && basic.id === client.id) secret = basic.secret;
    return !!secret && safeEqual(sha256(secret), client.secretHash);
  }

  // ---------- authorize: show a code, wait for approval at home ----------
  function errorPage(status, title, text) { return { status, html: page(title, '<p>' + esc(text) + '</p>') }; }
  function redirectError(redirectUri, state, error, description) {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error); if (description) u.searchParams.set('error_description', description);
    if (state != null) u.searchParams.set('state', state);
    u.searchParams.set('iss', base());
    return { status: 302, location: u.toString() };
  }

  async function authorize(q, ip, limits) {
    const client = await resolveClient(q.client_id);
    if (!client) return errorPage(400, 'Unknown app', 'This app is not registered with LiveCompanion, or its details could not be read.');
    let redirect = q.redirect_uri;
    if (!redirect) { if (client.redirectUris.length !== 1) return errorPage(400, 'Missing redirect', 'The app did not say where to return to.'); redirect = client.redirectUris[0]; }
    if (!client.redirectUris.some((r) => redirectMatches(r, redirect))) return errorPage(400, 'Wrong redirect', 'The app asked to return to an address it did not register. Nothing was sent to it.');
    // from here on, errors go back to the app
    if (q.response_type !== 'code') return redirectError(redirect, q.state, 'unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return redirectError(redirect, q.state, 'invalid_request', 'PKCE with S256 is required');
    if (q.resource && q.resource.replace(/\/+$/, '') !== resourceUrl() && q.resource.replace(/\/+$/, '') !== base()) return redirectError(redirect, q.state, 'invalid_target', 'unknown resource');
    sweep();
    const waiting = [...pending.values()].filter((p) => p.status === 'waiting');
    if (waiting.length >= (limits && limits.maxPending || 5)) return errorPage(429, 'Too many requests', 'Several connection requests are already waiting for approval. Try again in a few minutes.');
    const p = {
      id: rand(12), secret: rand(24), code: shortCode(), clientId: client.id, clientName: client.name, clientHost: client.host || null,
      redirect, state: q.state == null ? null : String(q.state).slice(0, 500), challenge: q.code_challenge, ip, createdAt: Date.now(), exp: Date.now() + PENDING_TTL, status: 'waiting'
    };
    pending.set(p.id, p);
    event('connection-requested', { client: p.clientName, code: p.code, ip });
    return { status: 200, html: consentPage(p) };
  }

  /** The sign-in page polls this. Once approved, it gets the address to send the browser back to. */
  function status(id, secret) {
    sweep();
    const p = pending.get(String(id || ''));
    if (!p || !safeEqual(p.secret, secret)) return { status: 404, body: { status: 'gone' } };
    if (p.status === 'waiting') return { status: 200, body: { status: 'waiting', expiresIn: Math.max(0, Math.round((p.exp - Date.now()) / 1000)) } };
    if (p.status === 'denied') { pending.delete(p.id); return { status: 200, body: { status: 'denied', redirect: redirectError(p.redirect, p.state, 'access_denied', 'The connection was declined in LiveCompanion').location } }; }
    if (p.status === 'approved') {
      if (!p.authCode) {
        const code = rand(32);
        codes.set(sha256(code), { pendingId: p.id, clientId: p.clientId, redirect: p.redirect, challenge: p.challenge, scope: p.scope, span: p.span, clientName: p.clientName, ip: p.approvedIp, exp: Date.now() + CODE_TTL });
        const u = new URL(p.redirect); u.searchParams.set('code', code); if (p.state != null) u.searchParams.set('state', p.state); u.searchParams.set('iss', base());
        p.authCode = u.toString();
        p.exp = Date.now() + CODE_TTL;
      }
      return { status: 200, body: { status: 'approved', redirect: p.authCode } };
    }
    return { status: 200, body: { status: 'expired' } };
  }

  /**
   * Approve from Claude's sign-in page with an authenticator code (when set up at home).
   * opts.totp: { available() -> { ok, maxScope } , check(code, ip) -> 'ok' | 'wrong' | 'paused' | 'off' }
   */
  function approveWithCode(id, secret, code, scope, ip) {
    sweep();
    const p = pending.get(String(id || ''));
    if (!p || !safeEqual(p.secret, secret)) return { status: 404, body: { error: 'This request is gone. Ask Claude to connect again.' } };
    if (p.status !== 'waiting') return { status: 409, body: { error: 'This request was already answered.' } };
    const t = opts.totp && opts.totp.available();
    if (!t || !t.ok) return { status: 403, body: { error: 'Approving with an authenticator code is not available. Approve it at home instead.' } };
    if (!SCOPES.includes(scope) || SCOPES.indexOf(scope) > SCOPES.indexOf(t.maxScope)) return { status: 400, body: { error: 'That permission level cannot be approved with a code. Approve it at home instead.' } };
    p.tries = (p.tries || 0) + 1;
    const r = opts.totp.check(code, ip);
    if (r === 'paused') return { status: 429, body: { error: 'Too many wrong codes. Approving with a code is paused for a while; approve it at home, or try later.' } };
    if (r === 'off') return { status: 403, body: { error: 'Approving with a code was switched off after too many wrong codes. It can be switched back on at home.' } };
    if (r !== 'ok') {
      if (p.tries >= 5) { p.status = 'denied'; event('connection-denied', { client: p.clientName, code: p.code, why: '5 wrong authenticator codes', ip }); return { status: 401, body: { error: 'Wrong code. This request is now cancelled.', cancelled: true } }; }
      return { status: 401, body: { error: 'Wrong code. ' + (5 - p.tries) + ' tries left for this request.' } };
    }
    p.status = 'approved'; p.scope = scope; p.approvedIp = ip; p.span = t.span in SPANS ? t.span : 'none';
    event('connection-approved', { client: p.clientName, code: p.code, scope, span: p.span, via: 'authenticator code', ip });
    return { status: 200, body: { ok: true } };
  }

  function listPending() {
    sweep();
    return [...pending.values()].filter((p) => p.status === 'waiting').map((p) => ({ id: p.id, code: p.code, client: p.clientName, clientHost: p.clientHost, ip: p.ip, createdAt: p.createdAt, expiresAt: p.exp }));
  }
  function decide(id, approve, scope, byIp, span) {
    const p = pending.get(String(id || ''));
    if (!p || p.status !== 'waiting') return { ok: false, error: 'That request is gone. Ask Claude to connect again.' };
    if (approve && !SCOPES.includes(scope)) return { ok: false, error: 'Choose what this connection may do' };
    if (approve && !(span in SPANS)) return { ok: false, error: 'Choose how long this connection may be used' };
    p.status = approve ? 'approved' : 'denied'; p.scope = scope; p.approvedIp = byIp; p.span = span;
    event(approve ? 'connection-approved' : 'connection-denied', approve ? { client: p.clientName, code: p.code, scope, span } : { client: p.clientName, code: p.code });
    return { ok: true };
  }

  // ---------- tokens ----------
  function issue(g) {
    const access = 'hca_' + rand(32), refresh = 'hcr_' + rand(32), now = Date.now();
    g.access = (g.access || []).filter((a) => a.exp > now).slice(-4);
    const accessExp = g.expiresAt ? Math.min(now + ACCESS_TTL, g.expiresAt) : now + ACCESS_TTL;
    g.access.push({ h: sha256(access), exp: accessExp });
    if (g.refresh) g.prevRefresh = [g.refresh.h].concat(g.prevRefresh || []).slice(0, 20);
    g.refresh = { h: sha256(refresh), exp: g.expiresAt ? Math.min(now + REFRESH_TTL, g.expiresAt) : now + REFRESH_TTL };
    reindex(); save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.round((accessExp - now) / 1000)), refresh_token: refresh, scope: 'livecompanion' };
  }
  function revokeGrant(id, why) {
    const g = db.grants[id];
    if (!g || g.revokedAt) return false;
    g.revokedAt = Date.now(); g.revokedWhy = why || 'revoked'; g.access = []; g.refresh = null;
    reindex(); save();
    event('connection-revoked', { client: g.clientName, why: g.revokedWhy });
    return true;
  }

  async function token(body, basic) {
    body = body || {};
    const bad = (error, description, status) => ({ status: status || 400, body: { error, error_description: description } });
    const client = await resolveClient(body.client_id || (basic && basic.id));
    if (!client) return bad('invalid_client', 'unknown client', 401);
    if (!clientAuth(client, body, basic)) return bad('invalid_client', 'client authentication failed', 401);

    if (body.grant_type === 'authorization_code') {
      const h = sha256(String(body.code || '')), c = codes.get(h);
      if (!c) {
        // a code used twice means someone else has it: cut off what it was used for (RFC 6749 4.1.2)
        const u = usedCodes.get(h);
        if (u) { usedCodes.delete(h); revokeGrant(u.grantId, 'its sign-in code was used a second time (possible theft)'); }
        return bad('invalid_grant', 'unknown or used code');
      }
      codes.delete(h); pending.delete(c.pendingId);
      if (c.exp < Date.now()) return bad('invalid_grant', 'code expired');
      if (c.clientId !== client.id) return bad('invalid_grant', 'code was issued to another client');
      if (body.redirect_uri && !redirectMatches(c.redirect, body.redirect_uri) && body.redirect_uri !== c.redirect) return bad('invalid_grant', 'redirect_uri does not match');
      if (!body.code_verifier || b64urlSha(String(body.code_verifier)) !== c.challenge) return bad('invalid_grant', 'PKCE verification failed');
      if (body.resource && String(body.resource).replace(/\/+$/, '') !== resourceUrl() && String(body.resource).replace(/\/+$/, '') !== base()) return bad('invalid_target', 'unknown resource');
      const id = 'g_' + rand(9);
      const now = Date.now();
      db.grants[id] = { id, clientId: client.id, clientName: c.clientName, scope: c.scope, createdAt: now, approvedIp: c.ip, lastUsedAt: 0, lastIp: '', uses: 0, expiresAt: SPANS[c.span] ? now + SPANS[c.span] : null };
      usedCodes.set(h, { grantId: id, exp: Date.now() + 10 * 60e3 });
      event('connection-created', { client: c.clientName, scope: c.scope });
      return { status: 200, body: issue(db.grants[id]) };
    }
    if (body.grant_type === 'refresh_token') {
      const h = sha256(String(body.refresh_token || ''));
      const g = Object.values(db.grants).find((x) => x.refresh && x.refresh.h === h);
      if (!g) {
        const stolen = Object.values(db.grants).find((x) => (x.prevRefresh || []).includes(h));
        if (stolen && !stolen.revokedAt) { revokeGrant(stolen.id, 'an old refresh token was used again (possible theft)'); }
        return bad('invalid_grant', 'unknown refresh token');
      }
      if (g.revokedAt) return bad('invalid_grant', 'connection revoked');
      if (g.clientId !== client.id) return bad('invalid_grant', 'token belongs to another client');
      if (g.expiresAt && g.expiresAt <= Date.now()) { revokeGrant(g.id, 'its access time ended'); return bad('invalid_grant', 'access time ended'); }
      if (g.refresh.exp < Date.now()) { revokeGrant(g.id, 'unused for 30 days'); return bad('invalid_grant', 'refresh token expired'); }
      return { status: 200, body: issue(g) };
    }
    return bad('unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  /** RFC 7009: always 200. */
  async function revokeToken(body, basic) {
    const h = sha256(String((body || {}).token || ''));
    const g = Object.values(db.grants).find((x) => (x.refresh && x.refresh.h === h) || (x.access || []).some((a) => a.h === h));
    if (g) {
      const client = await resolveClient((body && body.client_id) || (basic && basic.id));
      if (client && client.id === g.clientId && clientAuth(client, body || {}, basic)) revokeGrant(g.id, 'signed out by the app');
    }
    return { status: 200, body: {} };
  }

  /** Bearer access token -> the connection, or null. */
  function verify(tok, ip) {
    if (!tok || !String(tok).startsWith('hca_')) return null;
    const h = sha256(tok), id = accessIndex.get(h);
    const g = id && db.grants[id];
    if (!g || g.revokedAt) return null;
    if (g.expiresAt && g.expiresAt <= Date.now()) { revokeGrant(g.id, 'its access time ended'); return null; }
    const a = (g.access || []).find((x) => x.h === h);
    if (!a || a.exp < Date.now()) return null;
    g.lastUsedAt = Date.now(); g.lastIp = ip || ''; g.uses = (g.uses || 0) + 1;
    if (g.uses % 20 === 1) save();
    return g;
  }

  function connections() {
    return Object.values(db.grants).filter((g) => !g.revokedAt).map((g) => ({ id: g.id, client: g.clientName, scope: g.scope, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, lastIp: g.lastIp, uses: g.uses || 0, refreshExpiresAt: g.refresh && g.refresh.exp, expiresAt: g.expiresAt || null }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  function setScope(id, scope) {
    const g = db.grants[id];
    if (!g || g.revokedAt || !SCOPES.includes(scope)) return false;
    g.scope = scope; save(); event('connection-changed', { client: g.clientName, scope });
    return true;
  }
  /** Give a connection a new access time, counted from now. */
  function setSpan(id, span) {
    const g = db.grants[id];
    if (!g || g.revokedAt || !(span in SPANS)) return false;
    g.expiresAt = SPANS[span] ? Date.now() + SPANS[span] : null;
    if (g.refresh) g.refresh.exp = g.expiresAt ? Math.min(Date.now() + REFRESH_TTL, g.expiresAt) : Date.now() + REFRESH_TTL;
    save(); event('connection-changed', { client: g.clientName, span });
    return true;
  }
  function revokeAll(why) { let n = 0; for (const g of Object.values(db.grants)) if (revokeGrant(g.id, why)) n++; return n; }

  function sweep() {
    const now = Date.now();
    for (const [k, p] of pending) if (p.exp < now) pending.delete(k);
    for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
    for (const [k, c] of usedCodes) if (c.exp < now) usedCodes.delete(k);
    // connections whose access time ran out
    for (const g of Object.values(db.grants)) if (!g.revokedAt && g.expiresAt && g.expiresAt <= now) revokeGrant(g.id, 'its access time ended');
    // forget revoked connections after 30 days
    let dirty = false;
    for (const g of Object.values(db.grants)) if (g.revokedAt && g.revokedAt < now - REFRESH_TTL) { delete db.grants[g.id]; dirty = true; }
    if (dirty) { reindex(); save(); }
  }

  // ---------- the sign-in page Claude's app opens ----------
  function page(title, body, data) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>' + esc(title) + ' · LiveCompanion</title>' +
      '<style>' + PAGE_CSS + '</style></head><body><main><div class="brand">LIVECOMPANION</div><h1>' + esc(title) + '</h1>' + body + '</main>' +
      (data ? '<script type="application/json" id="d">' + JSON.stringify(data).replace(/</g, '\\u003c') + '</script><script>' + PAGE_JS + '</script>' : '') + '</body></html>';
  }
  function consentPage(p) {
    const t = opts.totp && opts.totp.available();
    const codeOk = !!(t && t.ok);
    const scopes = codeOk ? SCOPES.slice(0, SCOPES.indexOf(t.maxScope) + 1) : [];
    const names = { read: 'Look only', build: 'Help build', hands: 'Hands on' };
    return page(codeOk ? 'Approve this connection' : 'Approve this connection at home',
      '<p><b>' + esc(p.clientName) + '</b>' + (p.clientHost ? ' (' + esc(p.clientHost) + ')' : '') + ' wants to connect to your LiveCompanion.</p>' +
      '<div class="code" aria-label="Connection code">' + esc(p.code) + '</div>' +
      '<ol><li>Open LiveCompanion <b>on your home network</b>.</li><li>Check that it shows this same code.</li><li>Choose what Claude may do, and approve.</li></ol>' +
      '<div class="wait" id="st"><span class="spin"></span><span>Waiting for approval…</span></div>' +
      (codeOk ? '<div class="or"><span>or, away from home</span></div>' +
        '<div class="totp"><label for="c">Code from your authenticator app</label>' +
        '<input id="c" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000">' +
        '<div class="lbl">Claude may</div><div class="seg" id="sc">' + scopes.map((x, i) => '<button type="button" data-v="' + x + '"' + (i === 0 ? ' class="on"' : '') + '>' + names[x] + '</button>').join('') + '</div>' +
        '<button type="button" id="ok" class="go">Approve with code</button><div class="msg" id="m"></div></div>' : '') +
      '<p class="small">If you did not ask for this, ignore it. Nothing connects unless you approve it. This request expires in <b id="left">10:00</b>.</p>',
      { id: p.id, s: p.secret, totp: codeOk, exp: p.exp - Date.now() });
  }

  setInterval(sweep, 60e3).unref();
  return {
    resourceMetadata, serverMetadata, register, authorize, status, token, revokeToken, verify,
    listPending, decide, approveWithCode, connections, setSpan, revokeGrant, revokeAll, setScope, resolveClient,
    errorPage, PAGE_CSS: () => PAGE_CSS, PAGE_JS: () => PAGE_JS
  };
}

const PAGE_CSS = [
  ':root{--bg:#0d1015;--card:#151a21;--card2:#1b2129;--line:#252c36;--fg:#d8dee6;--dim:#7c8794;--acc:#4c8dff;--ok:#3ecf6e;--bad:#ef4c4c}',
  '@media (prefers-color-scheme:light){:root{--bg:#e9edf2;--card:#fbfcfd;--card2:#f0f3f6;--line:#d3dae3;--fg:#18202b;--dim:#586474;--acc:#2563d6;--ok:#23a056;--bad:#d63232}}',
  '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}',
  'main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:440px;width:100%}',
  '.brand{font-size:12px;letter-spacing:.14em;font-weight:800;color:var(--dim)}h1{font-size:21px;margin:6px 0 10px}p{color:var(--dim);margin:0 0 12px}p b{color:var(--fg)}',
  '.code{font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em;text-align:center;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:16px;margin:8px 0 14px}',
  'ol{color:var(--dim);padding-left:20px;margin:0 0 14px}ol b{color:var(--fg)}.small{font-size:12.5px}',
  '.or{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:4px 0 12px}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}',
  '.totp{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}.totp label,.totp .lbl{font-size:13px;color:var(--dim)}',
  '#c{font:700 26px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3em;text-align:center;padding:12px;border-radius:9px;border:1px solid var(--line);background:var(--card2);color:var(--fg);width:100%}',
  '#c:focus{outline:2px solid var(--acc)}.seg{display:flex;background:var(--card2);border-radius:9px;padding:3px;gap:2px}',
  '.seg button{flex:1;border:0;background:transparent;color:var(--fg);font:600 13.5px system-ui,sans-serif;padding:9px 6px;border-radius:7px;cursor:pointer}.seg button.on{background:var(--acc);color:#fff}',
  '.go{border:0;background:var(--acc);color:#fff;font:700 15px system-ui,sans-serif;padding:12px;border-radius:9px;cursor:pointer}.go:disabled{opacity:.5}',
  '.msg{font-size:13px;color:var(--bad);min-height:18px}',
  '.wait{display:flex;gap:10px;align-items:center;border:1px dashed var(--acc);border-radius:9px;padding:10px 12px;margin-bottom:12px;color:var(--dim);font-size:14px}',
  '.wait.ok{border:1px solid var(--ok);color:var(--ok)}.wait.bad{border:1px solid var(--bad);color:var(--bad)}',
  '.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:s .9s linear infinite;flex:none}@keyframes s{to{transform:rotate(360deg)}}'
].join('\n');

const PAGE_JS = [
  '(function(){var d=JSON.parse(document.getElementById("d").textContent),st=document.getElementById("st");',
  'function show(c,t){st.className="wait "+c;st.textContent=t;}',
  'var end=Date.now()+d.exp,lf=document.getElementById("left"),done=false;function tick(){var s=Math.max(0,Math.round((end-Date.now())/1000));lf.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");if(s<=60)lf.style.color="var(--bad)";if(s>0&&!done)setTimeout(tick,1000);}tick();',
  'function poll(){fetch("status?id="+encodeURIComponent(d.id)+"&s="+encodeURIComponent(d.s),{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){',
  'if(j.status==="approved"){done=true;show("ok","Approved. Returning to Claude…");location.replace(j.redirect);return;}',
  'if(j.status==="denied"){show("bad","Declined at home.");setTimeout(function(){location.replace(j.redirect);},1500);return;}',
  'if(j.status==="waiting"){setTimeout(poll,2000);return;}',
  'show("bad","This request has expired. Ask Claude to connect again.");',
  '}).catch(function(){setTimeout(poll,4000);});}poll();',
  'if(d.totp){var c=document.getElementById("c"),ok=document.getElementById("ok"),m=document.getElementById("m"),sc="read";',
  'Array.prototype.forEach.call(document.querySelectorAll("#sc button"),function(b){b.onclick=function(){sc=b.dataset.v;Array.prototype.forEach.call(document.querySelectorAll("#sc button"),function(x){x.className=x===b?"on":"";});};});',
  'var first=document.querySelector("#sc button");if(first)sc=first.dataset.v;',
  'c.addEventListener("input",function(){c.value=c.value.replace(/\\D/g,"").slice(0,6);if(c.value.length===6)ok.focus();});',
  'function send(){if(c.value.length!==6){m.textContent="Enter the 6 digits.";return;}ok.disabled=true;m.textContent="";',
  'fetch("approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:d.id,s:d.s,code:c.value,scope:sc})}).then(function(r){return r.json();}).then(function(j){',
  'if(j.ok){m.style.color="var(--ok)";m.textContent="Approved.";return;}m.textContent=j.error||"Did not work.";c.value="";ok.disabled=!!j.cancelled;c.focus();',
  '}).catch(function(){ok.disabled=false;m.textContent="Could not reach LiveCompanion.";});}',
  'ok.onclick=send;c.addEventListener("keydown",function(e){if(e.key==="Enter")send();});}',
  '})();'
].join('');

module.exports = { create, SCOPES, SPANS, redirectMatches, okRedirect };
