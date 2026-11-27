// Resolve a package's type entry points the way Node and TypeScript do:
// `exports` (conditions, subpaths, patterns), `typesVersions`, `types`/`typings`,
// then `main` with a sibling declaration file. Pure functions over a file list,
// so they are testable without touching the disk.
import ts from 'typescript';

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  typesVersions?: Record<string, Record<string, string[]>>;
}

/** One module of the package: a subpath export (`.`, `./sub`) and the declaration file behind it. */
export interface ResolvedEntry {
  subpath: string;
  file: string;
}

/** Conditions accepted when walking an `exports` target, in the order Node evaluates object keys. */
const CONDITIONS = new Set(['types', 'import', 'require', 'node', 'module', 'default']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clean = (p: string): string => p.replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * Walk an `exports` target. Returns the first usable string, `null` when the
 * target is explicitly blocked (`null`) or nothing matched.
 */
export function resolveTarget(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t);
      if (r) return r;
    }
    return null;
  }
  if (isRecord(target)) {
    for (const [key, value] of Object.entries(target)) {
      if (!CONDITIONS.has(key)) continue;
      const r = resolveTarget(value);
      if (r) return r;
    }
  }
  return null;
}

/** Declaration files that could stand behind a runtime or type path, best first. */
export function declarationCandidates(p: string): string[] {
  const path = clean(p);
  const swap = (re: RegExp, ...to: string[]): string[] => to.map((t) => path.replace(re, t));
  if (/\.d\.[mc]?ts$/.test(path)) return [path];
  if (/\.mjs$/.test(path)) return swap(/\.mjs$/, '.d.mts', '.mts');
  if (/\.cjs$/.test(path)) return swap(/\.cjs$/, '.d.cts', '.cts');
  if (/\.jsx?$/.test(path)) return swap(/\.jsx?$/, '.d.ts', '.ts', '.tsx');
  if (/\.[mc]?tsx?$/.test(path)) return [path];
  return [`${path}.d.ts`, `${path}.ts`, `${path}/index.d.ts`];
}

/** Does TypeScript version `tsVersion` satisfy a `typesVersions` range such as `>=4.1` or `<5.0`? */
export function satisfiesTsRange(range: string, tsVersion: string = ts.version): boolean {
  const have = tsVersion.split('.').map((n) => parseInt(n, 10) || 0);
  const cmp = (want: string): number => {
    const w = want.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (have[i] ?? 0) - (w[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      if (part === '*' || part === '') return true;
      const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
      if (!m) return false;
      const c = cmp(m[2] as string);
      switch (m[1]) {
        case '>=': return c >= 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '<': return c < 0;
        default: return c === 0;
      }
    });
}

/** Apply the first matching `typesVersions` block to a package-relative path; returns the candidates it maps to. */
export function applyTypesVersions(pkg: PackageJson, path: string, tsVersion?: string): string[] {
  const tv = pkg.typesVersions;
  if (!isRecord(tv)) return [];
  const block = Object.entries(tv).find(([range]) => satisfiesTsRange(range, tsVersion));
  if (!block) return [];
  const rel = clean(path);
  let best: { pattern: string; targets: string[]; star: string } | null = null;
  for (const [pattern, targets] of Object.entries(block[1])) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === rel) best = { pattern, targets, star: '' };
      continue;
    }
    const pre = pattern.slice(0, star);
    const post = pattern.slice(star + 1);
    if (rel.startsWith(pre) && rel.endsWith(post) && rel.length >= pre.length + post.length) {
      if (!best || pattern.length > best.pattern.length) best = { pattern, targets, star: rel.slice(pre.length, rel.length - post.length) };
    }
  }
  return best ? best.targets.map((t) => clean(t.replace('*', best.star))) : [];
}

function firstExisting(candidates: string[], files: ReadonlySet<string>): string | null {
  return candidates.find((c) => files.has(c)) ?? null;
}

/** Resolve a path (as written in package.json) to an existing declaration file, honouring typesVersions. */
function locate(pkg: PackageJson, path: string, files: ReadonlySet<string>, tsVersion?: string): string | null {
  const mapped = applyTypesVersions(pkg, path, tsVersion).flatMap(declarationCandidates);
  return firstExisting([...mapped, ...declarationCandidates(path)], files);
}

/** Expand a pattern export such as `"./*": "./dist/*.js"` against the files that exist. */
function expandPattern(key: string, target: string, files: ReadonlySet<string>): ResolvedEntry[] {
  const keyStar = key.indexOf('*');
  const tgtStar = target.indexOf('*');
  if (keyStar === -1 || tgtStar === -1) return [];
  const tgtPre = clean(target.slice(0, tgtStar));
  const tgtPost = target.slice(tgtStar + 1);
  const out: ResolvedEntry[] = [];
  for (const file of [...files].sort()) {
    if (!file.startsWith(tgtPre)) continue;
    for (const probe of ['', ...declarationCandidates(`x${tgtPost}`).map((c) => c.slice(1))]) {
      const post = probe || tgtPost;
      if (file.endsWith(post) && file.length >= tgtPre.length + post.length) {
        const star = file.slice(tgtPre.length, file.length - post.length);
        if (star && !star.includes('node_modules')) {
          out.push({ subpath: key.slice(0, keyStar) + star + key.slice(keyStar + 1), file });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Resolve every module the package exposes. `files` is the set of package-relative,
 * slash-separated paths that exist. Entries are ordered with the root first.
 */
export function resolveEntries(pkg: PackageJson, files: ReadonlySet<string>, tsVersion?: string): ResolvedEntry[] {
  const found = new Map<string, string>();
  const add = (subpath: string, file: string | null): void => {
    if (file && !found.has(subpath)) found.set(subpath, file);
  };

  const exp = pkg.exports;
  if (exp !== undefined && exp !== null) {
    const subpaths = isRecord(exp) && Object.keys(exp).some((k) => k.startsWith('.')) ? exp : { '.': exp };
    for (const [key, value] of Object.entries(subpaths)) {
      if (!key.startsWith('.')) continue;
      const target = resolveTarget(value);
      if (!target) continue;
      if (key.includes('*')) {
        for (const e of expandPattern(key, target, files)) add(e.subpath, e.file);
      } else {
        add(key, locate(pkg, target, files, tsVersion));
      }
    }
  }

  // Fallbacks for the root module: `types`, `typings`, `main`, then conventional names.
  if (!found.has('.')) {
    const roots = [pkg.types, pkg.typings].filter((p): p is string => typeof p === 'string');
    for (const p of roots) add('.', locate(pkg, p, files, tsVersion));
    if (typeof pkg.main === 'string') {
      add('.', locate(pkg, pkg.main.replace(/\.[mc]?js$/, ''), files, tsVersion) ?? locate(pkg, pkg.main, files, tsVersion));
    }
    add('.', locate(pkg, 'index.d.ts', files, tsVersion));
    add('.', firstExisting(['index.ts'], files));
  }

  // Without `exports`, `typesVersions` may still map sibling subpaths to declaration files.
  if (exp === undefined && isRecord(pkg.typesVersions)) {
    const block = Object.entries(pkg.typesVersions).find(([range]) => satisfiesTsRange(range, tsVersion));
    for (const pattern of Object.keys(block?.[1] ?? {})) {
      if (pattern.includes('*') || pattern === 'index' || pattern === '.') continue;
      add(`./${pattern.replace(/\.(d\.)?[mc]?[jt]sx?$/, '')}`, locate(pkg, pattern, files, tsVersion));
    }
  }

  return [...found].map(([subpath, file]) => ({ subpath, file })).sort((a, b) => (a.subpath === '.' ? -1 : b.subpath === '.' ? 1 : a.subpath.localeCompare(b.subpath)));
}

/** Backwards-compatible list of root entry candidates (package-relative, posix) in priority order. */
export function entryCandidates(pkg: PackageJson): string[] {
  const out: string[] = [];
  const exp = pkg.exports;
  if (exp !== undefined && exp !== null) {
    const root = isRecord(exp) && Object.keys(exp).some((k) => k.startsWith('.')) ? exp['.'] : exp;
    const t = resolveTarget(root);
    if (t) out.push(...declarationCandidates(t));
  }
  for (const p of [pkg.types, pkg.typings]) if (typeof p === 'string') out.push(...declarationCandidates(p));
  if (typeof pkg.main === 'string') out.push(...declarationCandidates(pkg.main.replace(/\.[mc]?js$/, '')), ...declarationCandidates(pkg.main));
  out.push('index.d.ts', 'index.ts');
  return [...new Set(out)];
}
