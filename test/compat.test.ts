import { describe, expect, test } from 'vitest';
import ts from 'typescript';
import { VersionPair, hasAssignability } from '../src/diff/compat.js';
import type { LoadedPackage } from '../src/extract/package.js';

const pkg = (index: string, name = 'lib'): LoadedPackage => ({
  name,
  version: '1.0.0',
  files: { '/index.d.ts': index },
  entries: [{ subpath: '.', file: 'index.d.ts' }],
});

const typeOf = (p: VersionPair, side: 'old' | 'new', name: string): ts.Type => {
  const sym = p.exportsOf(side, 'index.d.ts').get(name);
  if (!sym) throw new Error(`no export ${name}`);
  return p.checker.getDeclaredTypeOfSymbol(sym);
};

describe('VersionPair', () => {
  test('guard: the installed TypeScript exposes checker.isTypeAssignableTo', () => {
    const p = new VersionPair(pkg('export interface A { a: number }'), pkg('export interface A { a: number }'));
    expect(hasAssignability(p.checker)).toBe(true);
    // A failure here means a TypeScript upgrade removed or renamed the API: update the seam in compat.ts.
    expect(p.assignable(typeOf(p, 'old', 'A'), typeOf(p, 'new', 'A'))).toBe(true);
  });

  test('loads both versions under synthetic roots', () => {
    const p = new VersionPair(pkg('export declare const x: 1'), pkg('export declare const x: 2'));
    expect(p.program.getSourceFile('/__old__/node_modules/lib/index.d.ts')).toBeDefined();
    expect(p.program.getSourceFile('/__new__/node_modules/lib/index.d.ts')).toBeDefined();
    expect([...p.exportsOf('old', 'index.d.ts').keys()]).toEqual(['x']);
  });

  test('relates types across versions structurally', () => {
    const p = new VersionPair(
      pkg('export interface Opts { a: string; b?: number } export type Id = string'),
      pkg('export interface Opts { a: string; b?: number; c?: boolean } export type Id = string | number'),
    );
    expect(p.assignable(typeOf(p, 'old', 'Opts'), typeOf(p, 'new', 'Opts'))).toBe(true);
    expect(p.assignable(typeOf(p, 'new', 'Opts'), typeOf(p, 'old', 'Opts'))).toBe(true); // extra optional member is fine
    expect(p.assignable(typeOf(p, 'old', 'Id'), typeOf(p, 'new', 'Id'))).toBe(true);
    expect(p.assignable(typeOf(p, 'new', 'Id'), typeOf(p, 'old', 'Id'))).toBe(false);
  });

  test('resolves relative imports and export= inside one side only', () => {
    const a: LoadedPackage = { ...pkg("export * from './core'"), files: { '/index.d.ts': "export * from './core'", '/core.d.ts': 'export declare const v: number' } };
    const b: LoadedPackage = { ...pkg("export * from './core'"), files: { '/index.d.ts': "export * from './core'", '/core.d.ts': 'export declare const v: string' } };
    const p = new VersionPair(a, b);
    const ov = p.exportsOf('old', 'index.d.ts').get('v');
    const nv = p.exportsOf('new', 'index.d.ts').get('v');
    expect(p.text(p.checker.getTypeOfSymbol(ov as ts.Symbol))).toBe('number');
    expect(p.text(p.checker.getTypeOfSymbol(nv as ts.Symbol))).toBe('string');
  });
});
