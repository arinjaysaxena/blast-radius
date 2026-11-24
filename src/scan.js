// Project scanner: finds imports of a package and every use of the imported symbols.
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);
const EXT = /\.(?:[mc]?[jt]sx?)$/;
const DECL = /\.d\.[mc]?ts$/;

/** Does module specifier `spec` refer to package `pkg` (or one of its subpaths)? */
export const matchesPackage = (spec, pkg) => spec === pkg || spec.startsWith(`${pkg}/`);

export function listSourceFiles(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const visit = (dir) => {
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

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Scan one source text. Returns sites: [{ file, line, column, symbol, kind: 'import'|'use', text }]
 * where `symbol` is the exported name from `pkg` ("default" for default imports, "*" for bare namespace use).
 * Syntactic only: shadowed local names are not distinguished (documented limitation).
 */
export function scanSource(file, source, pkg) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const bindings = new Map(); // local identifier name -> exported symbol name
  const namespaces = new Set(); // local names bound to the whole module
  const importNodes = new Set();
  const sites = [];
  const lines = source.split('\n');
  const push = (node, symbol, kind) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    sites.push({ file, line: line + 1, column: character + 1, symbol, kind, text: (lines[line] ?? '').trim() });
  };

  const bindRequire = (decl) => {
    const init = decl.initializer;
    const call = init && ts.isCallExpression(init) ? init : init && ts.isPropertyAccessExpression(init) && ts.isCallExpression(init.expression) ? init.expression : null;
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
  const collect = (node) => {
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
      } else if (c?.namedBindings) {
        for (const el of c.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          bindings.set(el.name.text, imported);
          importNodes.add(el.name);
          push(el, imported, 'import');
        }
      }
    } else if (ts.isVariableDeclaration(node)) bindRequire(node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && matchesPackage(node.moduleSpecifier.text, pkg)) {
      for (const el of node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []) push(el, (el.propertyName ?? el.name).text, 'import');
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (!bindings.size && !namespaces.size) return sites;

  // Pass 2: uses
  const walk = (node) => {
    if (ts.isIdentifier(node) && !importNodes.has(node)) {
      const parent = node.parent;
      const isImportSyntax = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isImportSyntax && !isMemberName && bindings.has(node.text)) push(node, bindings.get(node.text), 'use');
      else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && namespaces.has(node.text)) push(parent.name, parent.name.text, 'use');
      else if (namespaces.has(node.text) && !isImportSyntax && !isMemberName && !(ts.isPropertyAccessExpression(parent) && parent.expression === node)) push(node, '*', 'use');
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Scan a project directory; sites carry repo-relative posix paths. */
export const MAX_FILE_BYTES = 1_000_000;

/** Files over `maxBytes` (bundles, generated code) are skipped and reported via `onSkip(relPath)`. */
export function scanProject(root, pkg, { maxFiles, maxBytes = MAX_FILE_BYTES, onSkip } = {}) {
  const sites = [];
  for (const full of listSourceFiles(root, { maxFiles })) {
    const rel = relative(root, full).split(sep).join('/');
    let source;
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

/**
 * Map diff entries onto call sites. Only non-additive entries matter. Returns
 * [{ entry, sites }] for entries that have at least one site, plus `untouched` entries without sites.
 * Bare namespace uses ("*", e.g. passing the whole module around) are not attributed to any symbol.
 */
export function mapChangesToSites(entries, sites) {
  const impacted = [];
  const untouched = [];
  for (const entry of entries.filter((e) => e.change !== 'added')) {
    const exact = sites.filter((s) => s.symbol === entry.name);
    if (exact.length) impacted.push({ entry, sites: exact });
    else untouched.push(entry);
  }
  return { impacted, untouched, totalSites: new Set(impacted.flatMap((i) => i.sites.map((s) => `${s.file}:${s.line}:${s.column}`))).size };
}
