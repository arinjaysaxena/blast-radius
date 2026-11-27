import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, main, run } from '../src/cli.js';
import { parseSpec, createResolver } from '../src/fetch.js';

function pkgDir(version, dts) {
  const d = mkdtempSync(join(tmpdir(), 'br-pkg-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'lib', version, types: 'index.d.ts' }));
  writeFileSync(join(d, 'index.d.ts'), dts);
  return d;
}
const OLD = 'export function parse(s: string): number;\nexport function gone(): void;\n';
const NEW = 'export function parse(s: string, strict: boolean): number;\n';

function project() {
  const d = mkdtempSync(join(tmpdir(), 'br-proj-'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src/a.ts'), "import { parse, gone } from 'lib';\nparse('x');\ngone();\n");
  return d;
}

test('parseArgs validates input', () => {
  const o = parseArgs(['a', 'b', '--project', 'p', '--format', 'json', '--fail-on-breaking']);
  assert.deepEqual([o.old, o.new, o.project, o.format, o.failOnBreaking], ['a', 'b', 'p', 'json', true]);
  assert.throws(() => parseArgs(['a']), /two arguments/);
  assert.throws(() => parseArgs(['a', 'b', '--format', 'xml']), /md or json/);
  assert.throws(() => parseArgs(['a', 'b', '--zzz']), /unknown option/);
  assert.throws(() => parseArgs(['a', 'b', '--out']), /needs a value/);
});

test('parseSpec handles scoped and unversioned names', () => {
  assert.deepEqual(parseSpec('lodash@4.17.20'), { name: 'lodash', version: '4.17.20' });
  assert.deepEqual(parseSpec('@a/b@^2'), { name: '@a/b', version: '^2' });
  assert.deepEqual(parseSpec('left-pad'), { name: 'left-pad', version: 'latest' });
  assert.equal(parseSpec('./some/dir'), null);
});

test('run diffs two directories and maps call sites', () => {
  const { report, text } = run({ old: pkgDir('1.0.0', OLD), new: pkgDir('2.0.0', NEW), project: project(), format: 'md' });
  assert.equal(report.from, '1.0.0');
  assert.equal(report.summary.impactedSymbols, 2);
  assert.match(text, /places in your code touch changed APIs/);
});

test('main exit codes: --fail-on-breaking, json output and errors', () => {
  const lines = [];
  const log = (m) => lines.push(m);
  const args = [pkgDir('1.0.0', OLD), pkgDir('2.0.0', NEW)];
  assert.equal(main(args, { log }), 0);
  assert.equal(main([...args, '--fail-on-breaking', '--format', 'json'], { log }), 1);
  assert.equal(JSON.parse(lines.at(-1)).summary.breaking, 2);
  assert.equal(main(['only-one'], { log }), 2);
  const empty = mkdtempSync(join(tmpdir(), 'br-empty-'));
  assert.equal(main([empty, args[1]], { log }), 2);
  assert.match(lines.at(-1), /No package\.json/);
});

test('resolver fetches pkg@version through an injected exec (no network)', () => {
  const src = pkgDir('3.0.0', NEW);
  const calls = [];
  // Simulate `npm pack`: build a real tarball with a top-level "package/" folder.
  const exec = (cmd, args, cwd) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npm') {
      const stage = mkdtempSync(join(tmpdir(), 'br-stage-'));
      mkdirSync(join(stage, 'package'));
      execFileSync('cp', [join(src, 'package.json'), join(src, 'index.d.ts'), join(stage, 'package')]);
      execFileSync('tar', ['-czf', join(cwd, 'lib-3.0.0.tgz'), '-C', stage, 'package']);
      return 'lib-3.0.0.tgz\n';
    }
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
  };
  const r = createResolver({ exec });
  const { dir, label } = r.resolve('lib@3.0.0');
  assert.equal(label, 'lib@3.0.0');
  assert.deepEqual(calls[0].slice(0, 2), ['npm', 'pack']);
  const { report } = run({ old: pkgDir('1.0.0', OLD), new: 'lib@3.0.0', project: null, format: 'md' }, { resolver: r });
  assert.equal(report.to, '3.0.0');
  assert.ok(dir.includes('blast-radius-'));
  assert.throws(() => r.resolve('./not/a/dir'), /neither a directory nor/);
  const failing = createResolver({ exec: () => { throw Object.assign(new Error('x'), { stderr: 'E404 not found\nmore' }); } });
  assert.throws(() => failing.resolve('nope@1.0.0'), /Could not fetch nope@1\.0\.0 with npm: E404 not found/);
});
