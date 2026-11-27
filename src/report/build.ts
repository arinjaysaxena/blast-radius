// Combine diff entries and call sites into one report object.
import { summarize } from '../diff/diff.js';
import type { ApiChange, CallSite, Report } from '../model/types.js';
import { mapChangesToSites } from '../usage/map.js';

export interface ReportMeta {
  pkg?: string | null;
  oldLabel?: string;
  newLabel?: string;
  scanned?: boolean;
}

/** `sites` may be empty when no project was scanned. */
export function buildReport(entries: ApiChange[], sites: CallSite[], meta: ReportMeta = {}): Report {
  const mapped = mapChangesToSites(entries, sites);
  return {
    package: meta.pkg ?? null,
    from: meta.oldLabel ?? 'old',
    to: meta.newLabel ?? 'new',
    scanned: Boolean(meta.scanned),
    summary: { ...summarize(entries), impactedSymbols: mapped.impacted.length, callSites: mapped.totalSites },
    changes: entries,
    impacted: mapped.impacted.map(({ entry, sites: s }) => ({
      name: entry.name,
      change: entry.change,
      breaking: entry.breaking,
      renamedTo: entry.renamedTo ?? null,
      reasons: entry.reasons,
      sites: s.map((x) => ({ file: x.file, line: x.line, column: x.column, kind: x.kind })),
    })),
    untouched: mapped.untouched.map((e) => e.name),
  };
}
