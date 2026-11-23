import test from 'node:test';
import assert from 'node:assert/strict';
import { extractApi } from '../src/extract.js';

test('enums expose member names and values', () => {
  const api = extractApi("export enum Color { Red = 'r', Green = 'g' } export enum N { A, B }");
  assert.equal(api.Color.signature, 'enum { Green="g"; Red="r" }');
  assert.equal(api.N.signature, 'enum { A=0; B=1 }');
});

test('namespaces list their exported members', () => {
  const api = extractApi('export namespace NS { export const x: number = 1; export function f(): void {} const hidden = 1; }');
  assert.equal(api.NS.kind, 'namespace');
  assert.equal(api.NS.signature, 'namespace { f: function; x: variable }');
});

test('classes include static and protected members but not private ones', () => {
  const api = extractApi(`export abstract class Base<T> {
    protected secret: string = ''; private p = 1; #hash = 2;
    static create(): Base<any> { return null as any; }
    abstract run(t: T): void;
  }`);
  const sig = api.Base.signature;
  assert.match(sig, /static create: \(\) => Base<any>/);
  assert.match(sig, /secret: string/);
  assert.match(sig, /run: \(t: T\) => void/);
  assert.doesNotMatch(sig, /\bp:/);
  assert.doesNotMatch(sig, /hash/);
});

test('default exports and aliased re-exports appear under their public names', () => {
  const api = extractApi(`
    export default function hello(a: string): void {}
    interface Shape { area(): number }
    export { Shape as Renamed };
  `);
  assert.equal(api.default.kind, 'function');
  assert.equal(api.Renamed.kind, 'interface');
  assert.equal(api.Shape, undefined);
});

test('type aliases keep their definition, including generics and unions', () => {
  const api = extractApi("export type Result<T> = { ok: true; value: T } | { ok: false }; export type Fn = (x: number) => void;");
  assert.match(api.Result.signature, /ok: true; value: T/);
  assert.equal(api.Fn.signature, '(x: number) => void');
});
