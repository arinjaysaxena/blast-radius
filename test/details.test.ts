import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import type { ApiSymbol } from '../src/model/types.js';
import { extractPackage } from '../src/extract/index.js';
import { sym } from './helpers.js';

const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', 'packages', name, '1.0.0');
const load = (name: string): Record<string, ApiSymbol> => extractPackage(fixture(name)).api;
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('expected a value');
  return v;
};

describe('aliases and re-exports', () => {
  const api = load('reexports');

  test('export *, renamed re-exports, namespace re-exports and default are all public names', () => {
    expect(Object.keys(api).sort()).toEqual(['Config', 'Figure', 'LIMIT', 'Shape', 'default', 'helpers', 'internalName', 'publicName'].sort());
  });

  test('aliases resolve to the kind of their target', () => {
    expect(sym(api, 'publicName').kind).toBe('function');
    expect(sym(api, 'Figure').kind).toBe('interface');
    expect(sym(api, 'default').kind).toBe('interface');
    expect(sym(api, 'helpers').kind).toBe('namespace');
    expect(sym(api, 'helpers').signature).toBe('namespace { pad: function; trim: function }');
  });

  test('qualified names use the public name', () => {
    expect(sym(api, 'publicName').qualifiedName).toBe('reexports#publicName');
    expect(sym(api, 'Figure').members?.[0]?.qualifiedName).toBe('reexports#Figure.area');
  });
});

describe('export =', () => {
  test('a function merged with a namespace exposes its call signature and namespace members', () => {
    const api = load('export-equals');
    const names = Object.keys(api);
    expect(names).toEqual(expect.arrayContaining(['version', 'helper', 'Options']));
    const eq = sym(api, 'export=');
    expect(eq.kind).toBe('function');
    expect(eq.signatures?.[0]?.text).toBe('(input: string): string');
  });
});

describe('symbol detail', () => {
  const api = load('detailed');

  test('overloads are separate signatures with parameter detail', () => {
    const sigs = need(sym(api, 'parse').signatures);
    expect(sigs).toHaveLength(2);
    expect(sigs[0]?.parameters).toEqual([
      { name: 'input', type: 'string', optional: false, rest: false },
      { name: 'strict', type: 'boolean | undefined', optional: true, rest: false },
    ]);
    expect(sigs[0]?.returnType).toBe('number');
    expect(sigs[1]?.parameters[1]).toEqual({ name: 'rest', type: 'string[]', optional: false, rest: true });
  });

  test('type parameters keep constraints and defaults', () => {
    const sig = need(sym(api, 'identity').signatures)[0];
    expect(sig?.typeParams).toEqual([{ name: 'T', constraint: 'object', default: '{}' }]);
    expect(sym(api, 'Store').typeParams).toEqual([{ name: 'K', constraint: 'string' }, { name: 'V', default: 'unknown' }]);
    expect(sym(api, 'Pair').typeParams).toEqual([{ name: 'A' }, { name: 'B', default: 'A' }]);
    expect(sym(api, 'Options').typeParams).toEqual([{ name: 'T' }]);
  });

  test('JSDoc @deprecated and @since are captured with their message', () => {
    expect(sym(api, 'parseLegacy').deprecated).toEqual({ message: 'Use {@link parse} instead.' });
    expect(sym(api, 'parse').deprecated).toBeUndefined();
    expect(sym(api, 'Store').since).toBe('2.1.0');
  });

  test('class members carry visibility, static, readonly and optional; private members are omitted', () => {
    const members = need(sym(api, 'Store').members);
    const by = (n: string, s = false) => members.find((m) => m.name === n && m.static === s);
    expect(by('name')).toMatchObject({ readonly: true, visibility: 'public', kind: 'property', qualifiedName: 'detailed#Store.name' });
    expect(by('cache')).toMatchObject({ visibility: 'protected' });
    expect(by('secret')).toBeUndefined();
    expect(by('get')).toMatchObject({ kind: 'method' });
    expect(by('size')).toMatchObject({ kind: 'accessor', readonly: true });
    expect(by('maybe')).toMatchObject({ optional: true });
    expect(by('create', true)).toMatchObject({ static: true, kind: 'method' });
    expect(by('fetch')?.deprecated).toEqual({ message: 'Use `get`.' });
    expect(by('get')?.deprecated).toBeUndefined();
  });

  test('class construct signatures are recorded as construct', () => {
    const sig = need(sym(api, 'Store').signatures)[0];
    expect(sig?.construct).toBe(true);
    expect(sig?.text).toBe('new <K extends string, V = unknown>(name: string): Store<K, V>');
  });

  test('interface members include methods and optional properties', () => {
    const members = need(sym(api, 'Options').members);
    expect(members.map((m) => [m.name, m.kind, m.optional])).toEqual([
      ['label', 'property', true],
      ['onDone', 'method', false],
      ['retries', 'property', false],
    ]);
  });

  test('enum members carry numeric and string values; const enums too', () => {
    expect(sym(api, 'Level').enumMembers).toEqual([
      { name: 'Debug', value: 0 },
      { name: 'Info', value: 1 },
      { name: 'Warn', value: 'warn' },
    ]);
    expect(sym(api, 'Flag').enumMembers).toEqual([{ name: 'A', value: 1 }, { name: 'B', value: 2 }]);
  });

  test('qualified names are absent when the package name is unknown', async () => {
    const { extractApi } = await import('../src/extract/index.js');
    expect(sym(extractApi('export const a: number = 1;'), 'a').qualifiedName).toBeUndefined();
    expect(sym(extractApi('export const a: number = 1;', {}, 'pkg'), 'a').qualifiedName).toBe('pkg#a');
  });
});
