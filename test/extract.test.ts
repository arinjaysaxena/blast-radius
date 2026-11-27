import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sym } from './helpers.js';
import { extractApi } from '../src/extract/index.js';

test('extracts function signatures with overloads', () => {
  const api = extractApi(`
    export function parse(input: string, strict?: boolean): number;
    export function parse(input: number): number;
    export function parse(input: any): number { return 0; }
  `);
  assert.equal(sym(api, 'parse').kind, 'function');
  assert.match(sym(api, 'parse').signature, /\(input: string, strict\?: boolean\): number/);
  assert.match(sym(api, 'parse').signature, /\(input: number\): number/);
});

test('extracts variables, enums, type aliases and interfaces', () => {
  const api = extractApi(`
    export const VERSION: string = "1";
    export enum Mode { A, B }
    export type Id = string | number;
    export interface Opts { retries: number; name?: string }
  `);
  assert.deepEqual(Object.keys(api), ['Id', 'Mode', 'Opts', 'VERSION']);
  assert.equal(sym(api, 'VERSION').kind, 'variable');
  assert.equal(sym(api, 'Mode').kind, 'enum');
  assert.equal(sym(api, 'Id').signature, 'string | number');
  assert.match(sym(api, 'Opts').signature, /retries: number/);
  assert.match(sym(api, 'Opts').signature, /name\?: string/);
});

test('extracts class constructor and members', () => {
  const api = extractApi('export class Client { constructor(url: string) {} get(path: string): Promise<string> { return null as any; } }');
  assert.equal(sym(api, 'Client').kind, 'class');
  assert.match(sym(api, 'Client').signature, /new \(url: string\)/);
  assert.match(sym(api, 'Client').signature, /get: \(path: string\) => Promise<string>/);
});

test('follows re-exports from other modules and ignores non-exports', () => {
  const api = extractApi(`export { helper } from './util'; export * from './more'; const hidden = 1;`, {
    '/util.ts': 'export function helper(x: number): string { return ""; }',
    '/more.ts': 'export const extra: boolean = true;',
  });
  assert.deepEqual(Object.keys(api), ['extra', 'helper']);
  assert.equal(sym(api, 'helper').kind, 'function');
  assert.equal(sym(api, 'extra').signature, 'boolean');
});
