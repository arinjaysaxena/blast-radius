import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiChange, ApiMap, ApiSymbol } from '../src/model/types.js';

/** Look up an exported symbol, failing the test loudly when it is missing. */
export function sym(api: ApiMap, name: string): ApiSymbol {
  const s = api[name];
  if (!s) throw new Error(`expected export "${name}", found: ${Object.keys(api).join(', ')}`);
  return s;
}

/** Find the diff entry for `name`, if any. */
export const entryFor = (entries: ApiChange[], name: string): ApiChange | undefined => entries.find((e) => e.name === name);

/** Like `entryFor` but throws when missing. */
export function mustEntry(entries: ApiChange[], name: string): ApiChange {
  const e = entryFor(entries, name);
  if (!e) throw new Error(`expected diff entry "${name}", found: ${entries.map((x) => x.name).join(', ')}`);
  return e;
}

export const tmpDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** Write `{ 'rel/path': content }` under `root`, creating directories. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
