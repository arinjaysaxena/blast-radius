// Project scanner: finds imports of a package and every use of the imported symbols.
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CallSite, SiteKind } from '../model/types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);
const EXT = /\.(?:[mc]?[jt]sx?)$/;
const DECL = /\.d\.[mc]?ts$/;

/** Does module specifier `spec` refer to package `pkg` (or one of its subpaths)? */
export const matchesPackage = (spec: string, pkg: string): boolean => spec === pkg || spec.startsWith(`${pkg}/`);

export const MAX_FILE_BYTES = 1_000_000;

export interface ScanOptions {
  maxFiles?: number;
  /** Files larger than this (bundles, generated code) are skipped. */
  maxBytes?: number;
  /** Called with the project-relative path of every skipped file. */
  onSkip?: (relPath: string) => void;
}

export function listSourceFiles(root: string, { maxFiles = 20000 }: Pick<ScanOptions, 'maxFiles'> = {}): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(full);
      } else if (e.isFile() && EXT.test(e.name) && !DECL.test(e.name)) out.push(full);
    }
  };
  visit(root);
  return out;
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Scan one source text. `symbol` is the exported name from `pkg` ("default" for default imports,
 * "*" for bare namespace use). Syntactic only: shadowed local names are not distinguished.
 */
export function scanSource(file: string, source: string, pkg: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const bindings = new Map<string, string>(); // local identifier name -> exported symbol name
  const namespaces = new Set<string>(); // local names bound to the whole module
  const importNodes = new Set<ts.Node>();
  const sites: CallSite[] = [];
  const lines = source.split('\n');
  const push = (node: ts.Node, symbol: string, kind: SiteKind): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    sites.push({ file, line: line + 1, column: character + 1, symbol, kind, text: (lines[line] ?? '').trim() });
  };

  const bindRequire = (decl: ts.VariableDeclaration): void => {
    const init = decl.initializer;
    if (!init) return;
    let call: ts.CallExpression | null = null;
    if (ts.isCallExpression(init)) call = init;
    else if (ts.isPropertyAccessExpression(init) && ts.isCallExpression(init.expression)) call = init.expression;
    if (!call || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return;
    const arg = call.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg) || !matchesPackage(arg.text, pkg)) return;
    if (ts.isObjectBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        bindings.set(el.name.text, imported);
        importNodes.add(el.name);
        push(el, imported, 'import');
      }
    } else if (ts.isIdentifier(decl.name)) {
      if (init !== call && ts.isPropertyAccessExpression(init)) {
        bindings.set(decl.name.text, init.name.text);
        push(decl, init.name.text, 'import');
      } else {
        namespaces.add(decl.name.text);
      }
      importNodes.add(decl.name);
    }
  };

  // Pass 1: imports
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && matchesPackage(node.moduleSpecifier.text, pkg)) {
      const c = node.importClause;
      if (c?.name) {
        bindings.set(c.name.text, 'default');
        importNodes.add(c.name);
        push(c.name, 'default', 'import');
      }
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
        namespaces.add(c.namedBindings.name.text);
        importNodes.add(c.namedBindings.name);
      } else if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          bindings.set(el.name.text, imported);
          importNodes.add(el.name);
          push(el, imported, 'import');
        }
      }
    } else if (ts.isVariableDeclaration(node)) bindRequire(node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && matchesPackage(node.moduleSpecifier.text, pkg)) {
      const clause = node.exportClause;
      for (const el of clause && ts.isNamedExports(clause) ? clause.elements : []) push(el, (el.propertyName ?? el.name).text, 'import');
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (!bindings.size && !namespaces.size) return sites;

  // Pass 2: uses
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !importNodes.has(node)) {
      const parent = node.parent;
      const isImportSyntax = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      const boundTo = bindings.get(node.text);
      if (!isImportSyntax && !isMemberName && boundTo !== undefined) push(node, boundTo, 'use');
      else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && namespaces.has(node.text)) push(parent.name, parent.name.text, 'use');
      else if (namespaces.has(node.text) && !isImportSyntax && !isMemberName && !(ts.isPropertyAccessExpression(parent) && parent.expression === node)) push(node, '*', 'use');
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Scan a project directory; sites carry repo-relative posix paths. */
export function scanProject(root: string, pkg: string, options: ScanOptions = {}): CallSite[] {
  const { maxBytes = MAX_FILE_BYTES, onSkip } = options;
  const sites: CallSite[] = [];
  for (const full of listSourceFiles(root, options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles })) {
    const rel = relative(root, full).split(sep).join('/');
    let source: string;
    try {
      if (statSync(full).size > maxBytes) {
        onSkip?.(rel);
        continue;
      }
      source = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes(pkg)) continue; // cheap prefilter before parsing
    sites.push(...scanSource(rel, source, pkg));
  }
  return sites;
}
