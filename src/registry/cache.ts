// Content-addressed on-disk cache of unpacked package versions.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const META = '.blast-radius.json';

type Env = Readonly<Record<string, string | undefined>>;

/** Cache root: `$BLAST_RADIUS_CACHE`, `$XDG_CACHE_HOME`, `%LOCALAPPDATA%` or the platform default. */
export function defaultCacheRoot(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const explicit = env['BLAST_RADIUS_CACHE'];
  if (explicit) return explicit;
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'blast-radius', 'Cache');
  if (platform === 'darwin' && !env['XDG_CACHE_HOME']) return join(home, 'Library', 'Caches', 'blast-radius');
  return join(env['XDG_CACHE_HOME'] ?? join(home, '.cache'), 'blast-radius');
}

export interface CachedPackage {
  /** Directory holding the unpacked package (contains its package.json). */
  dir: string;
  /** SRI string the contents were verified against when stored. */
  integrity: string;
}

interface Meta {
  name: string;
  version: string;
  integrity: string;
}

export class PackageCache {
  constructor(readonly root: string) {}

  private versionDir(name: string, version: string): string {
    return join(this.root, 'packages', ...name.split('/'), version);
  }

  /** Return the cached package if present (and, when given, stored with the same integrity). */
  lookup(name: string, version: string, integrity?: string): CachedPackage | undefined {
    const base = this.versionDir(name, version);
    const metaPath = join(base, META);
    if (!existsSync(metaPath)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<Meta>;
      if (typeof meta.integrity !== 'string') return undefined;
      if (integrity && meta.integrity !== integrity) return undefined;
      const dir = join(base, 'package');
      return existsSync(join(dir, 'package.json')) ? { dir, integrity: meta.integrity } : undefined;
    } catch {
      return undefined; // corrupt entry: treat as a miss and let the caller refetch
    }
  }

  /**
   * Store a package atomically. `populate` writes the unpacked files into the directory it is handed;
   * the entry only becomes visible once everything has been written.
   */
  store(name: string, version: string, integrity: string, populate: (dir: string) => void): CachedPackage {
    const base = this.versionDir(name, version);
    const staging = `${base}.tmp-${process.pid}-${Date.now()}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, 'package'), { recursive: true });
    try {
      populate(join(staging, 'package'));
      const meta: Meta = { name, version, integrity };
      writeFileSync(join(staging, META), JSON.stringify(meta));
      rmSync(base, { recursive: true, force: true });
      mkdirSync(dirname(base), { recursive: true });
      renameSync(staging, base);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    return { dir: join(base, 'package'), integrity };
  }

  /** Versions of `name` available offline (those with a valid entry). */
  versions(name: string): string[] {
    const parent = join(this.root, 'packages', ...name.split('/'));
    if (!existsSync(parent)) return [];
    return readdirSync(parent).filter((v) => !v.includes('.tmp-') && this.lookup(name, v) !== undefined);
  }
}
