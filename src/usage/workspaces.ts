// Monorepo workspace discovery for npm, yarn and pnpm.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type WorkspaceManager = 'npm' | 'yarn' | 'pnpm' | 'none';

export interface Workspace {
  /** Package name from its package.json, or the directory name when it has none. */
  name: string;
  /** Absolute directory. */
  dir: string;
  /** Every dependency name in dependencies, devDependencies, peerDependencies and optionalDependencies. */
  dependencies: ReadonlySet<string>;
}

export interface WorkspaceLayout {
  root: string;
  manager: WorkspaceManager;
  /** Workspace packages, sorted by directory. For a plain package this is the root itself. */
  workspaces: Workspace[];
}

interface Manifest {
  name?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const IGNORED_DIRS = new Set(['node_modules', '.git']);

function readManifest(dir: string): Manifest | undefined {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed) : undefined;
  } catch {
    return undefined; // a broken manifest in one workspace must not hide the others
  }
}

/** Extract `packages:` entries from a pnpm-workspace.yaml (block or flow sequences; no other YAML needed). */
export function parsePnpmWorkspace(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages\s*:\s*(.*?)\s*(?:#.*)?$/.exec(lines[i] ?? '');
    if (!m) continue;
    const inline = m[1] ?? '';
    if (inline.startsWith('[')) {
      const body = inline.replace(/^\[|\]$/g, '');
      out.push(...body.split(',').map(unquote).filter(Boolean));
      break;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j] ?? '';
      if (/^\s*(#.*)?$/.test(raw)) continue;
      const item = /^\s*-\s*(.*?)\s*(?:#.*)?$/.exec(raw);
      if (!item) break; // next top-level key
      out.push(unquote(item[1] ?? ''));
    }
    break;
  }
  return out;
}

/** Compile one path segment glob (`*`, `?`, literals) to a RegExp. */
function segmentRegex(segment: string): RegExp {
  const body = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

/** Expand a workspace glob (`packages/*`, `apps/**`, `tools/*\/plugins`) to directories under `root`. */
export function expandGlob(root: string, pattern: string): string[] {
  const segments = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const results = new Set<string>();
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  const walk = (dir: string, i: number): void => {
    const seg = segments[i];
    if (seg === undefined) {
      results.add(dir);
      return;
    }
    if (seg === '**') {
      walk(dir, i + 1); // zero directories
      for (const name of subdirs(dir)) walk(join(dir, name), i); // one or more
      return;
    }
    if (!/[*?]/.test(seg)) {
      const next = join(dir, seg);
      if (existsSync(next)) walk(next, i + 1);
      return;
    }
    const re = segmentRegex(seg);
    for (const name of subdirs(dir)) if (re.test(name)) walk(join(dir, name), i + 1);
  };
  walk(root, 0);
  return [...results].sort();
}

function declaredPatterns(root: string): { manager: WorkspaceManager; patterns: string[] } {
  const pnpmFile = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) return { manager: 'pnpm', patterns: parsePnpmWorkspace(readFileSync(pnpmFile, 'utf8')) };
  const ws = readManifest(root)?.workspaces;
  const list = Array.isArray(ws) ? ws : typeof ws === 'object' && ws !== null ? (ws as { packages?: unknown }).packages : undefined;
  if (Array.isArray(list)) {
    const patterns = list.filter((p): p is string => typeof p === 'string');
    return { manager: existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm', patterns };
  }
  return { manager: 'none', patterns: [] };
}

function toWorkspace(dir: string): Workspace | undefined {
  const manifest = readManifest(dir);
  if (!manifest) return undefined;
  const deps = new Set<string>();
  for (const field of DEP_FIELDS) {
    const section = manifest[field];
    if (typeof section === 'object' && section !== null) for (const name of Object.keys(section)) deps.add(name);
  }
  const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : (dir.split(sep).pop() ?? dir);
  return { name, dir, dependencies: deps };
}

/**
 * Discover the workspace packages of the repository at `root`. A directory that declares no workspaces
 * is returned as a single workspace (itself); a directory without a package.json yields no workspaces.
 */
export function discoverWorkspaces(root: string): WorkspaceLayout {
  const base = resolve(root);
  const { manager, patterns } = declaredPatterns(base);
  const dirs = new Set<string>();
  const excluded = new Set<string>();
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    for (const dir of expandGlob(base, negated ? pattern.slice(1) : pattern)) (negated ? excluded : dirs).add(dir);
  }
  for (const dir of excluded) dirs.delete(dir);
  if (manager === 'none') dirs.add(base);
  const workspaces = [...dirs]
    .sort()
    .map(toWorkspace)
    .filter((w): w is Workspace => w !== undefined);
  return { root: base, manager, workspaces };
}

/** Workspaces that list `pkg` in any dependency section. */
export function workspacesUsing(layout: WorkspaceLayout, pkg: string): Workspace[] {
  return layout.workspaces.filter((w) => w.dependencies.has(pkg));
}

/** Workspace directory relative to the layout root, as a posix path (`.` for the root itself). */
export const workspacePath = (layout: WorkspaceLayout, w: Workspace): string => relative(layout.root, w.dir).split(sep).join('/') || '.';
