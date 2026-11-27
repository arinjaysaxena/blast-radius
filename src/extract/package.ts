// Resolve a package directory's modules and extract the public API of each.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ApiMap } from '../model/types.js';
import { extractApiFromFiles } from './api.js';
import { resolveEntries, type PackageJson } from './entries.js';

export { entryCandidates, resolveEntries } from './entries.js';
export type { PackageJson, ResolvedEntry } from './entries.js';

const SKIP = new Set(['node_modules', '.git']);
const SOURCE = /\.(?:d\.)?[mc]?tsx?$/;
const MAX_FILES = 3000;

/** The public API of one module (the package root or a subpath export). */
export interface ModuleApi {
  /** `.` for the package root, `./sub` for a subpath export. */
  subpath: string;
  /** Declaration file behind the module, relative to the package root. */
  entry: string;
  api: ApiMap;
}

export interface PackageApi {
  name: string | null;
  version: string | null;
  /** Entry file and API of the root module (or the first module when the package has no `.` export). */
  entry: string;
  api: ApiMap;
  /** Every module in the package, root first, one per subpath export. */
  modules: ModuleApi[];
}

function collect(dir: string, root: string, files: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || Object.keys(files).length >= MAX_FILES) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, root, files);
    else if (SOURCE.test(name)) files['/' + relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  }
}

/** Extract the public API of every module of the package in `dir`. */
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
  const relFiles = new Set(Object.keys(files).map((f) => f.slice(1)));
  const entries = resolveEntries(pkg, relFiles);
  const first = entries[0];
  if (!first) {
    throw new Error(`Could not find type declarations for ${pkg.name ?? root}. Set "types" in package.json or ship an index.d.ts.`);
  }
  const modules = entries.map((e) => ({ subpath: e.subpath, entry: e.file, api: extractApiFromFiles(files, '/' + e.file) }));
  const rootModule = modules.find((m) => m.subpath === '.') ?? modules[0];
  if (!rootModule) throw new Error('unreachable: entries is non-empty');
  return { name: pkg.name ?? null, version: pkg.version ?? null, entry: rootModule.entry, api: rootModule.api, modules };
}
