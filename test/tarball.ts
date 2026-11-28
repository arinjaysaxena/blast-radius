import { gzipSync } from 'node:zlib';

function field(value: string, length: number): Buffer {
  const b = Buffer.alloc(length);
  b.write(value, 0, 'utf8');
  return b;
}

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  field(name.slice(0, 100), 100).copy(h, 0);
  field('0000644\0', 8).copy(h, 100);
  field('0000000\0', 8).copy(h, 108);
  field('0000000\0', 8).copy(h, 116);
  field(size.toString(8).padStart(11, '0') + '\0', 12).copy(h, 124);
  field('00000000000\0', 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of h) sum += byte;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 8).copy(h, 148);
  return h;
}

const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

export interface TarFile {
  name: string;
  content?: string;
  /** Tar type flag; defaults to a regular file. */
  type?: string;
}

/** Build an in-memory `.tgz` from entries (names are used verbatim, so include `package/`). */
export function makeTgz(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.content ?? '', 'utf8');
    const type = f.type ?? '0';
    if (f.name.length > 100) {
      const longBody = Buffer.from(f.name + '\0');
      parts.push(header('././@LongLink', longBody.length, 'L'), pad(longBody));
    }
    parts.push(header(f.name, body.length, type), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A minimal npm-style package tarball. */
export function packageTgz(name: string, version: string, extra: Record<string, string> = {}): Buffer {
  const files: TarFile[] = [
    { name: 'package/package.json', content: JSON.stringify({ name, version, types: 'index.d.ts' }) },
    { name: 'package/index.d.ts', content: `export declare const version: "${version}";\n` },
    ...Object.entries(extra).map(([n, content]) => ({ name: `package/${n}`, content })),
  ];
  return makeTgz(files);
}
