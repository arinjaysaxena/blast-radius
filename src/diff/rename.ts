// Rename detection between removed and added symbols.
import type { ApiKind, ApiMap } from '../model/types.js';

export interface RenamePair {
  from: string;
  to: string;
  score: number;
}

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0;
      row[j] = Math.min(tmp + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] ?? 0;
}

/** 0..1 similarity of two identifiers, case-insensitive. */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Pair removed symbols with added ones that look like renames: same kind and an identical
 * (non-trivial) signature with a reasonably similar name, or a very similar name. Greedy, one-to-one.
 */
export function detectRenames(removed: ApiMap, added: ApiMap): RenamePair[] {
  const pairs: RenamePair[] = [];
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
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const out: RenamePair[] = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from);
    usedTo.add(p.to);
    out.push(p);
  }
  return out;
}

/** What the scorer knows about one symbol on either side of a candidate rename. */
export interface RenameCandidate {
  /** Full change name; members look like `Owner.member`. */
  name: string;
  kind: ApiKind;
  /** Rendered shape (signature, member list, enum members) without the symbol's own name. */
  shape: string;
  /** `@deprecated` message of the old symbol, which often names its replacement. */
  deprecation?: string;
}

export interface ScoredRename {
  from: string;
  to: string;
  /** 0..1; how sure we are that `to` is the new home of `from`. */
  confidence: number;
}

/** Minimum confidence for a removed/added pair to be reported as a rename. */
export const RENAME_THRESHOLD = 0.6;

const leaf = (name: string): string => name.slice(name.lastIndexOf('.') + 1).replace(/^static /, '');
const identTokens = (text: string): Set<string> => new Set(text.match(/[A-Za-z_$][\w$]*|\d+/g) ?? []);
const words = (name: string): Set<string> =>
  new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_\-$]+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean),
  );

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** Closeness of two names: the better of edit distance and shared camelCase words. */
export function nameScore(a: string, b: string): number {
  return Math.max(nameSimilarity(a, b), jaccard(words(a), words(b)));
}

/** Does the old deprecation message point at the new name? */
function pointsAt(message: string | undefined, name: string): boolean {
  if (!message) return false;
  return new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}($|[^\\w$])`).test(message);
}

/** Weighted blend of shape similarity (45%), name similarity (30%) and a deprecation hint (25%). */
export function scoreRename(from: RenameCandidate, to: RenameCandidate): number {
  if (from.kind !== to.kind) return 0;
  const shape = jaccard(identTokens(from.shape), identTokens(to.shape));
  if (shape < 0.5) return 0;
  const hint = pointsAt(from.deprecation, leaf(to.name)) ? 1 : 0;
  return 0.45 * shape + 0.3 * nameScore(leaf(from.name), leaf(to.name)) + 0.25 * hint;
}

/** Greedy one-to-one pairing of removed and added candidates by descending score. */
export function pairRenames(removed: RenameCandidate[], added: RenameCandidate[], threshold = RENAME_THRESHOLD): ScoredRename[] {
  const scored: ScoredRename[] = [];
  for (const r of removed) {
    for (const a of added) {
      const s = scoreRename(r, a);
      if (s >= threshold) scored.push({ from: r.name, to: a.name, confidence: Math.round(s * 100) / 100 });
    }
  }
  scored.sort((x, y) => y.confidence - x.confidence || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  const from = new Set<string>();
  const to = new Set<string>();
  const out: ScoredRename[] = [];
  for (const p of scored) {
    if (from.has(p.from) || to.has(p.to)) continue;
    from.add(p.from);
    to.add(p.to);
    out.push(p);
  }
  return out;
}
