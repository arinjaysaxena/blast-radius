// Report builders: a plain JSON model plus Markdown and JSON renderers.
import { summarize } from './diff.js';
import { mapChangesToSites } from './scan.js';

/**
 * Combine diff entries and call sites into one report object.
 * `meta` is { oldLabel, newLabel, pkg }. `sites` may be empty when no project was scanned.
 */
export function buildReport(entries, sites, meta = {}) {
  const mapped = mapChangesToSites(entries, sites);
  return {
    package: meta.pkg ?? null,
    from: meta.oldLabel ?? 'old',
    to: meta.newLabel ?? 'new',
    scanned: Boolean(meta.scanned),
    summary: { ...summarize(entries), impactedSymbols: mapped.impacted.length, callSites: mapped.totalSites },
    changes: entries,
    impacted: mapped.impacted.map(({ entry, sites: s }) => ({
      name: entry.name, change: entry.change, breaking: entry.breaking, renamedTo: entry.renamedTo ?? null, reasons: entry.reasons,
      sites: s.map((x) => ({ file: x.file, line: x.line, column: x.column, kind: x.kind })),
    })),
    untouched: mapped.untouched.map((e) => e.name),
  };
}

export const renderJson = (report) => `${JSON.stringify(report, null, 2)}\n`;

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const MAX_SITES = 10;

const label = (c) => (c.breaking ? 'breaking' : 'compatible');

/** Markdown report, suitable for a PR comment. */
export function renderMarkdown(report) {
  const s = report.summary;
  const out = [];
  out.push(`## Blast radius: ${report.package ? `${code(report.package)} ` : ''}${code(report.from)} → ${code(report.to)}`, '');
  if (!s.total) {
    out.push('No public API changes detected.');
    return `${out.join('\n')}\n`;
  }
  out.push(`${s.total} API change${s.total === 1 ? '' : 's'}: ${s.breaking} breaking, ${s.added} added, ${s.removed} removed, ${s.renamed} renamed, ${s.changed} changed.`);
  if (report.scanned) {
    out.push('', s.callSites
      ? `**${s.callSites} place${s.callSites === 1 ? '' : 's'} in your code touch${s.callSites === 1 ? 'es' : ''} changed APIs** (${s.impactedSymbols} symbol${s.impactedSymbols === 1 ? '' : 's'}).`
      : 'None of your call sites use a changed API.');
  }
  if (report.impacted.length) {
    out.push('', '### Affected call sites');
    for (const i of report.impacted) {
      out.push('', `#### ${code(i.name)} (${i.change}, ${label(i)})`);
      for (const r of i.reasons) out.push(`- ${r}`);
      for (const site of i.sites.slice(0, MAX_SITES)) out.push(`- ${code(`${site.file}:${site.line}`)}`);
      if (i.sites.length > MAX_SITES) out.push(`- … and ${i.sites.length - MAX_SITES} more`);
    }
  }
  out.push('', '### All API changes', '', '| Symbol | Change | Impact | Detail |', '| --- | --- | --- | --- |');
  for (const c of report.changes) {
    const detail = c.reasons.length ? c.reasons.join('; ') : c.change === 'added' ? 'new export' : '';
    out.push(`| ${code(c.name)} | ${c.change} | ${label(c)} | ${detail.replace(/\|/g, '\\|')} |`);
  }
  return `${out.join('\n')}\n`;
}
