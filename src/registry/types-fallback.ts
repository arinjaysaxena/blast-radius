// Find and merge the DefinitelyTyped package for libraries that ship no types of their own.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import type { Packument } from './client.js';

interface ManifestLike {
  main?: unknown;
  module?: unknown;
  types?: unknown;
  typings?: unknown;
  exports?: unknown;
}

/** `@scope/name` → `@types/scope__name`; `name` → `@types/name`. */
export function typesPackageName(name: string): string {
  return '@types/' + (name.startsWith('@') ? name.slice(1).replace('/', '__') : name);
}

function exportsMentionTypes(node: unknown): boolean {
  if (typeof node === 'string') return /\.d\.[mc]?ts$/.test(node);
  if (Array.isArray(node)) return node.some(exportsMentionTypes);
  if (node && typeof node === 'object') {
    return Object.entries(node).some(([k, v]) => k === 'types' || k.startsWith('types@') || exportsMentionTypes(v));
  }
  return false;
}

/** Does the unpacked package at `dir` already ship declarations? */
export function shipsTypes(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  let pkg: ManifestLike;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as ManifestLike;
  } catch {
    return false;
  }
  if (typeof pkg.types === 'string' || typeof pkg.typings === 'string') return true;
  if (exportsMentionTypes(pkg.exports)) return true;
  const main = typeof pkg.main === 'string' ? pkg.main : 'index.js';
  const sibling = main.replace(/\.[mc]?js$/, '') + '.d.ts';
  return existsSync(join(dir, sibling)) || existsSync(join(dir, 'index.d.ts'));
}

/**
 * Pick the @types version that corresponds to `version`: DefinitelyTyped versions are `major.minor.x`,
 * so prefer the highest patch of the same major.minor, then the highest of the same major.
 */
export function pickTypesVersion(types: Packument, version: string): string | undefined {
  const parsed = semver.parse(version);
  if (!parsed) return undefined;
  const all = Object.keys(types.versions).filter((v) => semver.valid(v));
  const sameMinor = semver.maxSatisfying(all, `~${parsed.major}.${parsed.minor}.0`);
  if (sameMinor) return sameMinor;
  return semver.maxSatisfying(all, `^${parsed.major}.0.0`) ?? undefined;
}

/**
 * Copy `pkgDir` into `outDir` and overlay the declaration files of `typesDir`, pointing `types` at them.
 * The result behaves like a package that ships its own types.
 */
export function mergeTypes(pkgDir: string, typesDir: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(pkgDir, outDir, { recursive: true });
  const typesPkg = JSON.parse(readFileSync(join(typesDir, 'package.json'), 'utf8')) as ManifestLike;
  for (const entry of readdirSync(typesDir)) {
    if (entry === 'package.json' || entry === 'node_modules') continue;
    cpSync(join(typesDir, entry), join(outDir, entry), { recursive: true });
  }
  const typesEntry = typeof typesPkg.types === 'string' ? typesPkg.types : typeof typesPkg.typings === 'string' ? typesPkg.typings : 'index.d.ts';
  const manifestPath = join(outDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['types'] = typesEntry;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
