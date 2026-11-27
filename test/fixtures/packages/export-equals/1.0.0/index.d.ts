declare function legacy(input: string): string;
declare namespace legacy {
  const version: string;
  function helper(n: number): number;
  interface Options { strict: boolean }
}
export = legacy;
