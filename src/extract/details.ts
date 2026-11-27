// Structured detail for one exported symbol: overloads, type parameters, members,
// enum values and JSDoc tags. The string `signature` stays the cheap comparison key;
// this is what rules and reports use to explain a change.
import ts from 'typescript';
import type { ApiEnumMember, ApiMember, ApiParameter, ApiSignature, ApiSymbol, ApiTypeParam, Deprecation } from '../model/types.js';

const FORMAT: ts.TypeFormatFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

type Detail = Pick<ApiSymbol, 'qualifiedName' | 'signatures' | 'typeParams' | 'members' | 'enumMembers' | 'deprecated' | 'since'>;

const text = (n: ts.Node): string => n.getText().replace(/\s+/g, ' ');

function typeParamsOf(decls: readonly ts.TypeParameterDeclaration[] | undefined): ApiTypeParam[] {
  return (decls ?? []).map((d) => ({
    name: d.name.text,
    ...(d.constraint ? { constraint: text(d.constraint) } : {}),
    ...(d.default ? { default: text(d.default) } : {}),
  }));
}

/** `@deprecated` and `@since` tags of a symbol. */
function tagsOf(checker: ts.TypeChecker, symbol: ts.Symbol): { deprecated?: Deprecation; since?: string } {
  const out: { deprecated?: Deprecation; since?: string } = {};
  for (const tag of symbol.getJsDocTags(checker)) {
    const body = ts.displayPartsToString(tag.text).trim();
    if (tag.name === 'deprecated') out.deprecated = { message: body };
    else if (tag.name === 'since') out.since = body;
  }
  return out;
}

function parameterOf(checker: ts.TypeChecker, p: ts.Symbol, at: ts.Node): ApiParameter {
  const d = p.valueDeclaration;
  const decl = d && ts.isParameter(d) ? d : undefined;
  return {
    name: p.name,
    type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl ?? at), at, FORMAT),
    optional: decl ? decl.questionToken !== undefined || decl.initializer !== undefined : false,
    rest: decl ? decl.dotDotDotToken !== undefined : false,
  };
}

function signatureOf(checker: ts.TypeChecker, sig: ts.Signature, at: ts.Node, construct: boolean): ApiSignature {
  const decl = sig.getDeclaration() as ts.SignatureDeclaration | undefined;
  const str = checker.signatureToString(sig, at, FORMAT);
  return {
    text: construct ? `new ${str}` : str,
    construct,
    typeParams: typeParamsOf(decl?.typeParameters),
    parameters: sig.getParameters().map((p) => parameterOf(checker, p, at)),
    returnType: checker.typeToString(sig.getReturnType(), at, FORMAT),
  };
}

function modifiersOf(symbol: ts.Symbol): { isPrivate: boolean; isProtected: boolean; isReadonly: boolean } {
  const d = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!d) return { isPrivate: false, isProtected: false, isReadonly: false };
  const flags = ts.getCombinedModifierFlags(d);
  const name = (d as ts.NamedDeclaration).name;
  return {
    isPrivate: (flags & ts.ModifierFlags.Private) !== 0 || (name !== undefined && ts.isPrivateIdentifier(name)),
    isProtected: (flags & ts.ModifierFlags.Protected) !== 0,
    isReadonly: (flags & ts.ModifierFlags.Readonly) !== 0,
  };
}

function memberOf(checker: ts.TypeChecker, p: ts.Symbol, at: ts.Node, owner: string, isStatic: boolean): ApiMember | null {
  const mods = modifiersOf(p);
  if (mods.isPrivate) return null;
  const f = p.flags;
  const kind = f & ts.SymbolFlags.Method ? 'method' : f & ts.SymbolFlags.Accessor ? 'accessor' : 'property';
  const readonly = mods.isReadonly || (f & ts.SymbolFlags.GetAccessor && !(f & ts.SymbolFlags.SetAccessor) ? true : false);
  const tags = tagsOf(checker, p);
  return {
    name: p.name,
    qualifiedName: `${owner}.${p.name}`,
    kind,
    type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, at), at, FORMAT),
    optional: (f & ts.SymbolFlags.Optional) !== 0,
    readonly,
    static: isStatic,
    visibility: mods.isProtected ? 'protected' : 'public',
    ...(tags.deprecated ? { deprecated: tags.deprecated } : {}),
  };
}

function enumMembersOf(checker: ts.TypeChecker, symbol: ts.Symbol): ApiEnumMember[] {
  const out: ApiEnumMember[] = [];
  for (const m of symbol.exports?.values() ?? []) {
    const d = m.valueDeclaration;
    const value = d && ts.isEnumMember(d) ? checker.getConstantValue(d) : undefined;
    out.push({ name: m.name, ...(value !== undefined ? { value } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Describe `symbol` (already alias-resolved). `exported` is the public name and
 * `at` any node in the program, used as the location for type printing.
 */
export function describeSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, exported: ts.Symbol, at: ts.Node, packageName: string | null): Detail {
  const qualified = packageName ? `${packageName}#${exported.name}` : exported.name;
  const detail: Detail = { ...(packageName ? { qualifiedName: qualified } : {}) };
  const decl = symbol.declarations?.[0] ?? at;
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
  const f = symbol.flags;

  // Alias declarations carry their own JSDoc (`/** @deprecated */ export { a as b }`); the target's applies otherwise.
  const tags = { ...tagsOf(checker, symbol), ...tagsOf(checker, exported) };
  if (tags.deprecated) detail.deprecated = tags.deprecated;
  if (tags.since) detail.since = tags.since;

  if (f & ts.SymbolFlags.Function) {
    detail.signatures = type.getCallSignatures().map((s) => signatureOf(checker, s, decl, false));
  }
  if (f & ts.SymbolFlags.Class) {
    detail.signatures = type.getConstructSignatures().map((s) => signatureOf(checker, s, decl, true));
  }
  if (f & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
    const tpDecls = (symbol.declarations ?? []).flatMap((d) =>
      ts.isClassLike(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) ? [...(d.typeParameters ?? [])] : [],
    );
    const seen = new Set<string>();
    const params = typeParamsOf(tpDecls).filter((p) => !seen.has(p.name) && seen.add(p.name));
    if (params.length) detail.typeParams = params;
  }
  if (f & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const members: ApiMember[] = [];
    for (const p of checker.getPropertiesOfType(declared)) {
      const m = memberOf(checker, p, decl, qualified, false);
      if (m) members.push(m);
    }
    if (f & ts.SymbolFlags.Class) {
      for (const p of type.getProperties()) {
        if (p.name === 'prototype') continue;
        const m = memberOf(checker, p, decl, qualified, true);
        if (m) members.push(m);
      }
    }
    detail.members = members.sort((a, b) => Number(a.static) - Number(b.static) || a.name.localeCompare(b.name));
  }
  if (f & ts.SymbolFlags.Enum) detail.enumMembers = enumMembersOf(checker, symbol);
  return detail;
}
