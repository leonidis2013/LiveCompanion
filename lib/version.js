/*
 * Version strings as Bitfocus writes them:
 *   stable  "v4.3.4"
 *   beta    "5.0.0+9502-main-2026..."   (build metadata after a plus sign)
 * Stable means: a plain major.minor.patch with no pre-release and no build part.
 */
'use strict';

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+(.+))?$/;

function parse(v) {
  const m = RE.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null, build: m[5] || null };
}

function cmpPre(a, b) {
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1; }
    else if (na) return -1;
    else if (nb) return 1;
    else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1 (build metadata is ignored); null when either side is not a version. */
function compare(a, b) {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] < pb.n[i] ? -1 : 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return cmpPre(pa.pre, pb.pre);
  return 0;
}

/** 'stable', 'beta' or 'unknown' */
function channel(v) {
  const p = parse(v);
  if (!p) return 'unknown';
  return p.pre || p.build ? 'beta' : 'stable';
}

const newer = (a, b) => compare(a, b) === 1;
const short = (v) => String(v == null ? '' : v).replace(/\+.*$/, '');

module.exports = { parse, compare, channel, newer, short };
