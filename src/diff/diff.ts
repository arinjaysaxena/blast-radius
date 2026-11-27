// Structural API diff with breaking classification and rename detection.
import type { ApiChange, ApiMap, DiffSummary } from '../model/types.js';
import { detectRenames } from './rename.js';
import { breakingReasons } from './rules.js';

const omit = (map: ApiMap, key: string): ApiMap => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

/** Diff two APIs; entries are sorted by name. */
export function diffApi(oldApi: ApiMap, newApi: ApiMap): ApiChange[] {
  const entries: ApiChange[] = [];
  let removed: ApiMap = {};
  let added: ApiMap = {};
  for (const [name, o] of Object.entries(oldApi)) {
    const n = newApi[name];
    if (!n) removed[name] = o;
    else if (o.kind !== n.kind) {
      entries.push({ name, change: 'changed', breaking: true, kind: n.kind, old: o.signature, new: n.signature, reasons: [`kind changed: ${o.kind} -> ${n.kind}`] });
    } else if (o.signature !== n.signature) {
      const reasons = breakingReasons(o.kind, o.signature, n.signature);
      entries.push({
        name, change: 'changed', breaking: reasons.length > 0, kind: n.kind, old: o.signature, new: n.signature,
        reasons: reasons.length ? reasons : ['backwards-compatible signature change'],
      });
    }
  }
  for (const [name, n] of Object.entries(newApi)) if (!(name in oldApi)) added[name] = n;

  for (const { from, to } of detectRenames(removed, added)) {
    const r = removed[from];
    const a = added[to];
    if (!r || !a) continue;
    const sigChanged = r.signature !== a.signature;
    entries.push({
      name: from, change: 'renamed', breaking: true, kind: a.kind, old: r.signature, new: a.signature, renamedTo: to,
      reasons: [`renamed to "${to}"${sigChanged ? ' (signature also changed)' : ''}`],
    });
    removed = omit(removed, from);
    added = omit(added, to);
  }
  for (const [name, r] of Object.entries(removed)) {
    entries.push({ name, change: 'removed', breaking: true, kind: r.kind, old: r.signature, reasons: ['removed from the public API'] });
  }
  for (const [name, a] of Object.entries(added)) {
    entries.push({ name, change: 'added', breaking: false, kind: a.kind, new: a.signature, reasons: [] });
  }
  return entries.sort((x, y) => x.name.localeCompare(y.name));
}

export function summarize(entries: ApiChange[]): DiffSummary {
  const count = (pred: (e: ApiChange) => boolean): number => entries.filter(pred).length;
  return {
    total: entries.length,
    breaking: count((e) => e.breaking),
    added: count((e) => e.change === 'added'),
    removed: count((e) => e.change === 'removed'),
    renamed: count((e) => e.change === 'renamed'),
    changed: count((e) => e.change === 'changed'),
  };
}
