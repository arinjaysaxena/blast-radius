import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { scanProject } from '../src/scan.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
function pkg(version, dts) {
  const d = tmp('br-e2e-pkg-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'shapes', version, types: 'index.d.ts' }));
  writeFileSync(join(d, 'index.d.ts'), dts);
  return d;
}

const OLD = pkg('1.0.0', `
export interface Options { color: string; size?: number }
export class Circle { constructor(r: number); area(): number; }
export function draw(c: Circle, o?: Options): void;
export function legacy(): void;
export const VERSION: string;
`);
const NEW = pkg('2.0.0', `
export interface Options { color: string; size: number }
export class Circle { constructor(r: number, unit: string); area(): number; }
export function draw(c: Circle, o: Options): void;
export const VERSION: string;
export function extra(): void;
`);

function project() {
  const d = tmp('br-e2e-proj-');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src/a.ts'), "import { Circle, draw, legacy, VERSION } from 'shapes';\nconst c = new Circle(2);\ndraw(c);\nlegacy();\nconsole.log(VERSION);\n");
  writeFileSync(join(d, 'src/b.js'), "const { draw } = require('shapes');\ndraw(null);\n");
  writeFileSync(join(d, 'src/unrelated.ts'), 'export const x = 1;\n');
  // A huge generated bundle that mentions the package must be skipped, not parsed.
  writeFileSync(join(d, 'src/bundle.js'), `// shapes\n${'var a=1;'.repeat(200000)}\n`);
  return d;
}

test('end to end: JSON report lists breaking changes and affected sites', () => {
  const lines = [];
  const code = main([OLD, NEW, '--project', project(), '--format', 'json', '--fail-on-breaking'], { log: (m) => lines.push(m) });
  assert.equal(code, 1);
  const report = JSON.parse(lines.join('\n'));
  assert.ok(report.summary.breaking >= 3, JSON.stringify(report.summary));
  const files = new Set(JSON.stringify(report).match(/src\/[\w.]+/g));
  assert.ok(files.has('src/a.ts') && files.has('src/b.js'));
  assert.ok(!files.has('src/unrelated.ts'));
});

test('end to end: markdown report names the removed symbol', () => {
  const lines = [];
  assert.equal(main([OLD, NEW, '--project', project()], { log: (m) => lines.push(m) }), 0);
  assert.match(lines.join('\n'), /legacy/);
});

test('scanProject skips oversized files and reports them', () => {
  const skipped = [];
  const sites = scanProject(project(), 'shapes', { onSkip: (f) => skipped.push(f) });
  assert.deepEqual(skipped, ['src/bundle.js']);
  assert.ok(sites.length > 0);
  assert.ok(sites.every((s) => s.file !== 'src/bundle.js'));
});

test('scanProject honours the file limit', () => {
  const d = tmp('br-e2e-many-');
  for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}.ts`), "import { draw } from 'shapes';\ndraw();\n");
  const files = new Set(scanProject(d, 'shapes', { maxFiles: 10 }).map((s) => s.file));
  assert.equal(files.size, 10);
});
