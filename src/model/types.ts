// Pure data model shared by every stage of the pipeline. No behaviour lives here.

/** Kinds of exported symbol the extractor distinguishes. */
export type ApiKind = 'class' | 'function' | 'interface' | 'enum' | 'type' | 'variable' | 'namespace' | 'unknown';

/** One exported symbol: its kind and a normalised signature string. */
export interface ApiSymbol {
  kind: ApiKind;
  signature: string;
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
