/** Parse a value. */
export declare function parse(input: string, strict?: boolean): number;
export declare function parse(input: number, ...rest: string[]): number;
/** @deprecated Use {@link parse} instead. */
export declare function parseLegacy(input: string): number;
export declare function identity<T extends object = {}>(value: T): T;
/** @since 2.1.0 */
export declare class Store<K extends string, V = unknown> {
  constructor(name: string);
  readonly name: string;
  protected cache: Map<K, V>;
  private secret;
  get(key: K): V | undefined;
  /** @deprecated Use `get`. */
  fetch(key: K): V | undefined;
  static create(): Store<string>;
  get size(): number;
  maybe?: string;
}
export interface Options<T> { retries: number; label?: string; onDone(value: T): void }
export type Pair<A, B = A> = [A, B];
export declare enum Level { Debug = 0, Info = 1, Warn = "warn" }
export declare const enum Flag { A = 1, B = 2 }
