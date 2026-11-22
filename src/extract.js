// Extract the public API (exported symbols + signatures) from TypeScript sources.
import ts from 'typescript';

const ENTRY = '/__entry__.ts';

const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noLib: true,
  noResolve: true,
  skipLibCheck: true,
  strict: true,
};

function kindOf(symbol) {
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

function signatureOf(checker, symbol, node) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const decl = resolved.declarations?.[0] ?? node;
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const type = checker.getTypeOfSymbolAtLocation(resolved, decl);
  const kind = kindOf(resolved);
  if (kind === 'function') {
    return type
      .getCallSignatures()
      .map((s) => checker.signatureToString(s, decl, flags))
      .join(' | ');
  }
  if (kind === 'type' && ts.isTypeAliasDeclaration(decl)) return decl.type.getText().replace(/\s+/g, ' ');
  if (kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'type') {
    const declared = checker.getDeclaredTypeOfSymbol(resolved);
    const members = checker
      .getPropertiesOfType(declared)
      .map((p) => `${p.name}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl), decl, flags)}`)
      .sort();
    const ctor = kind === 'class' ? type.getConstructSignatures().map((s) => `new ${checker.signatureToString(s, decl, flags)}`) : [];
    if (kind === 'type' && !members.length) return checker.typeToString(declared, decl, flags);
    return [...ctor, `{ ${members.join('; ')} }`].join(' ');
  }
  return checker.typeToString(type, decl, flags);
}

/**
 * Extract exports from TS source text. `files` may add extra modules ({ '/other.ts': '...' })
 * that the entry can import from. Returns { name: { kind, signature } } sorted by name.
 */
export function extractApi(source, files = {}) {
  const all = { ...files, [ENTRY]: source };
  const host = ts.createCompilerHost(OPTIONS);
  host.getSourceFile = (name, lang) => (name in all ? ts.createSourceFile(name, all[name], lang, true) : undefined);
  host.fileExists = (name) => name in all;
  host.readFile = (name) => all[name];
  host.getDefaultLibFileName = () => '/lib.d.ts';
  const program = ts.createProgram({ rootNames: Object.keys(all), options: OPTIONS, host });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(ENTRY);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const api = {};
  if (!moduleSymbol) return api;
  for (const sym of checker.getExportsOfModule(moduleSymbol).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    api[sym.name] = { kind: kindOf(target), signature: signatureOf(checker, sym, sf) };
  }
  return api;
}
