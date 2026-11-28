// Turn a user-supplied package spec into a directory of unpacked files.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { PackageCache } from './cache.js';
import { RegistryClient, RegistryError, pickVersion, type VersionManifest } from './client.js';
import { extractTarball } from './tar.js';
import { mergeTypes, pickTypesVersion, shipsTypes, typesPackageName } from './types-fallback.js';

export type PackageSource = 'local' | 'cache' | 'registry';

export interface ResolvedPackage {
  /** Directory containing the package's `package.json`. */
  dir: string;
  /** Human-readable name of what was resolved (the spec as typed). */
  label: string;
  name: string | null;
  version: string | null;
  source: PackageSource;
  /** Version of the `@types/*` package merged into `dir`, when the fallback was used. */
  typesVersion?: string;
}

export type ParsedSpec = { kind: 'path'; path: string } | { kind: 'registry'; name: string; range: string };

const NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;

/** Classify `spec` as a local path (`./x`, `/x`, `file:x`, `C:\x`) or `name[@range]`. Returns undefined for anything else. */
export function parseSpec(spec: string): ParsedSpec | undefined {
  if (spec.startsWith('file:')) return { kind: 'path', path: spec.slice(5).replace(/^\/\/(?=\/)/, '') };
  if (/^(\.{1,2}([\\/]|$)|\/|~[\\/]|[a-z]:[\\/])/i.test(spec)) return { kind: 'path', path: spec };
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : 'latest';
  if (!NAME.test(name) || range === '') return undefined;
  return { kind: 'registry', name, range };
}

export interface ResolverOptions {
  client: RegistryClient;
  cache: PackageCache;
  /** Never touch the network: only cached versions can be resolved. */
  offline?: boolean;
  /** Merge `@types/<name>` into packages that ship no declarations (default true). */
  typesFallback?: boolean;
  cwd?: string;
}

export class PackageResolver {
  constructor(private readonly opts: ResolverOptions) {}

  async resolve(spec: string): Promise<ResolvedPackage> {
    const parsed = parseSpec(spec);
    if (!parsed) throw new RegistryError(`"${spec}" is neither a directory nor a package spec like name@1.2.3`);
    return parsed.kind === 'path' ? this.local(spec, parsed.path) : this.fromRegistry(spec, parsed.name, parsed.range);
  }

  private local(label: string, path: string): ResolvedPackage {
    const dir = resolve(this.opts.cwd ?? process.cwd(), path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new RegistryError(`"${label}" is not a directory`);
    if (!existsSync(join(dir, 'package.json'))) throw new RegistryError(`no package.json found in ${dir}`);
    const meta = readMeta(dir);
    return { dir, label, name: meta.name, version: meta.version, source: 'local' };
  }

  private async fromRegistry(label: string, name: string, range: string): Promise<ResolvedPackage> {
    const { cache, client } = this.opts;
    let pkg: { dir: string; name: string; version: string; source: PackageSource };

    const exactCached = semver.valid(range) ? cache.lookup(name, range) : undefined;
    if (exactCached) {
      pkg = { dir: exactCached.dir, name, version: range, source: 'cache' };
    } else if (this.opts.offline) {
      const version = semver.maxSatisfying(cache.versions(name), semver.validRange(range) ?? range);
      const hit = version ? cache.lookup(name, version) : undefined;
      if (!version || !hit) throw new RegistryError(`${label} is not in the local cache and --offline is set`);
      pkg = { dir: hit.dir, name, version, source: 'cache' };
    } else {
      const manifest = await client.resolve(name, range);
      const got = await this.fetchVersion(manifest);
      pkg = { dir: got.dir, name, version: manifest.version, source: got.fromCache ? 'cache' : 'registry' };
    }

    const result: ResolvedPackage = { ...pkg, label };
    if (this.opts.typesFallback !== false && !name.startsWith('@types/') && !shipsTypes(pkg.dir)) {
      const merged = await this.withTypes(pkg.dir, name, pkg.version);
      if (merged) {
        result.dir = merged.dir;
        result.typesVersion = merged.typesVersion;
      }
    }
    return result;
  }

  /** Cached copy of a registry version, downloading and verifying it on a miss. */
  private async fetchVersion(manifest: VersionManifest): Promise<{ dir: string; fromCache: boolean }> {
    const { cache, client } = this.opts;
    const hit = cache.lookup(manifest.name, manifest.version);
    if (hit) return { dir: hit.dir, fromCache: true };
    const { data, integrity } = await client.tarball(manifest);
    const stored = cache.store(manifest.name, manifest.version, integrity, (dir) => {
      extractTarball(data, dir);
    });
    return { dir: stored.dir, fromCache: false };
  }

  private async withTypes(pkgDir: string, name: string, version: string): Promise<{ dir: string; typesVersion: string } | undefined> {
    const { cache, client } = this.opts;
    const typesName = typesPackageName(name);
    let typesDir: string;
    let typesVersion: string;
    if (this.opts.offline) {
      const cached = cache.versions(typesName);
      const picked = pickTypesVersion({ name: typesName, 'dist-tags': {}, versions: Object.fromEntries(cached.map((v) => [v, {} as VersionManifest])) }, version);
      const hit = picked ? cache.lookup(typesName, picked) : undefined;
      if (!picked || !hit) return undefined;
      [typesDir, typesVersion] = [hit.dir, picked];
    } else {
      let doc;
      try {
        doc = await client.packument(typesName);
      } catch (e) {
        if (e instanceof RegistryError && e.status === 404) return undefined; // no DefinitelyTyped package exists
        throw e;
      }
      const picked = pickTypesVersion(doc, version);
      if (!picked) return undefined;
      typesDir = (await this.fetchVersion(pickVersion(doc, picked))).dir;
      typesVersion = picked;
    }
    const out = join(cache.root, 'merged', ...name.split('/'), `${version}+types-${typesVersion}`);
    if (!existsSync(join(out, 'package.json'))) mergeTypes(pkgDir, typesDir, out);
    return { dir: out, typesVersion };
  }
}

function readMeta(dir: string): { name: string | null; version: string | null } {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return { name: typeof m.name === 'string' ? m.name : null, version: typeof m.version === 'string' ? m.version : null };
  } catch {
    throw new RegistryError(`${join(dir, 'package.json')} is not valid JSON`);
  }
}
