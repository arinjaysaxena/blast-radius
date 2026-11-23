import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { entryCandidates, extractPackage } from '../src/package.js';

const mkPkg = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'br-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), typeof c === 'string' ? c : JSON.stringify(c));
  }
  return dir;
};

test('entry candidates prefer exports types, then types, then main', () => {
  assert.equal(entryCandidates({ exports: { '.': { types: './dist/x.d.ts', import: './dist/x.js' } } })[0], 'dist/x.d.ts');
  assert.equal(entryCandidates({ exports: { '.': { import: './dist/x.js' } } })[0], 'dist/x.d.ts');
  assert.equal(entryCandidates({ types: 'lib/t.d.ts', main: 'lib/m.js' })[0], 'lib/t.d.ts');
  assert.equal(entryCandidates({ main: './lib/m.js' })[0], 'lib/m.d.ts');
  assert.equal(entryCandidates({ exports: './e.js' })[0], 'e.d.ts');
  assert.ok(entryCandidates({}).includes('index.d.ts'));
});

test('extracts a package through its types field, following relative imports', () => {
  const dir = mkPkg({
    'package.json': { name: 'demo', version: '1.2.3', types: 'dist/index.d.ts' },
    'dist/index.d.ts': "export * from './util.js'; export declare function main(a: number): string;",
    'dist/util.d.ts': 'export declare const LIMIT: number; export interface Opts { a: string }',
    'node_modules/dep/index.d.ts': 'export declare const nope: 1;',
  });
  const r = extractPackage(dir);
  assert.equal(r.name, 'demo');
  assert.equal(r.version, '1.2.3');
  assert.equal(r.entry, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(r.api), ['LIMIT', 'main', 'Opts']);
  assert.match(r.api.main.signature, /\(a: number\): string/);
});

test('falls back to index.d.ts and reports a clear error when nothing is found', () => {
  const ok = mkPkg({ 'package.json': { name: 'p' }, 'index.d.ts': 'export declare const a: 1;' });
  assert.deepEqual(Object.keys(extractPackage(ok).api), ['a']);
  const none = mkPkg({ 'package.json': { name: 'p' }, 'readme.md': 'x' });
  assert.throws(() => extractPackage(none), /Could not find type declarations for p/);
  assert.throws(() => extractPackage(mkdtempSync(join(tmpdir(), 'br-'))), /No package.json/);
});
