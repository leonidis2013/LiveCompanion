/*
 * Connection watchdog for the central Companion.
 *
 * Companion's own modules do not always try again after a device was away: when Companion
 * starts before the ATEM, the mixer or the wireless receivers are on, or a device drops off
 * the network for a while, the connection can sit in an error for good. Switching the
 * connection off and on again (what you would do by hand on Companion's Connections page)
 * starts it over, and then it finds the device.
 *
 * The watchdog does exactly that, on its own:
 *  - it looks at the connections every few seconds (the same interface development mode uses)
 *  - a connection that is switched on and has an error for longer than the wait time
 *    (default 60 s) is switched off and on again
 *  - while it stays in error it is tried again after 1, 2, 3... minutes, then at the retry
 *    time (default every 3 min), so a device that is switched on later is picked up soon
 *  - when Companion itself was away (restart, power cut), the wait time starts again from the
 *    moment Companion answers, so its modules get their own chance first
 *  - connections you switched off are never touched, and you can leave out any connection
 *  - a connection it switched off is always switched back on, even if Companion or
 *    LiveCompanion went away in between (remembered in the state file)
 *
 * It does not depend on Claude: it has its own switch, and the development mode off switch
 * and permission levels do not apply to it.
 */
'use strict';

const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = { enabled: true, graceSec: 60, retryMin: 3, warnings: false, skip: [] };

function normalize(w) {
  const out = Object.assign(clone(DEFAULTS), w || {});
  out.enabled = out.enabled !== false;
  out.warnings = !!out.warnings;
  out.graceSec = Math.min(900, Math.max(15, Math.round(Number(out.graceSec)) || DEFAULTS.graceSec));
  out.retryMin = Math.min(60, Math.max(1, Math.round(Number(out.retryMin)) || DEFAULTS.retryMin));
  out.skip = Array.from(new Set((Array.isArray(out.skip) ? out.skip : []).map((x) => String(x).slice(0, 100)).filter(Boolean))).slice(0, 500);
  return out;
}

const statusText = (st) => (!st ? 'unknown' : st.category === 'good' ? 'ok' : [st.level, st.message].filter(Boolean).join(': ') || String(st.category || 'unknown'));

/**
 * o.companion : the Companion client (lib/companion.js or the demo client)
 * o.cfg()     : the watchdog settings (normalized)
 * o.state()   : an object kept in the state file (events, pendingOn)
 * o.save(), o.broadcast()
 * o.tickMs, o.toggleMs, o.minute : timings (tests make them short)
 */
function create(o) {
  const tickMs = o.tickMs || 10000;
  const toggleMs = o.toggleMs == null ? 2000 : o.toggleMs;
  const MIN = o.minute || 60000;
  const st = () => {
    const s = o.state();
    if (!Array.isArray(s.events)) s.events = [];
    if (!s.pendingOn || typeof s.pendingOn !== 'object') s.pendingOn = {};
    return s;
  };
  const changed = () => { o.save(); o.broadcast(); };

  let up = null;            // is Companion answering (null: not looked yet)
  let upSince = 0;          // when it last started answering
  let lastConns = [];       // what the page shows
  let lastError = '';
  let lastLook = 0;
  let busy = false;
  const track = new Map();  // connection id -> { since, attempts, next, label, eventId, restarting }
  let timer = null;

  function event(e) {
    const s = st();
    const ev = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), last: Date.now() }, e);
    s.events.unshift(ev);
    if (s.events.length > 200) s.events.length = 200;
    return ev;
  }
  const findEvent = (id) => (id ? st().events.find((x) => x.id === id) : null);

  async function readConnections() {
    const [list, stat] = await Promise.all([
      o.companion.snapshot('instances.connections.watch', undefined, { timeoutMs: 8000 }),
      o.companion.snapshot('instances.statuses.watch', undefined, { timeoutMs: 8000 })
    ]);
    const info = (Array.isArray(list) ? list.find((m) => m && m.type === 'init') : list) || {};
    const statuses = (stat && stat.statuses) || {};
    return Object.values(info.info || {}).map((x) => ({ id: x.id, label: x.label, module: x.moduleId, enabled: !!x.enabled, status: statuses[x.id] || null }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  const setEnabled = (id, enabled) => o.companion.mutate('instances.connections.setEnabled', { connectionId: id, enabled }, { timeoutMs: 8000 });

  /** Off, a moment, on. The "on" is remembered first, so it happens even if something goes away in between. */
  async function restart(c) {
    const s = st();
    s.pendingOn[c.id] = { label: c.label, since: Date.now() };
    o.save();
    await setEnabled(c.id, false);
    await sleep(toggleMs);
    await setEnabled(c.id, true);
    delete s.pendingOn[c.id];
    o.save();
  }

  /** Switch back on anything the watchdog switched off and could not switch on again. */
  async function finishPending(conns) {
    const s = st();
    for (const id of Object.keys(s.pendingOn)) {
      const c = conns.find((x) => x.id === id);
      if (!c) { delete s.pendingOn[id]; continue; }
      if (c.enabled) { delete s.pendingOn[id]; continue; }
      try { await setEnabled(id, true); c.enabled = true; delete s.pendingOn[id]; event({ type: 'reenabled', label: c.label, detail: 'Switched back on after an interrupted restart' }); }
      catch (e) { lastError = 'Could not switch ' + c.label + ' back on: ' + e.message; }
    }
  }

  const isBad = (status, w) => !!status && (status.category === 'error' || (w.warnings && status.category === 'warning'));

  async function tick(force) {
    if (busy) return;
    const w = o.cfg();
    if (!o.companion.configured()) { if (up !== null || lastConns.length) { up = null; lastConns = []; track.clear(); o.broadcast(); } return; }
    // even when the watchdog is switched off, a connection it switched off is switched back on
    if (!w.enabled && !Object.keys(st().pendingOn).length && !force) { if (track.size) { track.clear(); o.broadcast(); } return; }
    busy = true;
    const now = Date.now();
    try {
      let conns;
      try { conns = await readConnections(); }
      catch (e) {
        if (up !== false) { if (up) event({ type: 'companion-down', detail: e.message }); up = false; track.clear(); changed(); }
        lastError = e.message; lastLook = now;
        return;
      }
      if (up !== true) {
        if (up === false) event({ type: 'companion-back', detail: 'Companion answers again; connections get ' + w.graceSec + ' s to connect by themselves' });
        up = true; upSince = now; lastError = '';
        // fresh start: every connection gets the wait time again
        track.clear();
        changed();
      }
      lastLook = now; lastError = '';
      await finishPending(conns);
      lastConns = conns;
      if (!w.enabled) return;

      const due = [];
      const seen = new Set();
      for (const c of conns) {
        seen.add(c.id);
        const t = track.get(c.id);
        const watched = c.enabled && !w.skip.includes(c.id);
        // after a restart, a connection that only gets as far as a warning (Connecting...) is still stuck
        const stuck = isBad(c.status, w) || !!(t && t.attempts && c.status && c.status.category === 'warning');
        if (!watched || !stuck) {
          if (t) {
            if (watched && c.status && c.status.category === 'good' && t.attempts) {
              const ev = findEvent(t.eventId);
              if (ev) Object.assign(ev, { type: 'reconnected', last: now, status: 'ok' });
              else event({ type: 'reconnected', label: c.label, count: t.attempts });
              changed();
            }
            track.delete(c.id);
          }
          continue;
        }
        if (!t) {
          // a fresh error waits the full wait time, counted from when Companion came up if that was later
          track.set(c.id, { since: now, attempts: 0, next: Math.max(now, upSince) + w.graceSec * 1000, label: c.label, eventId: null });
          continue;
        }
        t.label = c.label;
        if (now >= t.next) due.push(c);
      }
      for (const id of Array.from(track.keys())) if (!seen.has(id)) track.delete(id);

      // a handful at a time, so a big restart wave does not flood Companion
      for (let i = 0; i < due.length; i += 4) {
        await Promise.all(due.slice(i, i + 4).map(async (c) => {
          const t = track.get(c.id);
          try {
            await restart(c);
            t.attempts++;
            t.next = Date.now() + Math.min(t.attempts, w.retryMin) * MIN;
            const ev = findEvent(t.eventId);
            if (ev && ev.type === 'restarting') Object.assign(ev, { last: Date.now(), count: t.attempts, status: statusText(c.status) });
            else t.eventId = event({ type: 'restarting', label: c.label, count: t.attempts, status: statusText(c.status) }).id;
          } catch (e) {
            t.next = Date.now() + MIN;
            event({ type: 'failed', label: c.label, detail: e.message });
          }
        }));
      }
      if (due.length) changed();
    } finally { busy = false; }
  }

  async function restartNow(idOrLabel) {
    const q = String(idOrLabel || '');
    let conns;
    try { conns = await readConnections(); } catch (e) { return { ok: false, error: 'Companion did not answer: ' + e.message }; }
    const c = conns.find((x) => x.id === q) || conns.find((x) => String(x.label).toLowerCase() === q.toLowerCase());
    if (!c) return { ok: false, error: 'Unknown connection' };
    if (!c.enabled) return { ok: false, error: c.label + ' is switched off in Companion. Switch it on there first.' };
    try { await restart(c); } catch (e) { return { ok: false, error: 'Could not restart ' + c.label + ': ' + e.message }; }
    event({ type: 'manual', label: c.label, status: statusText(c.status) });
    const t = track.get(c.id);
    if (t) t.next = Date.now() + o.cfg().graceSec * 1000;
    changed();
    setTimeout(() => tick().catch(() => {}), 3000).unref();
    return { ok: true };
  }

  function snapshot() {
    const w = o.cfg(), now = Date.now();
    return {
      settings: w,
      companionUp: up, lastLook, error: lastError,
      connections: lastConns.map((c) => {
        const t = track.get(c.id);
        return {
          id: c.id, label: c.label, module: c.module, enabled: c.enabled, skipped: w.skip.includes(c.id),
          ok: !!(c.status && c.status.category === 'good'), bad: isBad(c.status, w), status: c.enabled ? statusText(c.status) : 'switched off',
          attempts: t ? t.attempts : 0, since: t ? t.since : 0, nextIn: t && w.enabled && c.enabled && !w.skip.includes(c.id) ? Math.max(0, Math.round((t.next - now) / 1000)) : null
        };
      }),
      events: st().events.slice(0, 60),
      pendingOn: Object.values(st().pendingOn).map((x) => x.label)
    };
  }

  function start() {
    if (timer) return;
    setTimeout(() => tick().catch(() => {}), 1500).unref();
    timer = setInterval(() => tick().catch((e) => { lastError = e.message; }), tickMs);
    timer.unref();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { start, stop, tick, restartNow, snapshot, clearEvents: () => { st().events = []; changed(); } };
}

module.exports = { create, normalize, DEFAULTS, statusText };
