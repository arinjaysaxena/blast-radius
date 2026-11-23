// API diff: added / removed / renamed / changed symbols with breaking classification.

/** Split `text` on `sep` at bracket depth 0 (handles (), [], {}, <> and ignores `=>`). */
export function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{<'.includes(ch)) depth++;
    else if (')]}'.includes(ch) || (ch === '>' && text[i - 1] !== '=')) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Split a function signature string into overloads: "(a): x | (b): y" -> ["(a): x", "(b): y"]. */
export function splitOverloads(sig) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i];
    if ('([{<'.includes(ch)) depth++;
    else if (')]}'.includes(ch) || (ch === '>' && sig[i - 1] !== '=')) depth = Math.max(0, depth - 1);
    if (depth === 0 && sig.startsWith(' | ', i) && /^[<(]/.test(sig.slice(i + 3))) {
      out.push(sig.slice(start, i).trim());
      start = i + 3;
    }
  }
  out.push(sig.slice(start).trim());
  return out;
}

/** Parse "<T>(a: A, b?: B): R" into { params: [{ name, optional, rest, type }], ret }. */
export function parseCallSignature(sig) {
  const open = sig.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const params = splitTopLevel(sig.slice(open + 1, close), ',').map((p) => {
    const m = /^(\.\.\.)?([\w$]+)(\?)?\s*:\s*([\s\S]*)$/.exec(p);
    return m ? { rest: !!m[1], name: m[2], optional: !!m[3] || !!m[1], type: m[4].trim() } : { rest: false, name: p, optional: false, type: p };
  });
  return { generics: sig.slice(0, open).trim(), params, ret: sig.slice(close + 1).replace(/^\s*:\s*/, '').trim() };
}

function compareCalls(oldSig, newSig) {
  const a = parseCallSignature(oldSig);
  const b = parseCallSignature(newSig);
  if (!a || !b) return ['signature changed'];
  const reasons = [];
  if (a.ret !== b.ret) reasons.push(`return type changed: ${a.ret} -> ${b.ret}`);
  if (a.generics !== b.generics) reasons.push(`type parameters changed: ${a.generics || '(none)'} -> ${b.generics || '(none)'}`);
  const n = Math.max(a.params.length, b.params.length);
  for (let i = 0; i < n; i++) {
    const p = a.params[i];
    const q = b.params[i];
    if (p && !q) reasons.push(`parameter "${p.name}" removed`);
    else if (!p && q) {
      if (!q.optional) reasons.push(`required parameter "${q.name}" added`);
    } else {
      if (p.type !== q.type) reasons.push(`parameter "${p.name}" type changed: ${p.type} -> ${q.type}`);
      if (p.optional && !q.optional) reasons.push(`parameter "${q.name}" is now required`);
    }
  }
  return reasons;
}

/** Parse the `{ a: T; b?: U }` body of an object-like signature (ignoring any `new (...)` prefix). */
export function parseMembers(sig) {
  const open = sig.lastIndexOf('{ ');
  const start = sig.indexOf('{');
  if (start === -1 || open === -1) return null;
  const body = sig.slice(start + 1, sig.lastIndexOf('}'));
  const ctor = sig.slice(0, start).trim();
  const members = new Map();
  for (const m of splitTopLevel(body, ';')) {
    const mm = /^((?:static )?[\w$]+)(\?)?\s*:\s*([\s\S]*)$/.exec(m);
    if (mm) members.set(mm[1], { optional: !!mm[2], type: mm[3].trim() });
  }
  return { ctor, members };
}

function compareShapes(kind, oldSig, newSig) {
  const a = parseMembers(oldSig);
  const b = parseMembers(newSig);
  if (!a || !b) return ['signature changed'];
  const reasons = [];
  if (a.ctor !== b.ctor) reasons.push(`constructor changed: ${a.ctor || '(none)'} -> ${b.ctor || '(none)'}`);
  for (const [name, m] of a.members) {
    const n = b.members.get(name);
    if (!n) reasons.push(`member "${name}" removed`);
    else {
      if (m.type !== n.type) reasons.push(`member "${name}" type changed: ${m.type} -> ${n.type}`);
      if (m.optional && !n.optional) reasons.push(`member "${name}" is now required`);
    }
  }
  // Adding a required member breaks everyone who implements or constructs an object of that interface/type.
  if (kind !== 'class') {
    for (const [name, m] of b.members) if (!a.members.has(name) && !m.optional) reasons.push(`required member "${name}" added`);
  }
  return reasons;
}

function compareEnums(oldSig, newSig) {
  const parse = (s) => new Map((/\{\s*([\s\S]*?)\s*\}/.exec(s)?.[1] ?? '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => x.split('=')));
  const a = parse(oldSig);
  const b = parse(newSig);
  const reasons = [];
  for (const [k, v] of a) {
    if (!b.has(k)) reasons.push(`enum member "${k}" removed`);
    else if (b.get(k) !== v) reasons.push(`enum member "${k}" value changed: ${v} -> ${b.get(k)}`);
  }
  return reasons;
}

/** Why `newSig` is breaking relative to `oldSig` (empty array = compatible change). */
export function breakingReasons(kind, oldSig, newSig) {
  if (kind === 'function') {
    const olds = splitOverloads(oldSig);
    const news = splitOverloads(newSig);
    if (olds.every((o) => news.includes(o))) return []; // only overloads added
    if (olds.length === 1 && news.length === 1) return compareCalls(olds[0], news[0]);
    const survivors = olds.filter((o) => !news.includes(o));
    return survivors.map((o) => `overload no longer available: ${o}`);
  }
  if (kind === 'class' || kind === 'interface') return compareShapes(kind, oldSig, newSig);
  if (kind === 'enum') return compareEnums(oldSig, newSig);
  return ['type changed'];
}

export function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** 0..1 similarity of two identifiers, case-insensitive. */
export function nameSimilarity(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Pair removed symbols with added ones that look like renames: same kind and an identical
 * (non-trivial) signature with a reasonably similar name, or a very similar name. Greedy, one-to-one.
 */
export function detectRenames(removed, added) {
  const pairs = [];
  for (const [rn, r] of Object.entries(removed)) {
    for (const [an, a] of Object.entries(added)) {
      if (r.kind !== a.kind) continue;
      const sim = nameSimilarity(rn, an);
      const sameSig = r.signature === a.signature;
      const need = sameSig ? (r.signature.length > 12 ? 0.4 : 0.6) : 0.75;
      if (sim >= need) pairs.push({ from: rn, to: an, score: sim + (sameSig ? 1 : 0) });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.from.localeCompare(y.from));
  const usedFrom = new Set();
  const usedTo = new Set();
  const out = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from);
    usedTo.add(p.to);
    out.push(p);
  }
  return out;
}

/**
 * Diff two APIs ({ name: { kind, signature } }). Returns a list of entries sorted by name:
 * { name, change: 'added'|'removed'|'renamed'|'changed', breaking, kind, old?, new?, renamedTo?, reasons[] }.
 */
export function diffApi(oldApi, newApi) {
  const entries = [];
  const removed = {};
  const added = {};
  for (const [name, o] of Object.entries(oldApi)) {
    const n = newApi[name];
    if (!n) removed[name] = o;
    else if (o.kind !== n.kind) {
      entries.push({ name, change: 'changed', breaking: true, kind: n.kind, old: o.signature, new: n.signature, reasons: [`kind changed: ${o.kind} -> ${n.kind}`] });
    } else if (o.signature !== n.signature) {
      const reasons = breakingReasons(o.kind, o.signature, n.signature);
      entries.push({ name, change: 'changed', breaking: reasons.length > 0, kind: n.kind, old: o.signature, new: n.signature, reasons: reasons.length ? reasons : ['backwards-compatible signature change'] });
    }
  }
  for (const [name, n] of Object.entries(newApi)) if (!oldApi[name]) added[name] = n;

  for (const { from, to } of detectRenames(removed, added)) {
    const r = removed[from];
    const a = added[to];
    const sigChanged = r.signature !== a.signature;
    entries.push({ name: from, change: 'renamed', breaking: true, kind: a.kind, old: r.signature, new: a.signature, renamedTo: to, reasons: [`renamed to "${to}"${sigChanged ? ' (signature also changed)' : ''}`] });
    delete removed[from];
    delete added[to];
  }
  for (const [name, r] of Object.entries(removed)) entries.push({ name, change: 'removed', breaking: true, kind: r.kind, old: r.signature, reasons: ['removed from the public API'] });
  for (const [name, a] of Object.entries(added)) entries.push({ name, change: 'added', breaking: false, kind: a.kind, new: a.signature, reasons: [] });
  return entries.sort((x, y) => x.name.localeCompare(y.name));
}

export const summarize = (entries) => ({
  total: entries.length,
  breaking: entries.filter((e) => e.breaking).length,
  added: entries.filter((e) => e.change === 'added').length,
  removed: entries.filter((e) => e.change === 'removed').length,
  renamed: entries.filter((e) => e.change === 'renamed').length,
  changed: entries.filter((e) => e.change === 'changed').length,
});
