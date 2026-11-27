// Variance: is an exported type consumed by callers (output), supplied by them (input), or both?
import ts from 'typescript';

export type Position = 'input' | 'output';

const MAX_DEPTH = 6;

/** Name used to identify a type across the exported API (alias name wins, then symbol name). */
export function typeKey(type: ts.Type): string | undefined {
  return (type.aliasSymbol ?? type.getSymbol())?.name;
}

/**
 * Walk every exported call and construct signature and record, per named type, whether it is reachable
 * from a parameter (input), a return or variable type (output), or both. Callback parameters flip direction.
 */
export function collectPositions(checker: ts.TypeChecker, roots: Iterable<ts.Symbol>): Map<string, Set<Position>> {
  const out = new Map<string, Set<Position>>();
  const seen = new Set<string>();
  const flip = (p: Position): Position => (p === 'input' ? 'output' : 'input');

  const visit = (type: ts.Type, pos: Position, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const key = typeKey(type);
    if (key && !key.startsWith('__')) {
      const id = `${key}:${pos}`;
      if (seen.has(id)) return;
      seen.add(id);
      let set = out.get(key);
      if (!set) out.set(key, (set = new Set()));
      set.add(pos);
    }
    if (type.isUnionOrIntersection()) for (const t of type.types) visit(t, pos, depth + 1);
    if (checker.isArrayType(type) || checker.isTupleType(type) || (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) {
      for (const t of checker.getTypeArguments(type as ts.TypeReference)) visit(t, pos, depth + 1);
    }
    for (const sig of type.getCallSignatures()) signature(sig, pos, depth + 1);
    for (const p of type.getProperties()) {
      const d = p.valueDeclaration ?? p.declarations?.[0];
      if (d) visit(checker.getTypeOfSymbolAtLocation(p, d), pos, depth + 1);
    }
  };

  const signature = (sig: ts.Signature, pos: Position, depth: number): void => {
    for (const p of sig.getParameters()) {
      const d = p.valueDeclaration ?? p.declarations?.[0];
      if (d) visit(checker.getTypeOfSymbolAtLocation(p, d), flip(pos), depth);
    }
    visit(sig.getReturnType(), pos, depth);
  };

  for (const sym of roots) {
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!d) continue;
    const type = checker.getTypeOfSymbolAtLocation(sym, d);
    for (const sig of [...type.getCallSignatures(), ...type.getConstructSignatures()]) signature(sig, 'output', 0);
    if (sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) visit(type, 'output', 0);
    if (sym.flags & ts.SymbolFlags.Class) {
      for (const p of type.getProperties()) {
        const pd = p.valueDeclaration ?? p.declarations?.[0];
        if (pd) visit(checker.getTypeOfSymbolAtLocation(p, pd), 'output', 1);
      }
      const declared = checker.getDeclaredTypeOfSymbol(sym);
      for (const p of checker.getPropertiesOfType(declared)) {
        const pd = p.valueDeclaration ?? p.declarations?.[0];
        if (pd) visit(checker.getTypeOfSymbolAtLocation(p, pd), 'output', 1);
      }
    }
  }
  return out;
}
