// Attribute call sites to API changes.
import type { ApiChange, CallSite } from '../model/types.js';

export interface MappedChanges {
  impacted: { entry: ApiChange; sites: CallSite[] }[];
  untouched: ApiChange[];
  totalSites: number;
}

/**
 * Map diff entries onto call sites. Additions are ignored. Bare namespace uses ("*", e.g. passing
 * the whole module around) are not attributed to any symbol.
 */
export function mapChangesToSites(entries: ApiChange[], sites: CallSite[]): MappedChanges {
  const impacted: MappedChanges['impacted'] = [];
  const untouched: ApiChange[] = [];
  for (const entry of entries.filter((e) => e.change !== 'added')) {
    const exact = sites.filter((s) => s.symbol === entry.name);
    if (exact.length) impacted.push({ entry, sites: exact });
    else untouched.push(entry);
  }
  const unique = new Set(impacted.flatMap((i) => i.sites.map((s) => `${s.file}:${s.line}:${s.column}`)));
  return { impacted, untouched, totalSites: unique.size };
}
