import { describe, expect, test } from 'vitest';
import type { ApiChange } from '../src/model/types.js';
import type { LoadedPackage } from '../src/extract/package.js';
import { RULES, diffPackages, type RuleId } from '../src/diff/index.js';

const pkg = (index: string, extra: Record<string, string> = {}): LoadedPackage => ({
  name: 'lib',
  version: '1.0.0',
  files: { '/index.d.ts': index, ...extra },
  entries: [{ subpath: '.', file: 'index.d.ts' }],
});
const run = (a: string, b: string): ApiChange[] => diffPackages(pkg(a), pkg(b));
const find = (d: ApiChange[], name: string): ApiChange => {
  const c = d.find((x) => x.name === name);
  if (!c) throw new Error(`no change "${name}" in ${d.map((x) => x.name).join(', ')}`);
  return c;
};

/** One scenario per rule: [rule, old source, new source, change name, breaking?]. */
const SCENARIOS: [RuleId, string, string, string, boolean][] = [
  ['symbol-removed', 'export declare function f(): void', 'export declare const g: number', 'f', true],
  ['symbol-renamed', 'export declare function fetchUser(id: string): string', 'export declare function fetchUsers(id: string): string', 'fetchUser', true],
  ['kind-changed', 'export declare function f(): void', 'export declare const f: number', 'f', true],
  ['parameter-added-required', 'export declare function f(a: string): void', 'export declare function f(a: string, b: number): void', 'f', true],
  ['parameter-removed', 'export declare function f(a: string, b: number): void', 'export declare function f(a: string): void', 'f', true],
  ['parameter-now-required', 'export declare function f(a?: string): void', 'export declare function f(a: string): void', 'f', true],
  ['parameter-type-narrowed', 'export declare function f(a: string | number): void', 'export declare function f(a: string): void', 'f', true],
  ['return-type-widened', 'export declare function f(): string', 'export declare function f(): string | undefined', 'f', true],
  [
    'overload-removed',
    'export declare function f(a: string): void; export declare function f(a: number): void',
    'export declare function f(a: string): void',
    'f',
    true,
  ],
  ['constraint-tightened', 'export declare function f<T>(a: T): T', 'export declare function f<T extends object>(a: T): T', 'f', true],
  ['type-parameter-added', 'export declare function f<T>(a: T): T', 'export declare function f<T, U>(a: T): T', 'f', true],
  ['member-removed', 'export declare class C { a(): void; b(): void }', 'export declare class C { a(): void }', 'C.b', true],
  ['member-required', 'export interface O { a: string; b?: number }', 'export interface O { a: string; b: number }', 'O.b', true],
  ['member-optional', 'export declare class C { a: string }', 'export declare class C { a?: string }', 'C.a', true],
  ['member-type-changed', 'export declare class C { a: string }', 'export declare class C { a: string | number }', 'C.a', true],
  ['member-readonly', 'export interface O { a: string }', 'export interface O { readonly a: string }', 'O.a', true],
  ['enum-member-removed', 'export enum E { A, B }', 'export enum E { A }', 'E', true],
  ['enum-value-changed', 'export enum E { A = 1 }', 'export enum E { A = 2 }', 'E', true],
  ['type-changed', 'export type Id = string | number', 'export type Id = string', 'Id', true],
  ['deprecated', 'export declare function f(): void', '/** @deprecated use g */ export declare function f(): void', 'f', false],
];

describe('compatibility rules table', () => {
  test.each(SCENARIOS)('%s', (rule, a, b, name, breaking) => {
    const c = find(run(a, b), name);
    expect(c.rules).toContain(rule);
    expect(c.breaking).toBe(breaking);
  });

  test('the scenarios cover every rule', () => {
    expect(new Set(SCENARIOS.map((s) => s[0]))).toEqual(new Set(RULES));
  });
});

describe('compatible changes are not breaking', () => {
  test.each([
    ['optional parameter added', 'export declare function f(a: string): void', 'export declare function f(a: string, b?: number): void'],
    ['parameter widened', 'export declare function f(a: string): void', 'export declare function f(a: string | number): void'],
    ['return narrowed', 'export declare function f(): string | number', 'export declare function f(): string'],
    ['overload added', 'export declare function f(a: string): void', 'export declare function f(a: string): void; export declare function f(a: number): void'],
    ['enum member added', 'export enum E { A }', 'export enum E { A, B }'],
    ['class gains a method', 'export declare class C { a(): void }', 'export declare class C { a(): void; b(): void }'],
    ['interface gains optional member', 'export interface O { a: string }', 'export interface O { a: string; b?: number }'],
    ['constraint loosened', 'export declare function f<T extends object>(a: T): T', 'export declare function f<T>(a: T): T'],
    ['type parameter added with default', 'export declare function f<T>(a: T): T', 'export declare function f<T, U = T>(a: T): T'],
    ['rest parameter replaces tail', 'export declare function f(a: string, b: string): void', 'export declare function f(a: string, ...rest: string[]): void'],
  ])('%s', (_label, a, b) => {
    expect(run(a, b).filter((c) => c.breaking)).toEqual([]);
  });
});

describe('variance', () => {
  const sigIn = 'export declare function take(o: Opts): void';
  const sigOut = 'export declare function make(): Opts';

  test('an input-only interface breaks when a required member is added or a member becomes required', () => {
    const d = run(`export interface Opts { a: string; b?: number } ${sigIn}`, `export interface Opts { a: string; b?: number; c: boolean } ${sigIn}`);
    expect(find(d, 'Opts.c').breaking).toBe(true);
    const r = run(`export interface Opts { a?: string } ${sigIn}`, `export interface Opts { a: string } ${sigIn}`);
    expect(find(r, 'Opts.a').rules).toContain('member-required');
  });

  test('an output-only interface is not broken by added required members, but is by optional ones', () => {
    const added = run(`export interface Opts { a: string } ${sigOut}`, `export interface Opts { a: string; c: boolean } ${sigOut}`);
    expect(added.filter((c) => c.breaking)).toEqual([]);
    const optional = run(`export interface Opts { a: string } ${sigOut}`, `export interface Opts { a?: string } ${sigOut}`);
    expect(find(optional, 'Opts.a').rules).toContain('member-optional');
    const loose = run(`export interface Opts { a?: string } ${sigOut}`, `export interface Opts { a: string } ${sigOut}`);
    expect(loose.filter((c) => c.breaking)).toEqual([]);
  });

  test('member types are judged by direction', () => {
    const widened = run(`export interface Opts { a: string } ${sigIn}`, `export interface Opts { a: string | number } ${sigIn}`);
    expect(widened.filter((c) => c.breaking)).toEqual([]);
    const widenedOut = run(`export interface Opts { a: string } ${sigOut}`, `export interface Opts { a: string | number } ${sigOut}`);
    expect(find(widenedOut, 'Opts.a').breaking).toBe(true);
  });

  test('callback parameters flip direction', () => {
    const cb = 'export declare function on(cb: (e: Ev) => void): void';
    const d = run(`export interface Ev { a: string } ${cb}`, `export interface Ev { a: string; b: number } ${cb}`);
    expect(d.filter((c) => c.breaking)).toEqual([]); // the library supplies Ev to the callback: output position
  });
});

describe('details', () => {
  test('deprecation carries the message and does not break', () => {
    const c = find(run('export declare class Z { email(): void }', 'export declare class Z {\n  /** @deprecated use z.email() */\n  email(): void\n}'), 'Z.email');
    expect(c).toMatchObject({ breaking: false, deprecated: 'use z.email()', rules: ['deprecated'] });
  });

  test('subpath modules are prefixed and compared independently', () => {
    const mk = (sub: string): LoadedPackage => ({
      name: 'lib',
      version: '1.0.0',
      files: { '/index.d.ts': 'export declare const a: 1', '/sub.d.ts': sub },
      entries: [
        { subpath: '.', file: 'index.d.ts' },
        { subpath: './sub', file: 'sub.d.ts' },
      ],
    });
    const d = diffPackages(mk('export declare function s(a: string): void'), mk('export declare function s(a: number): void'));
    expect(find(d, './sub#s')).toMatchObject({ breaking: true, rules: ['parameter-type-narrowed'] });
  });

  test('generic signatures that change only their own parameter names are compatible', () => {
    const d = run('export declare function id<T>(a: T): T', 'export declare function id<U>(a: U): U');
    expect(d.filter((c) => c.breaking)).toEqual([]);
  });

  test('class constructor changes are reported on the class', () => {
    const d = run('export declare class C { constructor(a: string) }', 'export declare class C { constructor(a: string, b: number) }');
    expect(find(d, 'C').reasons[0]).toMatch(/^constructor: required parameter "b" added/);
  });

  test('static members and unchanged symbols', () => {
    const d = run('export declare class C { static make(): C; x: number }', 'export declare class C { x: number }');
    expect(find(d, 'C.static make').rules).toEqual(['member-removed']);
    expect(d.find((c) => c.name === 'C.x')).toBeUndefined();
  });
});
