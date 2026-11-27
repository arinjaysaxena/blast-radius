import { describe, expect, test } from 'vitest';
import type { LoadedPackage } from '../src/extract/package.js';
import { diffPackages, pairRenames, scoreRename, type RenameCandidate } from '../src/diff/index.js';

const pkg = (index: string): LoadedPackage => ({ name: 'lib', version: '1.0.0', files: { '/index.d.ts': index }, entries: [{ subpath: '.', file: 'index.d.ts' }] });
const run = (a: string, b: string) => diffPackages(pkg(a), pkg(b));

describe('scoreRename', () => {
  const c = (name: string, shape: string, deprecation?: string): RenameCandidate => ({ name, kind: 'function', shape, ...(deprecation ? { deprecation } : {}) });

  test('identical shape and similar name scores high; unrelated shape scores zero', () => {
    expect(scoreRename(c('createClient', '(url: string): Client'), c('createClients', '(url: string): Client'))).toBeGreaterThan(0.7);
    expect(scoreRename(c('parse', '(a: string): number'), c('render', '(opts: Options, depth: number): HTMLElement'))).toBe(0);
  });

  test('a deprecation message naming the new symbol lifts a dissimilar name over the threshold', () => {
    const without = scoreRename(c('errors', 'ZodIssue[]'), c('issues', 'ZodIssue[]'));
    const withHint = scoreRename(c('errors', 'ZodIssue[]', 'Use issues instead'), c('issues', 'ZodIssue[]'));
    expect(without).toBeLessThan(0.6);
    expect(withHint).toBeGreaterThanOrEqual(0.6);
  });

  test('different kinds never pair', () => {
    expect(scoreRename(c('a', 'x'), { name: 'a', kind: 'class', shape: 'x' })).toBe(0);
  });

  test('pairing is one-to-one, best first', () => {
    const pairs = pairRenames([c('getUser', '(id: string): User')], [c('getUsers', '(id: string): User'), c('lookup', '(id: string): User')]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.to).toBe('getUsers');
  });
});

describe('rename detection in the diff', () => {
  test('a removed function with a near-identical added one is a rename with confidence', () => {
    const d = run('export declare function fetchUser(id: string): Promise<User>; export interface User { id: string }', 'export declare function fetchUsers(id: string): Promise<User>; export interface User { id: string }');
    const r = d.find((c) => c.name === 'fetchUser');
    expect(r).toMatchObject({ change: 'renamed', renamedTo: 'fetchUsers', breaking: true, rules: ['symbol-renamed'] });
    expect(r?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(d.some((c) => c.name === 'fetchUsers')).toBe(false);
  });

  test('member renames use the old @deprecated message as a hint', () => {
    const d = run(
      'export interface Issue { path: string }\nexport declare class ZodError {\n  /** @deprecated use issues */\n  errors: Issue[]\n}',
      'export interface Issue { path: string }\nexport declare class ZodError {\n  issues: Issue[]\n}',
    );
    expect(d.find((c) => c.name === 'ZodError.errors')).toMatchObject({ change: 'renamed', renamedTo: 'ZodError.issues', deprecated: 'use issues' });
  });

  test('unrelated removals and additions stay removed and added', () => {
    const d = run('export declare function alpha(a: string): void', 'export declare function omega(a: number, b: number): Promise<Map<string, string>>');
    expect(d.map((c) => [c.name, c.change])).toEqual([
      ['alpha', 'removed'],
      ['omega', 'added'],
    ]);
  });

  test('renames are matched within their own owner only', () => {
    const d = run('export declare class A { old(): string } export declare class B {}', 'export declare class A {} export declare class B { old2(): string }');
    expect(d.filter((c) => c.change === 'renamed')).toEqual([]);
  });
});
