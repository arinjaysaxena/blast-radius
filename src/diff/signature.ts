// Call and construct signature compatibility, judged by the checker.
import ts from 'typescript';
import type { VersionPair } from './compat.js';

/** Every rule of the compatibility table; a golden test exists for each. */
export const RULES = [
  'symbol-removed',
  'kind-changed',
  'parameter-added-required',
  'parameter-removed',
  'parameter-now-required',
  'parameter-type-narrowed',
  'return-type-widened',
  'overload-removed',
  'constraint-tightened',
  'type-parameter-added',
  'member-removed',
  'member-required',
  'member-optional',
  'member-type-changed',
  'member-readonly',
  'enum-member-removed',
  'enum-value-changed',
  'type-changed',
  'deprecated',
] as const;

export type RuleId = (typeof RULES)[number];

export interface Finding {
  rule: RuleId;
  reason: string;
}

const FLAGS: ts.TypeFormatFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

export const typeText = (pair: VersionPair, t: ts.Type): string => pair.checker.typeToString(t, undefined, FLAGS);

export function signatureText(pair: VersionPair, sig: ts.Signature): string {
  return pair.checker.signatureToString(sig, undefined, FLAGS);
}

function paramType(pair: VersionPair, p: ts.Symbol, sig: ts.Signature): ts.Type {
  const d = p.valueDeclaration ?? p.declarations?.[0] ?? sig.getDeclaration();
  return pair.checker.getTypeOfSymbolAtLocation(p, d);
}

const isOptional = (p: ts.Symbol): boolean => {
  const d = p.valueDeclaration;
  return !!d && ts.isParameter(d) && (d.questionToken !== undefined || d.initializer !== undefined || d.dotDotDotToken !== undefined);
};
const isRest = (p: ts.Symbol): boolean => {
  const d = p.valueDeclaration;
  return !!d && ts.isParameter(d) && d.dotDotDotToken !== undefined;
};

/** For a rest parameter the element type is what each argument must satisfy. */
function elementIfRest(pair: VersionPair, p: ts.Symbol, t: ts.Type): ts.Type {
  if (!isRest(p) || !pair.checker.isArrayType(t)) return t;
  return pair.checker.getTypeArguments(t as ts.TypeReference)[0] ?? t;
}

/** Type text mentions one of the signature's own type parameters (cross-version relation is meaningless then). */
function generic(text: string, names: string[]): boolean {
  return names.some((n) => new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}($|[^\\w$])`).test(text));
}

/** Differences that make `next` unusable by callers written against `prev`. Empty = compatible. */
export function compareSignatures(pair: VersionPair, prev: ts.Signature, next: ts.Signature): Finding[] {
  const out: Finding[] = [];
  const tpOld = prev.getTypeParameters() ?? [];
  const tpNew = next.getTypeParameters() ?? [];
  const names = [...tpOld, ...tpNew].map((t) => t.symbol.name);
  // Type parameters are positional: `<T>(a: T)` and `<U>(a: U)` are the same signature.
  const canon = (text: string, tps: readonly ts.TypeParameter[]): string =>
    tps.reduce((acc, tp, i) => acc.replace(new RegExp(`(?<![\\w$])${tp.symbol.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'), `\u0000${i}`), text);

  /** `from` (what callers used to pass / get back) must be accepted by `to`. */
  const accepts = (from: ts.Type, to: ts.Type, fromTps: readonly ts.TypeParameter[], toTps: readonly ts.TypeParameter[]): boolean => {
    const a = typeText(pair, from);
    const b = typeText(pair, to);
    if (a === b || canon(a, fromTps) === canon(b, toTps)) return true;
    if (generic(a, names) || generic(b, names)) return false;
    return pair.assignable(from, to);
  };

  const po = prev.getParameters();
  const pn = next.getParameters();
  const lastNew = pn[pn.length - 1];
  const newRest = lastNew !== undefined && isRest(lastNew);
  for (let i = 0; i < Math.max(po.length, pn.length); i++) {
    const o = po[i];
    const n = pn[i];
    if (o && !n) {
      if (!newRest) out.push({ rule: 'parameter-removed', reason: `parameter "${o.name}" removed` });
    } else if (!o && n) {
      if (!isOptional(n)) out.push({ rule: 'parameter-added-required', reason: `required parameter "${n.name}" added` });
    } else if (o && n) {
      const ot = elementIfRest(pair, o, paramType(pair, o, prev));
      const nt = elementIfRest(pair, n, paramType(pair, n, next));
      if (!accepts(ot, nt, tpOld, tpNew)) {
        out.push({ rule: 'parameter-type-narrowed', reason: `parameter "${n.name}" type changed: ${typeText(pair, ot)} -> ${typeText(pair, nt)}` });
      }
      if (isOptional(o) && !isOptional(n)) out.push({ rule: 'parameter-now-required', reason: `parameter "${n.name}" is now required` });
    }
  }

  const ro = prev.getReturnType();
  const rn = next.getReturnType();
  if (!accepts(rn, ro, tpNew, tpOld)) out.push({ rule: 'return-type-widened', reason: `return type changed: ${typeText(pair, ro)} -> ${typeText(pair, rn)}` });

  for (let i = 0; i < Math.max(tpOld.length, tpNew.length); i++) {
    const o = tpOld[i];
    const n = tpNew[i];
    if (!n) continue;
    if (!o) {
      if (!n.getDefault()) out.push({ rule: 'type-parameter-added', reason: `type parameter "${n.symbol.name}" added without a default` });
      continue;
    }
    const nc = n.getConstraint();
    if (!nc) continue;
    const oc = o.getConstraint();
    const nct = typeText(pair, nc);
    if (!oc) {
      if (nct !== 'unknown') out.push({ rule: 'constraint-tightened', reason: `type parameter "${n.symbol.name}" now requires ${nct}` });
    } else if (typeText(pair, oc) !== nct && (generic(nct, names) || !pair.assignable(oc, nc))) {
      out.push({ rule: 'constraint-tightened', reason: `type parameter "${n.symbol.name}" constraint tightened: ${typeText(pair, oc)} -> ${nct}` });
    }
  }
  return out;
}

/**
 * Compare two overload sets. Every old overload must still be accepted by some new one; the
 * findings of the closest new overload explain a single-signature change.
 */
export function compareOverloads(pair: VersionPair, olds: readonly ts.Signature[], news: readonly ts.Signature[]): Finding[] {
  if (olds.length === 1 && news.length === 1 && olds[0] && news[0]) return compareSignatures(pair, olds[0], news[0]);
  const out: Finding[] = [];
  for (const o of olds) {
    const best = news.map((n) => compareSignatures(pair, o, n)).sort((a, b) => a.length - b.length)[0];
    if (best && best.length === 0) continue;
    out.push({ rule: 'overload-removed', reason: `no remaining overload accepts ${signatureText(pair, o)}` });
  }
  return out;
}
