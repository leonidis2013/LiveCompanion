/*
 * Before Claude changes or deletes something in Companion, the current version is copied
 * here: <data>/claude-backups/<button|trigger|page|variable>/<id>/<date-time>-<reason>.json
 * Each holds { name, ... } plus what is needed to put it back. The newest few per item are
 * kept. Restoring one puts it back in Companion.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KINDS = ['button', 'trigger', 'page', 'variable'];
const ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const FILE_RE = /^\d{8}-\d{6}(-\d+)?-[a-z-]{1,30}\.json$/;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function create({ dir, keep }) {
  const ok = (kind, id) => KINDS.includes(kind) && ID_RE.test(String(id)) && id !== '.' && id !== '..';

  function save(kind, id, config, reason) {
    if (!ok(kind, id)) throw new Error('Cannot back up ' + kind + ' "' + id + '": unexpected name');
    reason = String(reason || 'change').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 30) || 'change';
    const folder = path.join(dir, kind, String(id));
    fs.mkdirSync(folder, { recursive: true });
    const base = stamp(new Date());
    let file = base + '-' + reason + '.json';
    for (let n = 2; fs.existsSync(path.join(folder, file)); n++) file = base + '-' + n + '-' + reason + '.json';
    const body = { kind, id: String(id), savedAt: new Date().toISOString(), reason, config };
    fs.writeFileSync(path.join(folder, file), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    prune(folder);
    return file;
  }

  function prune(folder) {
    const max = Math.max(1, Number(typeof keep === 'function' ? keep() : keep) || 30);
    const files = fs.readdirSync(folder).filter((f) => FILE_RE.test(f)).sort().reverse();
    files.slice(max).forEach((f) => { try { fs.unlinkSync(path.join(folder, f)); } catch (e) { /* gone */ } });
  }

  function list() {
    const out = [];
    for (const kind of KINDS) {
      let ids = [];
      try { ids = fs.readdirSync(path.join(dir, kind)); } catch (e) { continue; }
      for (const id of ids) {
        if (!ok(kind, id)) continue;
        let files = [];
        try { files = fs.readdirSync(path.join(dir, kind, id)).filter((f) => FILE_RE.test(f)); } catch (e) { continue; }
        for (const file of files) {
          const b = read(kind, id, file);
          if (!b) continue;
          const c = b.config || {};
          out.push({ kind, id, file, savedAt: b.savedAt, reason: b.reason, alias: String(c.name || c.alias || '').slice(0, 120) });
        }
      }
    }
    return out.sort((a, b) => (b.savedAt > a.savedAt ? 1 : b.savedAt < a.savedAt ? -1 : 0));
  }

  function filePath(kind, id, file) {
    if (!ok(kind, id) || !FILE_RE.test(String(file))) return null;
    const p = path.join(dir, kind, String(id), String(file));
    return fs.existsSync(p) ? p : null;
  }

  function read(kind, id, file) {
    const p = filePath(kind, id, file);
    if (!p) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  return { save, list, read, filePath };
}

module.exports = { create };
