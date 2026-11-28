import { PackageCache } from '../src/registry/cache.js';
import type { ResolvedPackage } from '../src/registry/index.js';
import type { SpecResolver } from '../src/cli/run.js';
import { tmpDir, writeTree } from './helpers.js';

/** A package directory holding one declaration file. */
export function pkgDir(name: string, version: string, dts: string, extra: Record<string, string> = {}): string {
  const d = tmpDir('br-pkg-');
  writeTree(d, { 'package.json': JSON.stringify({ name, version, types: 'index.d.ts' }), 'index.d.ts': dts, ...extra });
  return d;
}

export const OLD_DTS = 'export function parse(s: string): number;\nexport function gone(): void;\n';
export const NEW_DTS = 'export function parse(s: string, strict: boolean): number;\n';

/** A project with call sites of `lib`, plus an unrelated file. */
export function project(): string {
  const d = tmpDir('br-proj-');
  writeTree(d, {
    'src/a.ts': "import { parse, gone } from 'lib';\nparse('x');\ngone();\n",
    'src/unrelated.ts': 'export const x = 1;\n',
  });
  return d;
}

/** Resolver backed by a fixed map of spec → directory; never touches disk caches or the network. */
export function mapResolver(specs: Record<string, string | ResolvedPackage>): SpecResolver {
  return {
    resolve: (spec) => {
      const hit = specs[spec];
      if (!hit) return Promise.reject(new Error(`no such package: ${spec}`));
      return Promise.resolve(typeof hit === 'string' ? { dir: hit, label: spec, name: null, version: null, source: 'local' } : hit);
    },
  };
}

/** Put an unpacked package into a fresh cache and return the cache. */
export function seedCache(name: string, version: string, dts: string): PackageCache {
  const cache = new PackageCache(tmpDir('br-cache-'));
  cache.store(name, version, 'sha512-test', (dir) => {
    writeTree(dir, { 'package.json': JSON.stringify({ name, version, types: 'index.d.ts' }), 'index.d.ts': dts });
  });
  return cache;
}
