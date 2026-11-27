// Markdown renderer, suitable for a PR comment.
import type { ApiChange, ImpactedSymbol, Report } from '../model/types.js';

const MAX_SITES = 10;

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const label = (c: Pick<ApiChange | ImpactedSymbol, 'breaking'>): string => (c.breaking ? 'breaking' : 'compatible');
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(`## Blast radius: ${report.package ? `${code(report.package)} ` : ''}${code(report.from)} → ${code(report.to)}`, '');
  if (!s.total) {
    out.push('No public API changes detected.');
    return `${out.join('\n')}\n`;
  }
  out.push(`${s.total} API ${plural(s.total, 'change')}: ${s.breaking} breaking, ${s.added} added, ${s.removed} removed, ${s.renamed} renamed, ${s.changed} changed.`);
  if (report.scanned) {
    out.push('', s.callSites
      ? `**${s.callSites} ${plural(s.callSites, 'place')} in your code touch${s.callSites === 1 ? 'es' : ''} changed APIs** (${s.impactedSymbols} ${plural(s.impactedSymbols, 'symbol')}).`
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
