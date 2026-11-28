import { describe, expect, it } from 'vitest';
import { main } from '../src/cli/index.js';
import { scanProject } from '../src/usage/index.js';
import { tmpDir, writeTree } from './helpers.js';
import { mapResolver, pkgDir } from './cli-fixtures.js';

const OLD = `
export interface Options { color: string; size?: number }
export class Circle { constructor(r: number); area(): number; }
export function draw(c: Circle, o?: Options): void;
export function legacy(): void;
export const VERSION: string;
`;
const NEW = `
export interface Options { color: string; size: number }
export class Circle { constructor(r: number, unit: string); area(): number; }
export function draw(c: Circle, o: Options): void;
export const VERSION: string;
export function extra(): void;
`;

function project(): string {
  const d = tmpDir('br-pipe-proj-');
  writeTree(d, {
    'src/a.ts': "import { Circle, draw, legacy, VERSION } from 'shapes';\nconst c = new Circle(2);\ndraw(c);\nlegacy();\nconsole.log(VERSION);\n",
    'src/b.js': "const { draw } = require('shapes');\ndraw(null);\n",
    'src/unrelated.ts': 'export const x = 1;\n',
    'src/bundle.js': `// shapes\n${'var a=1;'.repeat(200_000)}\n`,
  });
  return d;
}

const resolver = () => mapResolver({ old: pkgDir('shapes', '1.0.0', OLD), new: pkgDir('shapes', '2.0.0', NEW) });

describe('end to end (offline fixtures)', () => {
  it('JSON report lists breaking changes and affected sites in TS and JS files', async () => {
    const out: string[] = [];
    const code = await main(['old', 'new', '--project', project(), '--format', 'json', '--fail-on-breaking'], {
      log: (m) => out.push(m), warn: () => undefined, resolver: resolver(),
    });
    expect(code).toBe(1);
    const report = JSON.parse(out.join('\n')) as { summary: { breaking: number } };
    expect(report.summary.breaking).toBeGreaterThanOrEqual(3);
    const files = new Set(JSON.stringify(report).match(/src\/[\w.]+/g));
    expect(files.has('src/a.ts')).toBe(true);
    expect(files.has('src/b.js')).toBe(true);
    expect(files.has('src/unrelated.ts')).toBe(false);
  });

  it('warns about skipped bundles on stderr and still names the removed symbol', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(['old', 'new', '--project', project()], { log: (m) => out.push(m), warn: (m) => err.push(m), resolver: resolver() })).toBe(0);
    expect(out.join('\n')).toMatch(/legacy/);
    expect(err).toEqual([expect.stringMatching(/^warning: skipped src[\\/]bundle\.js/)]);
  });

  it('--max-files bounds the scan', () => {
    const d = tmpDir('br-pipe-many-');
    for (let i = 0; i < 30; i++) writeTree(d, { [`f${i}.ts`]: "import { draw } from 'shapes';\ndraw();\n" });
    const files = new Set(scanProject(d, 'shapes', { maxFiles: 10 }).map((s) => s.file));
    expect(files.size).toBe(10);
  });
});
