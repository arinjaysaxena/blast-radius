import { test } from 'vitest';
import assert from 'node:assert/strict';
import { extractApi } from '../src/extract.js';
import { diffApi, summarize, splitOverloads, parseCallSignature, nameSimilarity } from '../src/diff.js';

const diff = (a, b) => diffApi(extractApi(a), extractApi(b));
const one = (entries, name) => entries.find((e) => e.name === name);

test('added, removed and unchanged symbols', () => {
  const d = diff('export const a = 1; export function gone(): void {}', 'export const a = 1; export function fresh(x: number, y: string[]): Promise<void> { return null as any }');
  assert.equal(one(d, 'fresh').change, 'added');
  assert.equal(one(d, 'fresh').breaking, false);
  assert.equal(one(d, 'gone').change, 'removed');
  assert.equal(one(d, 'gone').breaking, true);
  assert.equal(one(d, 'a'), undefined);
});

test('function changes: optional param added is safe, required param or type change breaks', () => {
  const base = 'export function f(a: string): number { return 1 }';
  assert.equal(one(diff(base, 'export function f(a: string, b?: number): number { return 1 }'), 'f').breaking, false);
  const req = one(diff(base, 'export function f(a: string, b: number): number { return 1 }'), 'f');
  assert.equal(req.breaking, true);
  assert.match(req.reasons[0], /required parameter "b" added/);
  assert.match(one(diff(base, 'export function f(a: number): number { return 1 }'), 'f').reasons[0], /parameter "a" type changed/);
  assert.match(one(diff(base, 'export function f(a: string): string { return "" }'), 'f').reasons[0], /return type changed/);
  assert.match(one(diff(base, 'export function f(): number { return 1 }'), 'f').reasons[0], /"a" removed/);
});

test('added overload is non-breaking', () => {
  const d = diff(
    'export function p(a: string): number; export function p(a: any): number { return 0 }',
    'export function p(a: string): number; export function p(a: number): number; export function p(a: any): number { return 0 }',
  );
  assert.equal(one(d, 'p').breaking, false);
});

test('interface and class member changes', () => {
  const d = diff(
    'export interface O { a: number; b?: string } export class C { x(): void {} y(): void {} }',
    'export interface O { a: string; c: number } export class C { x(): void {} z(): void {} }',
  );
  const o = one(d, 'O');
  assert.ok(o.breaking);
  assert.ok(o.reasons.some((r) => /"a" type changed/.test(r)));
  assert.ok(o.reasons.some((r) => /"b" removed/.test(r)));
  assert.ok(o.reasons.some((r) => /required member "c" added/.test(r)));
  const c = one(d, 'C');
  assert.deepEqual(c.reasons, ['member "y" removed']); // adding z to a class is fine
  assert.equal(one(diff('export interface O { a: number }', 'export interface O { a: number; b?: string }'), 'O').breaking, false);
});

test('enum member removal and value change break; additions do not', () => {
  assert.equal(one(diff('export enum E { A, B }', 'export enum E { A, B, C }'), 'E').breaking, false);
  assert.match(one(diff('export enum E { A, B }', 'export enum E { A }'), 'E').reasons[0], /"B" removed/);
  assert.match(one(diff('export enum E { A = 1 }', 'export enum E { A = 2 }'), 'E').reasons[0], /value changed/);
});

test('kind change is breaking; type alias change is breaking', () => {
  assert.match(one(diff('export const x: number = 1', 'export function x(): number { return 1 }'), 'x').reasons[0], /kind changed/);
  assert.equal(one(diff('export type T = string', 'export type T = string | number'), 'T').breaking, true);
});

test('rename detection pairs identical signatures with similar names, one-to-one', () => {
  const d = diff(
    'export function getUserById(id: string): Promise<string> { return null as any } export function other(): void {}',
    'export function fetchUserById(id: string): Promise<string> { return null as any } export function other(): void {}',
  );
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].name, d[0].change, d[0].renamedTo], ['getUserById', 'renamed', 'fetchUserById']);
  // unrelated removal + addition must not be paired
  const e = diff('export function alpha(a: string): void {}', 'export function zzzzzz(a: string): void {}');
  assert.deepEqual(e.map((x) => x.change).sort(), ['added', 'removed']);
});

test('summarize counts', () => {
  const d = diff('export const a = 1; export function f(a: string): void {}', 'export function f(a: number): void {} export const b = 2');
  assert.deepEqual(summarize(d), { total: 3, breaking: 2, added: 1, removed: 1, renamed: 0, changed: 1 });
});

test('helpers', () => {
  assert.deepEqual(splitOverloads('(a: string): string | number | (b: 1): 2'), ['(a: string): string | number', '(b: 1): 2']);
  const p = parseCallSignature('<T>(a: T, ...rest: number[], c?: Map<string, T>): void');
  assert.deepEqual(p.params.map((x) => [x.name, x.optional, x.rest]), [['a', false, false], ['rest', true, true], ['c', true, false]]);
  assert.ok(nameSimilarity('getUser', 'GetUser') === 1);
});
