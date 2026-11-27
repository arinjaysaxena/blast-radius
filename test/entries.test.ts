import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { applyTypesVersions, declarationCandidates, resolveEntries, resolveTarget, satisfiesTsRange } from '../src/extract/entries.js';
import { extractPackage } from '../src/extract/index.js';

const fixture = (name: string, version = '1.0.0'): string => join(import.meta.dirname, 'fixtures', 'packages', name, version);
const set = (...f: string[]): Set<string> => new Set(f);

describe('resolveTarget', () => {
  test('walks conditions in object order and nested conditions', () => {
    expect(resolveTarget('./a.js')).toBe('./a.js');
    expect(resolveTarget({ import: { types: './t.d.ts', default: './i.js' }, require: './r.cjs' })).toBe('./t.d.ts');
    expect(resolveTarget({ browser: './b.js', default: './d.js' })).toBe('./d.js');
    expect(resolveTarget({ require: './r.cjs', import: './i.mjs' })).toBe('./r.cjs');
    expect(resolveTarget(['./first.js', './second.js'])).toBe('./first.js');
    expect(resolveTarget(null)).toBeNull();
    expect(resolveTarget({ browser: './only-browser.js' })).toBeNull();
  });
});

describe('declarationCandidates', () => {
  test('maps runtime extensions to declaration siblings', () => {
    expect(declarationCandidates('./dist/x.js')).toEqual(['dist/x.d.ts', 'dist/x.ts', 'dist/x.tsx']);
    expect(declarationCandidates('x.mjs')).toEqual(['x.d.mts', 'x.mts']);
    expect(declarationCandidates('x.cjs')).toEqual(['x.d.cts', 'x.cts']);
    expect(declarationCandidates('x.d.ts')).toEqual(['x.d.ts']);
    expect(declarationCandidates('lib/x')).toEqual(['lib/x.d.ts', 'lib/x.ts', 'lib/x/index.d.ts']);
  });
});

describe('typesVersions', () => {
  test('range matching', () => {
    expect(satisfiesTsRange('>=4.0', '5.6.3')).toBe(true);
    expect(satisfiesTsRange('<4.0', '5.6.3')).toBe(false);
    expect(satisfiesTsRange('>=4.1 <5.0', '4.5.0')).toBe(true);
    expect(satisfiesTsRange('>=4.1 <5.0', '5.0.0')).toBe(false);
    expect(satisfiesTsRange('*', '1.0.0')).toBe(true);
    expect(satisfiesTsRange('>4.5', '4.5.0')).toBe(false);
    expect(satisfiesTsRange('not-a-range', '5.0.0')).toBe(false);
  });

  test('picks the first satisfied block and the longest matching pattern', () => {
    const pkg = { typesVersions: { '>=4.0': { 'sub/*': ['v4/sub/*'], '*': ['v4/*'], exact: ['v4/e.d.ts'] } } };
    expect(applyTypesVersions(pkg, 'sub/a.d.ts', '5.0.0')).toEqual(['v4/sub/a.d.ts']);
    expect(applyTypesVersions(pkg, 'other.d.ts', '5.0.0')).toEqual(['v4/other.d.ts']);
    expect(applyTypesVersions(pkg, 'exact', '5.0.0')).toEqual(['v4/e.d.ts']);
    expect(applyTypesVersions(pkg, 'x.d.ts', '3.0.0')).toEqual([]);
    expect(applyTypesVersions({}, 'x.d.ts')).toEqual([]);
  });
});

describe('resolveEntries', () => {
  test('one entry per subpath export, root first, nulls blocked', () => {
    const files = set('dist/index.d.ts', 'dist/utils.d.ts', 'dist/internal/secret.d.ts');
    const pkg = {
      exports: { './utils': { types: './dist/utils.d.ts' }, '.': './dist/index.js', './internal/*': null, './missing': './dist/gone.js' },
    };
    expect(resolveEntries(pkg, files)).toEqual([
      { subpath: '.', file: 'dist/index.d.ts' },
      { subpath: './utils', file: 'dist/utils.d.ts' },
    ]);
  });

  test('sugar form: exports as a string or condition object means the root only', () => {
    expect(resolveEntries({ exports: './i.js' }, set('i.d.ts'))).toEqual([{ subpath: '.', file: 'i.d.ts' }]);
    expect(resolveEntries({ exports: { import: './i.mjs', require: './i.cjs' } }, set('i.d.mts'))).toEqual([{ subpath: '.', file: 'i.d.mts' }]);
  });

  test('falls back from exports to types, main and index.d.ts', () => {
    expect(resolveEntries({ exports: { '.': './gone.js' }, types: 'a.d.ts' }, set('a.d.ts'))[0]?.file).toBe('a.d.ts');
    expect(resolveEntries({ typings: 't.d.ts' }, set('t.d.ts'))[0]?.file).toBe('t.d.ts');
    expect(resolveEntries({ main: './lib/m.js' }, set('lib/m.d.ts'))[0]?.file).toBe('lib/m.d.ts');
    expect(resolveEntries({ main: 'lib' }, set('lib/index.d.ts', 'index.d.ts'))[0]?.file).toBe('lib/index.d.ts');
    expect(resolveEntries({}, set('index.d.ts'))[0]?.file).toBe('index.d.ts');
    expect(resolveEntries({}, set('readme.d.ts'))).toEqual([]);
  });

  test('pattern exports expand against existing files, skipping nested node_modules', () => {
    const files = set('lib/f/a.d.ts', 'lib/f/b.d.ts', 'lib/f/node_modules/x/y.d.ts', 'lib/other.d.ts');
    const got = resolveEntries({ exports: { './f/*': './lib/f/*.js' } }, files).map((e) => e.subpath);
    expect(got).toEqual(['./f/a', './f/b']);
  });

  test('typesVersions redirects the root types path', () => {
    const pkg = { types: 'index.d.ts', typesVersions: { '>=4.0': { '*': ['ts4/*'] } } };
    expect(resolveEntries(pkg, set('index.d.ts', 'ts4/index.d.ts'), '5.0.0')[0]?.file).toBe('ts4/index.d.ts');
    expect(resolveEntries(pkg, set('index.d.ts', 'ts4/index.d.ts'), '3.9.0')[0]?.file).toBe('index.d.ts');
  });
});

describe('fixture packages', () => {
  test('exports with conditions: every subpath is its own module', () => {
    const p = extractPackage(fixture('exports-conditions'));
    expect(p.modules.map((m) => [m.subpath, m.entry])).toEqual([
      ['.', 'dist/index.d.ts'],
      ['./utils', 'dist/utils.d.ts'],
    ]);
    expect(Object.keys(p.modules[0]?.api ?? {})).toEqual(['create', 'Widget']);
    expect(Object.keys(p.modules[1]?.api ?? {})).toEqual(['slug']);
    expect(Object.keys(p.api)).toEqual(['create', 'Widget']);
  });

  test('pattern exports', () => {
    const p = extractPackage(fixture('exports-patterns'));
    expect(p.modules.map((m) => m.subpath)).toEqual(['.', './features/alpha', './features/beta']);
    expect(Object.keys(p.modules[2]?.api ?? {})).toEqual(['beta']);
  });

  test('typesVersions chooses the declaration tree for the running TypeScript', () => {
    const p = extractPackage(fixture('types-versions'));
    expect(Object.keys(p.api)).toEqual(['modern']);
    expect(p.entry).toBe('types/modern/types/legacy/index.d.ts');
  });

  test('main with a sibling .d.ts', () => {
    const p = extractPackage(fixture('main-sibling'));
    expect(p.entry).toBe('lib/main.d.ts');
    expect(Object.keys(p.api)).toEqual(['answer']);
  });
});
