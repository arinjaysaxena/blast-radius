import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSource, scanProject, mapChangesToSites, matchesPackage } from '../src/scan.js';
import { extractApi } from '../src/extract.js';
import { diffApi } from '../src/diff.js';

const syms = (sites) => sites.map((s) => `${s.symbol}@${s.line}:${s.kind}`);

test('named, aliased and default imports are tracked with line numbers', () => {
  const src = [
    "import def, { parse, fmt as format } from 'lib';",
    'const a = parse("x");',
    'format(a);',
    'def();',
    'const parse2 = { parse: 1 }; obj.parse();',
  ].join('\n');
  const s = scanSource('a.ts', src, 'lib');
  assert.deepEqual(syms(s), ['default@1:import', 'parse@1:import', 'fmt@1:import', 'parse@2:use', 'fmt@3:use', 'default@4:use']);
});

test('namespace imports resolve member access; subpath imports match', () => {
  const src = "import * as L from 'lib/sub';\nL.run(1);\nconst f = L.helper;\nuse(L);";
  assert.deepEqual(syms(scanSource('a.ts', src, 'lib')), ['run@2:use', 'helper@3:use', '*@4:use']);
  assert.ok(matchesPackage('lib/sub', 'lib'));
  assert.ok(!matchesPackage('library', 'lib'));
});

test('require forms: destructuring, property pick and whole module', () => {
  const src = "const { a, b: c } = require('lib');\nconst d = require('lib').d;\nconst m = require('lib');\na(); c(); d(); m.e();";
  const s = syms(scanSource('x.js', src, 'lib'));
  assert.deepEqual(s, ['a@1:import', 'b@1:import', 'd@2:import', 'a@4:use', 'b@4:use', 'd@4:use', 'e@4:use']);
});

test('files that do not import the package yield nothing; type-only and re-exports count', () => {
  assert.deepEqual(scanSource('a.ts', "import x from 'other'; x();", 'lib'), []);
  const s = scanSource('a.ts', "import type { Opts } from 'lib';\nexport { Thing } from 'lib';\nlet o: Opts;", 'lib');
  assert.deepEqual(syms(s), ['Opts@1:import', 'Thing@2:import', 'Opts@3:use']);
});

test('scanProject walks the tree, skips node_modules and maps diff entries to sites', () => {
  const root = mkdtempSync(join(tmpdir(), 'br-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules/lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules/lib/index.js'), "require('lib')");
  writeFileSync(join(root, 'src/a.ts'), "import { oldFn, stable } from 'lib';\noldFn(1);\nstable();\n");
  writeFileSync(join(root, 'src/b.tsx'), "import { oldFn } from 'lib';\nexport const x = () => oldFn(2);\n");
  writeFileSync(join(root, 'src/c.ts'), 'export const nothing = 1;\n');
  const sites = scanProject(root, 'lib');
  assert.deepEqual([...new Set(sites.map((s) => s.file))], ['src/a.ts', 'src/b.tsx']);

  const entries = diffApi(
    extractApi('export function oldFn(a: number): void {} export function stable(): void {} export function unused(): void {}'),
    extractApi('export function oldFn(a: string): void {} export function stable(): void {}'),
  );
  const { impacted, untouched, totalSites } = mapChangesToSites(entries, sites);
  assert.deepEqual(impacted.map((i) => i.entry.name), ['oldFn']);
  assert.deepEqual(impacted[0].sites.map((s) => `${s.file}:${s.line}`), ['src/a.ts:1', 'src/a.ts:2', 'src/b.tsx:1', 'src/b.tsx:2']);
  assert.deepEqual(untouched.map((e) => e.name), ['unused']);
  assert.equal(totalSites, 4);
});
