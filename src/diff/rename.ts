// Rename detection between removed and added symbols.
import type { ApiMap } from '../model/types.js';

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
