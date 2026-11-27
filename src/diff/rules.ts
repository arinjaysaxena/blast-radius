// Compatibility rules: why a changed signature is breaking for callers.
import type { ApiKind } from '../model/types.js';
import { parseCallSignature, parseMembers, splitOverloads } from './parse.js';

function compareCalls(oldSig: string, newSig: string): string[] {
  const a = parseCallSignature(oldSig);
  const b = parseCallSignature(newSig);
  if (!a || !b) return ['signature changed'];
  const reasons: string[] = [];
  if (a.ret !== b.ret) reasons.push(`return type changed: ${a.ret} -> ${b.ret}`);
  if (a.generics !== b.generics) {
    reasons.push(`type parameters changed: ${a.generics || '(none)'} -> ${b.generics || '(none)'}`);
  }
  const n = Math.max(a.params.length, b.params.length);
  for (let i = 0; i < n; i++) {
    const p = a.params[i];
    const q = b.params[i];
    if (p && !q) reasons.push(`parameter "${p.name}" removed`);
    else if (!p && q) {
      if (!q.optional) reasons.push(`required parameter "${q.name}" added`);
    } else if (p && q) {
      if (p.type !== q.type) reasons.push(`parameter "${p.name}" type changed: ${p.type} -> ${q.type}`);
      if (p.optional && !q.optional) reasons.push(`parameter "${q.name}" is now required`);
    }
  }
  return reasons;
}

function compareShapes(kind: ApiKind, oldSig: string, newSig: string): string[] {
  const a = parseMembers(oldSig);
  const b = parseMembers(newSig);
  if (!a || !b) return ['signature changed'];
  const reasons: string[] = [];
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
    for (const [name, m] of b.members) {
      if (!a.members.has(name) && !m.optional) reasons.push(`required member "${name}" added`);
    }
  }
  return reasons;
}

function parseEnum(sig: string): Map<string, string> {
  const body = /\{\s*([\s\S]*?)\s*\}/.exec(sig)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const part of body.split(';').map((x) => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function compareEnums(oldSig: string, newSig: string): string[] {
  const a = parseEnum(oldSig);
  const b = parseEnum(newSig);
  const reasons: string[] = [];
  for (const [k, v] of a) {
    const next = b.get(k);
    if (next === undefined) reasons.push(`enum member "${k}" removed`);
    else if (next !== v) reasons.push(`enum member "${k}" value changed: ${v} -> ${next}`);
  }
  return reasons;
}

/** Why `newSig` is breaking relative to `oldSig` (empty array = compatible change). */
export function breakingReasons(kind: ApiKind, oldSig: string, newSig: string): string[] {
  if (kind === 'function') {
    const olds = splitOverloads(oldSig);
    const news = splitOverloads(newSig);
    if (olds.every((o) => news.includes(o))) return []; // only overloads added
    const [onlyOld] = olds;
    const [onlyNew] = news;
    if (olds.length === 1 && news.length === 1 && onlyOld !== undefined && onlyNew !== undefined) {
      return compareCalls(onlyOld, onlyNew);
    }
    return olds.filter((o) => !news.includes(o)).map((o) => `overload no longer available: ${o}`);
  }
  if (kind === 'class' || kind === 'interface') return compareShapes(kind, oldSig, newSig);
  if (kind === 'enum') return compareEnums(oldSig, newSig);
  return ['type changed'];
}
