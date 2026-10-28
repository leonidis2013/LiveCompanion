/*
 * Talking to Bitfocus Companion.
 *
 * Companion's own web page runs on a tRPC WebSocket at ws://<companion>/trpc. It has no
 * login (Companion's admin password only locks the page in the browser), and it is the only
 * way to read and program buttons, pages and triggers. It is Companion's internal interface,
 * not a published one, so a Companion update can change it: every call here goes through
 * one place, and errors say which call failed so a fix is quick.
 *
 * Pressing buttons and custom variables also have Companion's documented HTTP API
 * (/api/location/..., /api/custom-variable/...), used where it covers the job.
 *
 * Protocol (tRPC 11 over WebSocket, no transformer):
 *   -> {"id":1,"method":"query"|"mutation"|"subscription","params":{"path":"pages.watch","input":{...}}}
 *   <- {"id":1,"result":{"type":"started"}}            (subscriptions)
 *   <- {"id":1,"result":{"type":"data","data":...}}
 *   <- {"id":1,"error":{"message":"...","code":-32600,"data":{...}}}
 *   -> {"id":1,"method":"subscription.stop"}
 * Companion pings with the text "PING" every 30 s and drops the socket if "PONG" does not
 * come back within 5 s.
 */
'use strict';

const DEFAULT_TIMEOUT = 10000;

class CompanionError extends Error {
  constructor(message, extra) { super(message); Object.assign(this, extra || {}); }
}

/**
 * opts.getUrl()  -> 'http://192.168.1.20:8000' (Companion's web address)
 * opts.WebSocket -> constructor (tests); defaults to Node's built-in WebSocket
 * opts.fetch     -> function (tests); defaults to global fetch
 */
function create(opts) {
  const WS = opts.WebSocket || globalThis.WebSocket;
  const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  let ws = null, opening = null, nextId = 1, idleTimer = null, lastUrl = '';
  const waiting = new Map(); // id -> { resolve, reject, timer, sub, path }

  const base = () => String(opts.getUrl() || '').trim().replace(/\/+$/, '');
  const configured = () => !!base();
  function wsUrl() {
    const u = new URL(base());
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/trpc'; u.search = ''; u.hash = '';
    return u.toString();
  }

  function failAll(err) {
    for (const [id, w] of waiting) { clearTimeout(w.timer); waiting.delete(id); w.reject(err); }
  }
  function close() {
    clearTimeout(idleTimer);
    const s = ws; ws = null; opening = null;
    if (s) { try { s.close(); } catch (e) { /* gone */ } }
    failAll(new CompanionError('The connection to Companion was closed', { code: 'closed' }));
  }
  /** Keep the socket open a little after the last call, so a burst of calls shares one connection. */
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!waiting.size) close(); else touch(); }, 30000);
    if (idleTimer.unref) idleTimer.unref();
  }

  function connect() {
    if (!configured()) return Promise.reject(new CompanionError('Companion\'s address is not set up in LiveCompanion yet', { code: 'not-configured' }));
    const url = wsUrl();
    if (ws && lastUrl === url && ws.readyState === 1) return Promise.resolve(ws);
    if (opening && lastUrl === url) return opening;
    if (ws) close();
    lastUrl = url;
    opening = new Promise((resolve, reject) => {
      let s;
      try { s = new WS(url); } catch (e) { opening = null; return reject(new CompanionError('Bad Companion address: ' + e.message, { code: 'bad-url' })); }
      const t = setTimeout(() => { try { s.close(); } catch (e) { /* none */ } opening = null; reject(new CompanionError('Companion did not answer at ' + base() + ' within 6 seconds', { code: 'timeout' })); }, 6000);
      s.onopen = () => { clearTimeout(t); ws = s; opening = null; touch(); resolve(s); };
      s.onerror = (ev) => {
        clearTimeout(t);
        if (opening) { opening = null; reject(new CompanionError('Could not connect to Companion at ' + base() + ((ev && ev.message) ? ' (' + ev.message + ')' : '') + '. Check the address and that Companion is running.', { code: 'unreachable' })); }
      };
      s.onclose = () => { clearTimeout(t); if (ws === s) { ws = null; failAll(new CompanionError('Companion closed the connection', { code: 'closed' })); } if (opening) { opening = null; reject(new CompanionError('Companion closed the connection', { code: 'closed' })); } };
      s.onmessage = (ev) => onMessage(s, typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    });
    return opening;
  }

  function onMessage(s, text) {
    if (text === 'PING') { try { s.send('PONG'); } catch (e) { /* closing */ } return; }
    if (text === 'PONG') return;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    // tRPC sends {"id":null,"method":"reconnect"} before Companion restarts
    if (m && m.method === 'reconnect') { close(); return; }
    const w = m && waiting.get(m.id);
    if (!w) return;
    if (m.error) {
      clearTimeout(w.timer); waiting.delete(m.id);
      if (w.sub) stopSub(m.id);
      const e = m.error, d = e.data || {};
      return w.reject(new CompanionError('Companion refused ' + w.path + ': ' + (e.message || 'error') + (d.code ? ' (' + d.code + ')' : ''), { code: 'refused', trpcCode: d.code, path: w.path }));
    }
    const r = m.result || {};
    if (r.type === 'started' || r.type === 'stopped') return;
    clearTimeout(w.timer); waiting.delete(m.id);
    if (w.sub) stopSub(m.id);
    w.resolve(r.data);
  }
  function stopSub(id) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id, method: 'subscription.stop' })); } catch (e) { /* closing */ } }

  async function rpc(method, path, input, o) {
    const s = await connect();
    touch();
    const id = nextId++;
    const params = { path };
    if (input !== undefined) params.input = input;
    return new Promise((resolve, reject) => {
      const timeoutMs = (o && o.timeoutMs) || DEFAULT_TIMEOUT;
      const timer = setTimeout(() => { waiting.delete(id); if (method === 'subscription') stopSub(id); reject(new CompanionError('Companion did not answer ' + path + ' in time', { code: 'timeout', path })); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer, sub: method === 'subscription', path });
      try { s.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); waiting.delete(id); reject(new CompanionError('Could not send to Companion: ' + e.message, { code: 'closed', path })); }
    });
  }

  /** Read-only call. */
  const query = (path, input, o) => rpc('query', path, input, o);
  /** A call that changes something. */
  const mutate = (path, input, o) => rpc('mutation', path, input, o);
  /** First message of a subscription (the snapshot Companion sends on start), then stop. */
  const snapshot = (path, input, o) => rpc('subscription', path, input, o);

  /** Companion's HTTP side: legacy /api, /api/v2 and the export downloads. */
  async function http(method, path, body, o) {
    if (!configured()) throw new CompanionError('Companion\'s address is not set up in LiveCompanion yet', { code: 'not-configured' });
    const headers = Object.assign({}, (o && o.headers) || {});
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    let r;
    try { r = await doFetch(base() + path, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout((o && o.timeoutMs) || DEFAULT_TIMEOUT) }); }
    catch (e) { throw new CompanionError('Could not reach Companion at ' + base() + ' (' + ((e.cause && e.cause.code) || e.name || e.message) + ')', { code: 'unreachable', path }); }
    const text = await r.text();
    let data = text;
    // Companion sends its exports as a download (application/octet-stream), so look at the text itself
    if (/json/i.test(r.headers.get('content-type') || '') || /^\s*[[{]/.test(text)) { try { data = JSON.parse(text); } catch (e) { /* keep text */ } }
    if (!r.ok) throw new CompanionError('Companion answered ' + r.status + ' to ' + method + ' ' + path + (text ? ': ' + String(typeof data === 'object' ? (data.message || data.error || text) : text).slice(0, 200) : ''), { code: 'http', status: r.status, path });
    return data;
  }

  function reset() { close(); }

  return { configured, base, query, mutate, snapshot, http, reset, close };
}

module.exports = { create, CompanionError };
