// Pure data model shared by every stage of the pipeline. No behaviour lives here.

/** Kinds of exported symbol the extractor distinguishes. */
export type ApiKind = 'class' | 'function' | 'interface' | 'enum' | 'type' | 'variable' | 'namespace' | 'unknown';

export interface ApiTypeParam {
  name: string;
  constraint?: string;
  default?: string;
}

export interface ApiParameter {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
}

/** One call or construct signature. */
export interface ApiSignature {
  /** Rendered signature, e.g. `<T>(input: T, strict?: boolean): string`. */
  text: string;
  construct: boolean;
  typeParams: ApiTypeParam[];
  parameters: ApiParameter[];
  returnType: string;
}

export type MemberKind = 'property' | 'method' | 'accessor';
export type Visibility = 'public' | 'protected';

/** A property, method or accessor of a class or interface. */
export interface ApiMember {
  name: string;
  qualifiedName: string;
  kind: MemberKind;
  type: string;
  optional: boolean;
  readonly: boolean;
  static: boolean;
  visibility: Visibility;
  deprecated?: Deprecation;
}

export interface ApiEnumMember {
  name: string;
  /** Constant value, or `undefined` when it is computed. */
  value?: string | number;
}

/** A JSDoc `@deprecated` tag; `message` is empty when the tag has no text. */
export interface Deprecation {
  message: string;
}

/** One exported symbol: its kind and a normalised signature string, plus structured detail. */
export interface ApiSymbol {
  kind: ApiKind;
  signature: string;
  /** `pkg#Name`; members extend it (`pkg#ZodString.email`). Absent when the package name is unknown. */
  qualifiedName?: string;
  signatures?: ApiSignature[];
  typeParams?: ApiTypeParam[];
  members?: ApiMember[];
  enumMembers?: ApiEnumMember[];
  deprecated?: Deprecation;
  since?: string;
}

/** The public API of one package version, keyed by export name. */
export type ApiMap = Record<string, ApiSymbol>;

export type ChangeKind = 'added' | 'removed' | 'renamed' | 'changed';

/** One difference between two versions of the public API. */
export interface ApiChange {
  name: string;
  change: ChangeKind;
  breaking: boolean;
  kind: ApiKind;
  old?: string;
  new?: string;
  renamedTo?: string;
  reasons: string[];
  /** Ids from the compatibility rules table that fired (checker-based engine only). */
  rules?: string[];
  /** Deprecation message when the change is, or comes with, a new `@deprecated` tag. */
  deprecated?: string;
}

export interface DiffSummary {
  total: number;
  breaking: number;
  added: number;
  removed: number;
  renamed: number;
  changed: number;
}

export type SiteKind = 'import' | 'use';

/** A place in the user's project that references a symbol of the analysed package. */
export interface CallSite {
  file: string;
  line: number;
  column: number;
  /** Exported name from the package; `default` for default imports, `*` for bare namespace use. */
  symbol: string;
  kind: SiteKind;
  text: string;
}

export interface ImpactedSymbol {
  name: string;
  change: ChangeKind;
  breaking: boolean;
  renamedTo: string | null;
  reasons: string[];
  sites: Pick<CallSite, 'file' | 'line' | 'column' | 'kind'>[];
}

export interface ReportSummary extends DiffSummary {
  impactedSymbols: number;
  callSites: number;
}

/** The complete, serialisable result of one analysis. */
export interface Report {
  package: string | null;
  from: string;
  to: string;
  scanned: boolean;
  summary: ReportSummary;
  changes: ApiChange[];
  impacted: ImpactedSymbol[];
  untouched: string[];
}
