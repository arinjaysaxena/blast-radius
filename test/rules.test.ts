import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakingReasons, detectRenames, parseMembers, splitTopLevel } from '../src/diff/index.js';
import { extractPackage } from '../src/extract/index.js';
import { tmpDir } from './helpers.js';

test('splitTopLevel ignores separators nested in brackets and arrows', () => {
  assert.deepEqual(splitTopLevel('a: Map<string, number>, b: (x: 1, y: 2) => void, c: [1, 2]', ','), [
    'a: Map<string, number>',
    'b: (x: 1, y: 2) => void',
    'c: [1, 2]',
  ]);
});

test('parseMembers separates the constructor prefix from members', () => {
  const shape = parseMembers('new (a: number) { x: string; y?: number; static z: 1 }');
  assert.ok(shape);
  assert.equal(shape.ctor, 'new (a: number)');
  assert.deepEqual([...shape.members.keys()], ['x', 'y', 'static z']);
  assert.equal(shape.members.get('y')?.optional, true);
  assert.equal(parseMembers('string'), null);
});

test('enum rule: removal and value change break, addition does not', () => {
  const old = 'enum { A=0; B=1; C=2 }';
  assert.deepEqual(breakingReasons('enum', old, 'enum { A=0; B=1; C=2; D=3 }'), []);
  assert.deepEqual(breakingReasons('enum', old, 'enum { A=0; B=5 }'), ['enum member "B" value changed: 1 -> 5', 'enum member "C" removed']);
});

test('overload rule: removing an overload is reported, adding one is not', () => {
  const both = '(a: string): string | (a: number): number';
  assert.deepEqual(breakingReasons('function', both, '(a: string): string'), ['overload no longer available: (a: number): number']);
  assert.deepEqual(breakingReasons('function', '(a: string): string', both), []);
});

test('non-callable kinds report a generic type change', () => {
  assert.deepEqual(breakingReasons('variable', 'string', 'number'), ['type changed']);
});

test('rename detection is one-to-one and respects kind', () => {
  const removed = { getUser: { kind: 'function' as const, signature: '(id: string): User' } };
  const added = {
    fetchUser: { kind: 'function' as const, signature: '(id: string): User' },
    getUsers: { kind: 'variable' as const, signature: 'string' },
  };
  assert.deepEqual(detectRenames(removed, added).map((p) => [p.from, p.to]), [['getUser', 'fetchUser']]);
  assert.deepEqual(detectRenames(removed, { getUsers: added.getUsers }), []);
});

test('extractPackage reports malformed package.json clearly', () => {
  const dir = tmpDir('br-badpkg-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ nope');
  assert.throws(() => extractPackage(dir), /Invalid package\.json/);
});
