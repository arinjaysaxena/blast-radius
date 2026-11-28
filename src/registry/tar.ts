// A small, defensive tar.gz extractor: no symlinks, no path escapes, bounded size.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

function cstring(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const text = cstring(buf, start, length).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  if (Number.isNaN(n)) throw new TarError('corrupt tar header (bad number field)');
  return n;
}

function parsePax(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let rest = Buffer.from(body, 'utf8');
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    if (space <= 0) break;
    const len = parseInt(rest.subarray(0, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= space + 1 || len > rest.length) break;
    const record = rest.subarray(space + 1, len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    rest = rest.subarray(len);
  }
  return out;
}

export interface TarEntry {
  /** Path inside the archive with the leading package directory removed. */
  path: string;
  data: Buffer;
}

/**
 * Decode a `.tgz` into regular files. npm tarballs wrap everything in one top-level directory
 * (usually `package/`), which is stripped. Directories, links and devices are ignored.
 */
export function readTarball(gz: Uint8Array): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (e) {
    throw new TarError(`not a valid gzip archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  let total = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0x30);
    const bodyStart = offset + BLOCK;
    if (bodyStart + size > tar.length) throw new TarError('truncated tar archive');
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      longName = cstring(body, 0, body.length);
      continue;
    }
    if (type === 'x') {
      pax = parsePax(body.toString('utf8'));
      continue;
    }
    if (type === 'g') continue;

    const prefix = cstring(header, 345, 155);
    const base = cstring(header, 0, 100);
    const name = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = undefined;
    pax = undefined;

    if (type !== '0' && type !== '\0') continue; // only regular files
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new TarError('archive is larger than the unpacked size limit');

    const parts = name.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.includes('..') || /^[a-z]:/i.test(parts[0] ?? '') || name.startsWith('/')) {
      throw new TarError(`unsafe path in archive: ${name}`);
    }
    if (parts.length < 2) continue; // top-level files outside the package directory
    entries.push({ path: parts.slice(1).join('/'), data: Buffer.from(body) });
  }
  return entries;
}

/** Write the entries below `dest`, refusing anything that would land outside it. */
export function writeEntries(entries: readonly TarEntry[], dest: string): void {
  const root = resolve(dest);
  for (const entry of entries) {
    const target = resolve(root, entry.path);
    if (target !== root && !target.startsWith(root + sep)) throw new TarError(`unsafe path in archive: ${entry.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

/** Extract a `.tgz` into `dest`. Returns the number of files written. */
export function extractTarball(gz: Uint8Array, dest: string): number {
  const entries = readTarball(gz);
  writeEntries(entries, dest);
  return entries.length;
}
