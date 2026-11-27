// Cross-version type comparison. Both versions of a package are loaded into ONE
// ts.Program under synthetic roots so the checker can relate their types.
import ts from 'typescript';
import { OPTIONS, memoryProgram } from '../extract/api.js';
import type { LoadedPackage } from '../extract/package.js';

export const OLD_ROOT = '/__old__/node_modules';
export const NEW_ROOT = '/__new__/node_modules';

export type Side = 'old' | 'new';

/** `isTypeAssignableTo` is public since TypeScript 5.4 but was internal before; keep one seam so a change shows up in one place. */
interface AssignabilityChecker {
  isTypeAssignableTo?: (source: ts.Type, target: ts.Type) => boolean;
}

/** True when this TypeScript exposes the checker's assignability relation (the guard test asserts it). */
export function hasAssignability(checker: ts.TypeChecker): boolean {
  return typeof (checker as unknown as AssignabilityChecker).isTypeAssignableTo === 'function';
}

/** One program holding the old and the new declaration trees of a package. */
export class VersionPair {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  private readonly roots: Record<Side, string>;

  constructor(
    readonly oldPkg: LoadedPackage,
    readonly newPkg: LoadedPackage,
  ) {
    const name = oldPkg.name ?? newPkg.name ?? 'pkg';
    this.roots = { old: `${OLD_ROOT}/${name}`, new: `${NEW_ROOT}/${name}` };
    const all: Record<string, string> = {};
    for (const side of ['old', 'new'] as const) {
      const pkg = side === 'old' ? oldPkg : newPkg;
      for (const [path, text] of Object.entries(pkg.files)) all[this.roots[side] + path] = text;
    }
    const options: ts.CompilerOptions = { ...OPTIONS, noResolve: false };
    const rootNames = [...oldPkg.entries.map((e) => this.path('old', e.file)), ...newPkg.entries.map((e) => this.path('new', e.file))];
    this.program = ts.createProgram({ rootNames, options, host: memoryProgram(all, options) });
    this.checker = this.program.getTypeChecker();
  }

  /** Synthetic path of a package-relative file on one side. */
  path(side: Side, file: string): string {
    return `${this.roots[side]}/${file.replace(/^\//, '')}`;
  }

  /** Exports of one entry module, aliases resolved, keyed by export name. */
  exportsOf(side: Side, file: string): Map<string, ts.Symbol> {
    const out = new Map<string, ts.Symbol>();
    const sf = this.program.getSourceFile(this.path(side, file));
    const mod = sf && this.checker.getSymbolAtLocation(sf);
    if (!mod) return out;
    for (const s of this.checker.getExportsOfModule(mod)) {
      out.set(s.name, s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s);
    }
    const eq = mod.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (eq) out.set('export=', eq.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(eq) : eq);
    return out;
  }

  /** Is a value of type `from` usable where `to` is expected? Falls back to textual equality when the relation is unavailable. */
  assignable(from: ts.Type, to: ts.Type): boolean {
    if (from === to) return true;
    const rel = (this.checker as unknown as AssignabilityChecker).isTypeAssignableTo;
    if (typeof rel === 'function') return rel.call(this.checker, from, to);
    return this.text(from) === this.text(to);
  }

  text(type: ts.Type): string {
    return this.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  }
}
