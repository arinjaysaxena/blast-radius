// Checker-based structural diff: classifies each API change with the compatibility rules table.
import ts from 'typescript';
import type { ApiChange, ApiKind, ChangeKind } from '../model/types.js';
import { kindOf } from '../extract/api.js';
import type { LoadedPackage } from '../extract/package.js';
import { VersionPair } from './compat.js';
import { collectPositions, typeKey, type Position } from './position.js';
import { RENAME_THRESHOLD, pairRenames, type RenameCandidate } from './rename.js';
import { compareOverloads, signatureText, typeText, type Finding, type RuleId } from './signature.js';

type Positions = Map<string, Set<Position>>;

interface Ctx {
  pair: VersionPair;
  positions: Positions;
  prefix: string;
  /** `@deprecated` messages of symbols in the OLD version, by change name; used as a rename hint. */
  deps: Map<string, string>;
}

const declOf = (s: ts.Symbol): ts.Node | undefined => s.valueDeclaration ?? s.declarations?.[0];

function deprecation(pair: VersionPair, s: ts.Symbol): string | undefined {
  const tag = s.getJsDocTags(pair.checker).find((t) => t.name === 'deprecated');
  return tag ? ts.displayPartsToString(tag.text).trim() : undefined;
}

function typeOfSymbol(pair: VersionPair, s: ts.Symbol): ts.Type {
  const d = declOf(s);
  return d ? pair.checker.getTypeOfSymbolAtLocation(s, d) : pair.checker.getTypeOfSymbol(s);
}

const isPrivate = (s: ts.Symbol): boolean => {
  const d = s.valueDeclaration;
  if (!d) return false;
  const name = (d as ts.NamedDeclaration).name;
  return (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Private) !== 0 || (name !== undefined && ts.isPrivateIdentifier(name));
};
const isReadonly = (s: ts.Symbol): boolean => {
  const d = s.valueDeclaration;
  return (!!d && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) !== 0) || (s.flags & ts.SymbolFlags.GetAccessor) !== 0 && (s.flags & ts.SymbolFlags.SetAccessor) === 0;
};

function describe(pair: VersionPair, s: ts.Symbol, kind: ApiKind): string {
  const type = typeOfSymbol(pair, s);
  if (kind === 'function') return type.getCallSignatures().map((sig) => signatureText(pair, sig)).join(' | ');
  if (kind === 'class' || kind === 'interface') {
    const props = pair.checker.getPropertiesOfType(pair.checker.getDeclaredTypeOfSymbol(s)).filter((p) => !isPrivate(p));
    return `{ ${props.map((p) => `${p.name}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${typeText(pair, typeOfSymbol(pair, p))}`).join('; ')} }`;
  }
  if (kind === 'type') return typeText(pair, pair.checker.getDeclaredTypeOfSymbol(s));
  if (kind === 'enum') return `enum { ${[...(s.exports?.keys() ?? [])].join('; ')} }`;
  return typeText(pair, type);
}

function entry(ctx: Ctx, name: string, change: ChangeKind, kind: ApiKind, findings: Finding[], extra: Partial<ApiChange> = {}): ApiChange {
  const breaking = findings.some((f) => f.rule !== 'deprecated');
  return {
    name: ctx.prefix + name,
    change,
    breaking,
    kind,
    reasons: findings.length ? findings.map((f) => f.reason) : change === 'added' ? [] : ['backwards-compatible change'],
    ...(findings.length ? { rules: [...new Set(findings.map((f) => f.rule))] } : {}),
    ...extra,
  };
}

/** Does a value of the exported type get supplied by callers, read by them, or both? */
function positionsOf(ctx: Ctx, s: ts.Symbol, kind: ApiKind): Set<Position> {
  if (kind === 'class') return new Set(['output']);
  const key = typeKey(ctx.pair.checker.getDeclaredTypeOfSymbol(s)) ?? s.name;
  return ctx.positions.get(key) ?? new Set<Position>(['input', 'output']);
}

/** Judge one value moving from `o` to `n` in the given positions. */
function compareValue(ctx: Ctx, o: ts.Type, n: ts.Type, pos: Set<Position>, label: string, rule: RuleId): Finding[] {
  const { pair } = ctx;
  const ot = typeText(pair, o);
  const nt = typeText(pair, n);
  if (ot === nt) return [];
  const out: Finding[] = [];
  if (pos.has('output') && !pair.assignable(n, o)) out.push({ rule, reason: `${label} type changed: ${ot} -> ${nt}` });
  else if (pos.has('input') && !pair.assignable(o, n)) out.push({ rule, reason: `${label} type changed: ${ot} -> ${nt}` });
  return out;
}

function compareMember(ctx: Ctx, owner: string, o: ts.Symbol, n: ts.Symbol, pos: Set<Position>, isStatic: boolean): ApiChange | undefined {
  const { pair } = ctx;
  const name = `${owner}.${isStatic ? 'static ' : ''}${o.name}`;
  const findings: Finding[] = [];
  const ot = typeOfSymbol(pair, o);
  const nt = typeOfSymbol(pair, n);
  const oSigs = o.flags & ts.SymbolFlags.Method ? ot.getCallSignatures() : [];
  const nSigs = n.flags & ts.SymbolFlags.Method ? nt.getCallSignatures() : [];
  if (oSigs.length && nSigs.length) {
    for (const f of compareOverloads(pair, oSigs, nSigs)) findings.push(f);
  } else {
    findings.push(...compareValue(ctx, ot, nt, isReadonly(n) ? new Set<Position>(['output']) : pos, `member "${o.name}"`, 'member-type-changed'));
  }
  const oOpt = (o.flags & ts.SymbolFlags.Optional) !== 0;
  const nOpt = (n.flags & ts.SymbolFlags.Optional) !== 0;
  if (oOpt && !nOpt && pos.has('input')) findings.push({ rule: 'member-required', reason: `member "${o.name}" is now required` });
  if (!oOpt && nOpt && pos.has('output')) findings.push({ rule: 'member-optional', reason: `member "${o.name}" is now optional` });
  if (!isReadonly(o) && isReadonly(n)) findings.push({ rule: 'member-readonly', reason: `member "${o.name}" is now readonly` });
  const dep = deprecation(pair, n);
  const wasDep = deprecation(pair, o);
  if (dep !== undefined && wasDep === undefined) findings.push({ rule: 'deprecated', reason: dep ? `deprecated: ${dep}` : 'deprecated' });
  if (!findings.length) return undefined;
  return entry(ctx, name, 'changed', 'variable', findings, { old: typeText(pair, ot), new: typeText(pair, nt), ...(dep !== undefined && wasDep === undefined ? { deprecated: dep } : {}) });
}

function membersOf(pair: VersionPair, s: ts.Symbol, kind: ApiKind): Map<string, { sym: ts.Symbol; isStatic: boolean }> {
  const out = new Map<string, { sym: ts.Symbol; isStatic: boolean }>();
  const declared = pair.checker.getDeclaredTypeOfSymbol(s);
  for (const p of pair.checker.getPropertiesOfType(declared)) if (!isPrivate(p)) out.set(p.name, { sym: p, isStatic: false });
  if (kind === 'class') {
    for (const p of typeOfSymbol(pair, s).getProperties()) if (p.name !== 'prototype' && !isPrivate(p)) out.set(`static ${p.name}`, { sym: p, isStatic: true });
  }
  return out;
}

function compareMembers(ctx: Ctx, name: string, kind: ApiKind, o: ts.Symbol, n: ts.Symbol): ApiChange[] {
  const { pair } = ctx;
  const pos = positionsOf(ctx, n, kind);
  const oldM = membersOf(pair, o, kind);
  const newM = membersOf(pair, n, kind);
  const out: ApiChange[] = [];
  for (const [key, om] of oldM) {
    const nm = newM.get(key);
    const label = `${name}.${key}`;
    if (!nm) {
      const dep = deprecation(pair, om.sym);
      if (dep) ctx.deps.set(ctx.prefix + label, dep);
      out.push(entry(ctx, label, 'removed', 'variable', [{ rule: 'member-removed', reason: `member "${key}" removed` }], { old: typeText(pair, typeOfSymbol(pair, om.sym)) }));
      continue;
    }
    const c = compareMember(ctx, name, om.sym, nm.sym, pos, om.isStatic);
    if (c) out.push(c);
  }
  if (kind !== 'class') {
    for (const [key, nm] of newM) {
      if (oldM.has(key)) continue;
      const required = (nm.sym.flags & ts.SymbolFlags.Optional) === 0;
      const findings: Finding[] = required && pos.has('input') ? [{ rule: 'member-required', reason: `required member "${key}" added` }] : [];
      out.push(entry(ctx, `${name}.${key}`, 'added', 'variable', findings, { new: typeText(pair, typeOfSymbol(pair, nm.sym)) }));
    }
  } else {
    for (const [key, nm] of newM) if (!oldM.has(key)) out.push(entry(ctx, `${name}.${key}`, 'added', 'variable', [], { new: typeText(pair, typeOfSymbol(pair, nm.sym)) }));
  }
  return out;
}

function enumValues(pair: VersionPair, s: ts.Symbol): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.exports?.values() ?? []) {
    const d = m.valueDeclaration;
    const v = d && ts.isEnumMember(d) ? pair.checker.getConstantValue(d) : undefined;
    out.set(m.name, v === undefined ? '<computed>' : JSON.stringify(v));
  }
  return out;
}

function compareSymbol(ctx: Ctx, name: string, o: ts.Symbol, n: ts.Symbol): ApiChange[] {
  const { pair } = ctx;
  const ok = kindOf(o);
  const nk = kindOf(n);
  const base = { old: describe(pair, o, ok), new: describe(pair, n, nk) };
  if (ok !== nk) return [entry(ctx, name, 'changed', nk, [{ rule: 'kind-changed', reason: `kind changed: ${ok} -> ${nk}` }], base)];

  const findings: Finding[] = [];
  const children: ApiChange[] = [];
  if (ok === 'function') {
    findings.push(...compareOverloads(pair, typeOfSymbol(pair, o).getCallSignatures(), typeOfSymbol(pair, n).getCallSignatures()));
  } else if (ok === 'class' || ok === 'interface') {
    if (ok === 'class') {
      findings.push(...compareOverloads(pair, typeOfSymbol(pair, o).getConstructSignatures(), typeOfSymbol(pair, n).getConstructSignatures()).map((f) => ({ ...f, reason: `constructor: ${f.reason}` })));
    }
    children.push(...compareMembers(ctx, name, ok, o, n));
  } else if (ok === 'enum') {
    const ov = enumValues(pair, o);
    const nv = enumValues(pair, n);
    for (const [k, v] of ov) {
      const next = nv.get(k);
      if (next === undefined) findings.push({ rule: 'enum-member-removed', reason: `enum member "${k}" removed` });
      else if (next !== v) findings.push({ rule: 'enum-value-changed', reason: `enum member "${k}" value changed: ${v} -> ${next}` });
    }
  } else if (ok === 'type') {
    findings.push(...compareValue(ctx, pair.checker.getDeclaredTypeOfSymbol(o), pair.checker.getDeclaredTypeOfSymbol(n), positionsOf(ctx, n, ok), 'alias', 'type-changed').map((f) => ({ ...f, reason: f.reason.replace('alias type changed', 'type alias changed') })));
  } else if (ok === 'variable') {
    findings.push(...compareValue(ctx, typeOfSymbol(pair, o), typeOfSymbol(pair, n), new Set<Position>(['output']), 'variable', 'type-changed'));
  }

  const dep = deprecation(pair, n);
  const newlyDeprecated = dep !== undefined && deprecation(pair, o) === undefined;
  if (newlyDeprecated) findings.push({ rule: 'deprecated', reason: dep ? `deprecated: ${dep}` : 'deprecated' });
  const own = findings.length ? [entry(ctx, name, 'changed', nk, findings, { ...base, ...(newlyDeprecated ? { deprecated: dep } : {}) })] : [];
  return [...own, ...children];
}

/** Signature-level changes on one module's exports. */
function diffModule(ctx: Ctx, oldExports: Map<string, ts.Symbol>, newExports: Map<string, ts.Symbol>): ApiChange[] {
  const out: ApiChange[] = [];
  for (const [name, o] of oldExports) {
    const n = newExports.get(name);
    if (!n) {
      const kind = kindOf(o);
      const dep = deprecation(ctx.pair, o);
      if (dep) ctx.deps.set(ctx.prefix + name, dep);
      out.push(entry(ctx, name, 'removed', kind, [{ rule: 'symbol-removed', reason: 'removed from the public API' }], { old: describe(ctx.pair, o, kind) }));
    } else out.push(...compareSymbol(ctx, name, o, n));
  }
  for (const [name, n] of newExports) {
    if (oldExports.has(name)) continue;
    const kind = kindOf(n);
    out.push(entry(ctx, name, 'added', kind, [], { new: describe(ctx.pair, n, kind) }));
  }
  return out;
}

/** Pair removed and added entries that look like renames, per owner (module scope or class/interface). */
function applyRenames(ctx: Ctx, changes: ApiChange[]): ApiChange[] {
  const ownerOf = (name: string): string => {
    const rest = name.slice(ctx.prefix.length);
    return rest.includes('.') ? rest.slice(0, rest.lastIndexOf('.')) : '';
  };
  const candidate = (c: ApiChange, shape: string | undefined): RenameCandidate => ({
    name: c.name,
    kind: c.kind,
    shape: shape ?? '',
    ...(ctx.deps.has(c.name) ? { deprecation: ctx.deps.get(c.name) } : {}),
  });
  const owners = new Set(changes.filter((c) => c.change === 'removed' || c.change === 'added').map((c) => ownerOf(c.name)));
  const dropped = new Set<ApiChange>();
  const renamed: ApiChange[] = [];
  for (const owner of owners) {
    const rem = changes.filter((c) => c.change === 'removed' && ownerOf(c.name) === owner);
    const add = changes.filter((c) => c.change === 'added' && ownerOf(c.name) === owner);
    const byName = new Map([...rem, ...add].map((c) => [c.name, c]));
    const pairs = pairRenames(rem.map((c) => candidate(c, c.old)), add.map((c) => candidate(c, c.new)), RENAME_THRESHOLD);
    for (const p of pairs) {
      const from = byName.get(p.from);
      const to = byName.get(p.to);
      if (!from || !to) continue;
      dropped.add(from);
      dropped.add(to);
      const target = to.name.slice(ctx.prefix.length);
      renamed.push({
        name: from.name,
        change: 'renamed',
        breaking: true,
        kind: to.kind,
        ...(from.old !== undefined ? { old: from.old } : {}),
        ...(to.new !== undefined ? { new: to.new } : {}),
        renamedTo: target,
        confidence: p.confidence,
        reasons: [`renamed to "${target}" (confidence ${p.confidence.toFixed(2)})`],
        rules: ['symbol-renamed'],
        ...(ctx.deps.has(from.name) ? { deprecated: ctx.deps.get(from.name) } : {}),
      });
    }
  }
  return [...changes.filter((c) => !dropped.has(c)), ...renamed];
}

/** Diff every module (subpath export) of two package versions with the type checker. Sorted by name. */
export function diffPackages(oldPkg: LoadedPackage, newPkg: LoadedPackage): ApiChange[] {
  const pair = new VersionPair(oldPkg, newPkg);
  const newByPath = new Map(newPkg.entries.map((e) => [e.subpath, e.file]));
  const oldByPath = new Map(oldPkg.entries.map((e) => [e.subpath, e.file]));
  const out: ApiChange[] = [];
  for (const sub of new Set([...oldByPath.keys(), ...newByPath.keys()])) {
    const of = oldByPath.get(sub);
    const nf = newByPath.get(sub);
    const prefix = sub === '.' ? '' : `${sub}#`;
    const oldExports = of ? pair.exportsOf('old', of) : new Map<string, ts.Symbol>();
    const newExports = nf ? pair.exportsOf('new', nf) : new Map<string, ts.Symbol>();
    const positions = collectPositions(pair.checker, [...oldExports.values(), ...newExports.values()]);
    const ctx: Ctx = { pair, positions, prefix, deps: new Map() };
    out.push(...applyRenames(ctx, diffModule(ctx, oldExports, newExports)));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
