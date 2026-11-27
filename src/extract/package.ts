// Resolve a package directory's type entry point and extract its public API.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ApiMap } from '../model/types.js';
import { extractApiFromFiles } from './api.js';

const SKIP = new Set(['node_modules', '.git']);
const SOURCE = /\.(?:d\.)?[mc]?tsx?$/;
const MAX_FILES = 3000;

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}

export interface PackageApi {
  name: string | null;
  version: string | null;
  entry: string;
  api: ApiMap;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pick the string entry from an `exports` condition value, preferring types. */
function fromConditions(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(fromConditions).find(Boolean) ?? null;
  if (isRecord(v)) {
    for (const key of ['types', 'import', 'module', 'default', 'require', 'node']) {
      const r = fromConditions(v[key]);
      if (r) return r;
    }
  }
  return null;
}

const toDts = (p: string): string => p.replace(/\.(m|c)?jsx?$/, (_: string, k?: string) => `.d.${k ?? ''}ts`);

/** Candidate type entry paths (relative, posix) in priority order. */
export function entryCandidates(pkg: PackageJson): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined): void => {
    if (p) out.push(p.replace(/^\.\//, ''));
  };
  const exp = pkg.exports;
  if (exp) {
    const root: unknown = !isRecord(exp) || !Object.keys(exp).some((k) => k.startsWith('.')) ? exp : exp['.'];
    if (isRecord(root) && root['types']) add(fromConditions(root['types']));
    add(fromConditions(root));
  }
  add(pkg.types);
  add(pkg.typings);
  if (pkg.main) {
    add(pkg.main.replace(/\.[mc]?js$/, '') + '.d.ts');
    add(pkg.main);
  }
  add('index.d.ts');
  add('index.ts');
  return [...new Set(out.flatMap((p) => (/\.[mc]?jsx?$/.test(p) ? [toDts(p), p.replace(/\.[mc]?jsx?$/, '.ts')] : [p])))];
}

function collect(dir: string, root: string, files: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || Object.keys(files).length >= MAX_FILES) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, root, files);
    else if (SOURCE.test(name)) files['/' + relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  }
}

/** Extract the public API of the package in `dir`. Returns { name, version, entry, api }. */
export function extractPackage(dir: string): PackageApi {
  const root = resolve(dir);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`No package.json found in ${root}`);
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  } catch (e) {
    throw new Error(`Invalid package.json in ${root}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const files: Record<string, string> = {};
  collect(root, root, files);
  const entry = entryCandidates(pkg).map((c) => '/' + c).find((c) => c in files);
  if (!entry) {
    throw new Error(`Could not find type declarations for ${pkg.name ?? root}. Set "types" in package.json or ship an index.d.ts.`);
  }
  return { name: pkg.name ?? null, version: pkg.version ?? null, entry: entry.slice(1), api: extractApiFromFiles(files, entry) };
}
