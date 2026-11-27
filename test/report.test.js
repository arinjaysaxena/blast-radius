import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown, renderJson } from '../src/report.js';
import { extractApi } from '../src/extract.js';
import { diffApi } from '../src/diff.js';
import { scanSource } from '../src/scan.js';

const oldApi = extractApi('export function parse(s: string): number;\nexport function gone(): void;\nexport const keep: number;');
const newApi = extractApi('export function parse(s: string, strict: boolean): number;\nexport const keep: number;\nexport function fresh(): void;');
const entries = diffApi(oldApi, newApi);
const sites = [
  ...scanSource('src/a.ts', "import { parse, gone } from 'lib';\nparse('x');\ngone();", 'lib'),
  ...scanSource('src/b.ts', "import { parse } from 'lib';\nparse('y');", 'lib'),
];

test('buildReport counts impacted symbols and call sites', () => {
  const r = buildReport(entries, sites, { pkg: 'lib', oldLabel: '1.0.0', newLabel: '2.0.0', scanned: true });
  assert.equal(r.summary.breaking, 2);
  assert.equal(r.summary.impactedSymbols, 2);
  assert.ok(r.summary.callSites >= 5);
  assert.deepEqual(r.impacted.map((i) => i.name), ['gone', 'parse']);
  assert.deepEqual(r.untouched, []);
  assert.deepEqual(JSON.parse(renderJson(r)).summary, r.summary);
});

test('renderMarkdown lists call sites and all changes', () => {
  const md = renderMarkdown(buildReport(entries, sites, { pkg: 'lib', oldLabel: '1.0.0', newLabel: '2.0.0', scanned: true }));
  assert.match(md, /## Blast radius: `lib` `1\.0\.0` → `2\.0\.0`/);
  assert.match(md, /places in your code touch changed APIs/);
  assert.match(md, /`src\/b\.ts:2`/);
  assert.match(md, /\| `fresh` \| added \| compatible \| new export \|/);
});

test('renderMarkdown handles no changes, no scan and site truncation', () => {
  assert.match(renderMarkdown(buildReport([], [], {})), /No public API changes detected/);
  const noScan = renderMarkdown(buildReport(entries, [], { scanned: false }));
  assert.doesNotMatch(noScan, /your code/);
  const many = Array.from({ length: 13 }, (_, i) => ({ symbol: 'parse', file: 'f.ts', line: i + 1, column: 1, kind: 'use' }));
  assert.match(renderMarkdown(buildReport(entries, many, { scanned: true })), /and 3 more/);
});
