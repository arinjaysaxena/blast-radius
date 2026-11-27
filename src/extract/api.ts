// Extract the public API (exported symbols + signatures) from TypeScript sources.
import ts from 'typescript';
import type { ApiKind, ApiMap } from '../model/types.js';

const ENTRY = '/__entry__.ts';

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noLib: true,
  noResolve: true,
  skipLibCheck: true,
  strict: true,
};

function kindOf(symbol: ts.Symbol): ApiKind {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Interface) return 'interface';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.TypeAlias) return 'type';
  if (f & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) return 'variable';
  if (f & ts.SymbolFlags.Module) return 'namespace';
  return 'unknown';
}

function signatureOf(checker: ts.TypeChecker, symbol: ts.Symbol, node: ts.Node): string {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const decl: ts.Node = resolved.declarations?.[0] ?? node;
  const flags: ts.TypeFormatFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const type = checker.getTypeOfSymbolAtLocation(resolved, decl);
  const kind = kindOf(resolved);
  if (kind === 'function') {
    return type
      .getCallSignatures()
      .map((s) => checker.signatureToString(s, decl, flags))
      .join(' | ');
  }
  if (kind === 'type' && ts.isTypeAliasDeclaration(decl)) return decl.type.getText().replace(/\s+/g, ' ');
  if (kind === 'enum') {
    const members = [...(resolved.exports?.values() ?? [])]
      .map((m) => `${m.name}=${m.valueDeclaration && ts.isEnumMember(m.valueDeclaration) ? JSON.stringify(checker.getConstantValue(m.valueDeclaration)) : ''}`)
      .sort();
    return `enum { ${members.join('; ')} }`;
  }
  if (kind === 'namespace') {
    const members = checker
      .getExportsOfModule(resolved)
      .map((m) => `${m.name}: ${kindOf(m)}`)
      .sort();
    return `namespace { ${members.join('; ')} }`;
  }
  if (kind === 'class' || kind === 'interface' || kind === 'type') {
    const declared = checker.getDeclaredTypeOfSymbol(resolved);
    const fmt = (p: ts.Symbol, prefix = ''): string =>
      `${prefix}${p.name}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl), decl, flags)}`;
    const isPrivate = (p: ts.Symbol): boolean => {
      const d = p.valueDeclaration;
      if (!d) return false;
      if ((ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Private) !== 0) return true;
      const name = (d as ts.NamedDeclaration).name;
      return name !== undefined && ts.isPrivateIdentifier(name);
    };
    const members = checker.getPropertiesOfType(declared).filter((p) => !isPrivate(p)).map((p) => fmt(p));
    const statics = kind === 'class' ? type.getProperties().filter((p) => p.name !== 'prototype' && !isPrivate(p)).map((p) => fmt(p, 'static ')) : [];
    members.push(...statics);
    members.sort();
    const ctor = kind === 'class' ? type.getConstructSignatures().map((s) => `new ${checker.signatureToString(s, decl, flags)}`) : [];
    if (kind === 'type' && !members.length) return checker.typeToString(declared, decl, flags);
    return [...ctor, `{ ${members.join('; ')} }`].join(' ');
  }
  return checker.typeToString(type, decl, flags);
}

function apiFromProgram(program: ts.Program, entry: string): ApiMap {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
  const api: ApiMap = {};
  if (!moduleSymbol) return api;
  for (const sym of checker.getExportsOfModule(moduleSymbol).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    api[sym.name] = { kind: kindOf(target), signature: signatureOf(checker, sym, sf) };
  }
  return api;
}

function memoryProgram(all: Record<string, string>, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, lang) => {
    const text = all[name];
    return text === undefined ? undefined : ts.createSourceFile(name, text, lang, true);
  };
  host.fileExists = (name) => name in all;
  host.readFile = (name) => all[name];
  host.directoryExists = (dir) => Object.keys(all).some((f) => f.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
  host.getDefaultLibFileName = () => '/lib.d.ts';
  return host;
}

/**
 * Extract exports from TS source text. `files` may add extra modules ({ '/other.ts': '...' })
 * that the entry can import from. Returns { name: { kind, signature } } sorted by name.
 */
export function extractApi(source: string, files: Record<string, string> = {}): ApiMap {
  const all = { ...files, [ENTRY]: source };
  const host = memoryProgram(all, OPTIONS);
  return apiFromProgram(ts.createProgram({ rootNames: Object.keys(all), options: OPTIONS, host }), ENTRY);
}

/** Extract the API from in-memory files ({ '/index.d.ts': '...' }) starting at `entry`, resolving relative imports. */
export function extractApiFromFiles(files: Record<string, string>, entry: string): ApiMap {
  const options = { ...OPTIONS, noResolve: false };
  const host = memoryProgram(files, options);
  return apiFromProgram(ts.createProgram({ rootNames: [entry], options, host }), entry);
}
