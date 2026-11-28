// Load a user project the way `tsc` would: tsconfig (extends, paths, references) or a synthesised JS config.
import ts from 'typescript';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listSourceFiles } from './scan.js';

/** Thrown when a project cannot be loaded at all (unreadable or malformed tsconfig). */
export class ProjectError extends Error {
  override readonly name = 'ProjectError';
}

export interface ProjectConfig {
  /** Absolute tsconfig path, or null when the config was synthesised for a plain JavaScript project. */
  configPath: string | null;
  /** Directory the config lives in (or the project root when synthesised). */
  dir: string;
  options: ts.CompilerOptions;
  /** Absolute source files (declaration files and `node_modules` excluded), sorted. */
  fileNames: string[];
  /** Absolute tsconfig paths this config references, in declaration order. */
  references: string[];
}

export interface LoadedProject {
  root: string;
  /** The entry config first, then every transitively referenced config (each once). */
  configs: ProjectConfig[];
  /** Union of all configs' files, deduplicated and sorted. */
  fileNames: string[];
  /** True when `maxFiles` cut the file list short. */
  truncated: boolean;
  /** Non-fatal tsconfig problems, formatted for display. */
  warnings: string[];
}

export interface LoadOptions {
  /** Explicit tsconfig file or directory instead of searching `dir`. */
  tsconfig?: string;
  maxFiles?: number;
}

const DECLARATION = /\.d\.[cm]?ts$/;
/** "No inputs were found in config file": expected for solution-style tsconfigs that only reference others. */
const NO_INPUTS = 18003;

const isProjectSource = (file: string): boolean => !DECLARATION.test(file) && !/(^|[\\/])node_modules[\\/]/.test(file);

const format = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, '\n');

/** Compiler options for projects without a tsconfig: permissive, JavaScript included. */
export function syntheticOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    strict: false,
  };
}

function findConfig(dir: string, explicit: string | undefined): string | undefined {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(dir, explicit);
    if (!existsSync(path)) throw new ProjectError(`tsconfig not found: ${path}`);
    return statSync(path).isDirectory() ? ts.findConfigFile(path, (f) => ts.sys.fileExists(f)) : path;
  }
  // Only a config in the project directory itself: a parent's tsconfig belongs to a different project.
  const own = join(dir, 'tsconfig.json');
  return existsSync(own) ? own : undefined;
}

function readConfig(configPath: string, warnings: string[]): ProjectConfig {
  const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  if (read.error) throw new ProjectError(`cannot read ${configPath}: ${format(read.error)}`);
  const dir = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, configPath);
  const hasReferences = (parsed.projectReferences ?? []).length > 0;
  for (const d of parsed.errors) {
    if (d.code === NO_INPUTS && hasReferences) continue;
    warnings.push(`${relative(process.cwd(), configPath) || configPath}: ${format(d)}`);
  }
  return {
    configPath,
    dir,
    options: parsed.options,
    fileNames: parsed.fileNames.map((f) => resolve(f)).filter(isProjectSource).sort(),
    references: (parsed.projectReferences ?? []).map((r) => resolve(ts.resolveProjectReferencePath(r))),
  };
}

/** Load `dir` as a project: its tsconfig and referenced projects, or a synthesised config for JavaScript. */
export function loadProject(dir: string, opts: LoadOptions = {}): LoadedProject {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ProjectError(`project directory not found: ${root}`);
  const warnings: string[] = [];
  const entry = findConfig(root, opts.tsconfig);
  const configs: ProjectConfig[] = [];

  if (entry) {
    const seen = new Set<string>();
    const visit = (path: string): void => {
      const key = resolve(path);
      if (seen.has(key)) return; // reference cycles and diamonds
      seen.add(key);
      const refPath = existsSync(key) && statSync(key).isDirectory() ? join(key, 'tsconfig.json') : key;
      if (!existsSync(refPath)) {
        warnings.push(`referenced project not found: ${refPath}`);
        return;
      }
      const cfg = readConfig(refPath, warnings);
      configs.push(cfg);
      for (const ref of cfg.references) visit(ref);
    };
    visit(entry);
  } else {
    const files = listSourceFiles(root, opts.maxFiles === undefined ? {} : { maxFiles: opts.maxFiles }).map((f) => resolve(f));
    configs.push({ configPath: null, dir: root, options: syntheticOptions(), fileNames: files.sort(), references: [] });
  }

  const all = [...new Set(configs.flatMap((c) => c.fileNames))].sort();
  const limit = opts.maxFiles ?? Infinity;
  const truncated = all.length > limit;
  return { root, configs, fileNames: truncated ? all.slice(0, limit) : all, truncated, warnings };
}

/** Project-relative posix path, for stable display and tests. */
export const relPosix = (root: string, file: string): string => relative(root, file).split(sep).join('/');

export interface ConfigProgram {
  config: ProjectConfig;
  program: ts.Program;
}

/**
 * One `ts.Program` per config, each with its own options (so `paths` and `baseUrl` of every referenced
 * project apply to its own files). Files beyond `fileNames` limits are not added.
 */
export function createPrograms(project: LoadedProject, host?: ts.CompilerHost): ConfigProgram[] {
  const allowed = new Set(project.fileNames);
  return project.configs
    .map((config) => ({ config, rootNames: config.fileNames.filter((f) => allowed.has(f)) }))
    .filter(({ rootNames }) => rootNames.length > 0)
    .map(({ config, rootNames }) => ({
      config,
      program: ts.createProgram({
        rootNames,
        options: { ...config.options, noEmit: true },
        ...(host ? { host } : {}),
      }),
    }));
}
