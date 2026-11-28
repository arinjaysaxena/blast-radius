// The analysis pipeline shared by the CLI and the GitHub Action.
import { diffApi } from '../diff/index.js';
import { extractPackage } from '../extract/index.js';
import type { Report } from '../model/types.js';
import { PackageCache, PackageResolver, RegistryClient, defaultCacheRoot, loadNpmConfig } from '../registry/index.js';
import type { ResolvedPackage } from '../registry/index.js';
import { buildReport, renderJson, renderMarkdown } from '../report/index.js';
import { scanProject } from '../usage/index.js';
import type { OutputFormat } from './args.js';

export interface SpecResolver {
  resolve(spec: string): Promise<ResolvedPackage>;
}

export interface RunOptions {
  old: string;
  new: string;
  project: string | null;
  format: OutputFormat;
  maxFiles?: number | null;
}

export interface RunDeps {
  resolver: SpecResolver;
  /** Receives non-fatal notices (skipped files, `@types` fallback). */
  warn?: (message: string) => void;
}

export interface RunResult {
  report: Report;
  text: string;
}

export interface ResolverConfig {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  offline?: boolean;
  noTypesFallback?: boolean;
  /** Override the cache directory (defaults to the platform cache location). */
  cacheRoot?: string;
}

/** Build the production resolver: `.npmrc`-aware registry client plus the on-disk package cache. */
export function createResolver(cfg: ResolverConfig = {}): PackageResolver {
  const env = cfg.env ?? process.env;
  const cwd = cfg.cwd ?? process.cwd();
  const config = loadNpmConfig({ env, cwd });
  return new PackageResolver({
    client: new RegistryClient({ config }),
    cache: new PackageCache(cfg.cacheRoot ?? defaultCacheRoot(env)),
    offline: cfg.offline ?? false,
    typesFallback: !(cfg.noTypesFallback ?? false),
    cwd,
  });
}

const noticeFor = (p: ResolvedPackage): string | null =>
  p.typesVersion ? `${p.label}: no bundled types, using @types ${p.typesVersion}` : null;

/** Resolve both versions, diff their public APIs, scan the project and render the report. */
export async function run(opts: RunOptions, { resolver, warn = () => undefined }: RunDeps): Promise<RunResult> {
  const [a, b] = await Promise.all([resolver.resolve(opts.old), resolver.resolve(opts.new)]);
  for (const p of [a, b]) {
    const notice = noticeFor(p);
    if (notice) warn(notice);
  }
  const oldPkg = extractPackage(a.dir);
  const newPkg = extractPackage(b.dir);
  const entries = diffApi(oldPkg.api, newPkg.api);
  const name = newPkg.name ?? oldPkg.name;
  const sites =
    opts.project && name
      ? scanProject(opts.project, name, {
          ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}),
          onSkip: (f) => { warn(`skipped ${f} (file too large)`); },
        })
      : [];
  const report = buildReport(entries, sites, {
    pkg: name,
    oldLabel: oldPkg.version ?? a.label,
    newLabel: newPkg.version ?? b.label,
    scanned: Boolean(opts.project),
  });
  return { report, text: opts.format === 'json' ? renderJson(report) : renderMarkdown(report) };
}
