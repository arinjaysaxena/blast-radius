import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError, main, parseArgs, run } from '../src/cli/index.js';
import { createResolver } from '../src/cli/run.js';
import { tmpDir, writeTree } from './helpers.js';
import { NEW_DTS, OLD_DTS, mapResolver, pkgDir, project, seedCache } from './cli-fixtures.js';

function capture(): { out: string[]; err: string[]; log: (m: string) => void; warn: (m: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (m) => out.push(m), warn: (m) => err.push(m) };
}

describe('parseArgs', () => {
  it('reads flags in both --flag value and --flag=value forms', () => {
    const o = parseArgs(['a', 'b', '--project', 'p', '--format=json', '--fail-on-breaking', '--offline', '--max-files', '5', '--out=r.json']);
    expect([o.old, o.new, o.project, o.format, o.out]).toEqual(['a', 'b', 'p', 'json', 'r.json']);
    expect([o.failOnBreaking, o.offline, o.maxFiles, o.noTypesFallback]).toEqual([true, true, 5, false]);
  });

  it('accepts flags before positionals and returns early for --help', () => {
    expect(parseArgs(['--offline', 'a', 'b']).old).toBe('a');
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['a'], /exactly two arguments/],
    [['a', 'b', 'c'], /exactly two arguments/],
    [['a', 'b', '--format', 'xml'], /md or json/],
    [['a', 'b', '--zzz'], /unknown option --zzz/],
    [['a', 'b', '--out'], /--out needs a value/],
    [['a', 'b', '--max-files', '0'], /positive integer/],
    [['a', 'b', '--max-files', '1.5'], /positive integer/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('run', () => {
  it('diffs two packages and maps call sites in the project', async () => {
    const resolver = mapResolver({ old: pkgDir('lib', '1.0.0', OLD_DTS), new: pkgDir('lib', '2.0.0', NEW_DTS) });
    const { report, text } = await run({ old: 'old', new: 'new', project: project(), format: 'md' }, { resolver });
    expect([report.package, report.from, report.to, report.scanned]).toEqual(['lib', '1.0.0', '2.0.0', true]);
    expect(report.summary.impactedSymbols).toBe(2);
    expect(text).toContain('places in your code touch changed APIs');
  });

  it('skips the project scan when none is given', async () => {
    const resolver = mapResolver({ old: pkgDir('lib', '1.0.0', OLD_DTS), new: pkgDir('lib', '2.0.0', NEW_DTS) });
    const { report } = await run({ old: 'old', new: 'new', project: null, format: 'json' }, { resolver });
    expect(report.scanned).toBe(false);
    expect(report.summary.callSites).toBe(0);
  });

  it('warns about the @types fallback and oversized project files', async () => {
    const proj = project();
    const resolver = mapResolver({
      old: { dir: pkgDir('lib', '1.0.0', OLD_DTS), label: 'lib@1.0.0', name: 'lib', version: '1.0.0', source: 'cache', typesVersion: '1.0.3' },
      new: pkgDir('lib', '2.0.0', NEW_DTS),
    });
    // A generated bundle that mentions the package must be skipped rather than parsed.
    writeTree(proj, { 'src/bundle.js': `// lib\n${'var a=1;'.repeat(200_000)}\n` });
    const warnings: string[] = [];
    await run({ old: 'old', new: 'new', project: proj, format: 'md' }, { resolver, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(['lib@1.0.0: no bundled types, using @types 1.0.3', expect.stringMatching(/skipped .*bundle\.js/)]);
  });
});

describe('main', () => {
  const resolver = () => mapResolver({ old: pkgDir('lib', '1.0.0', OLD_DTS), new: pkgDir('lib', '2.0.0', NEW_DTS) });

  it('prints the report and exits 0 by default', async () => {
    const c = capture();
    expect(await main(['old', 'new', '--project', project()], { ...c, resolver: resolver() })).toBe(0);
    expect(c.out.join('\n')).toMatch(/gone/);
    expect(c.err).toEqual([]);
  });

  it('exits 1 with --fail-on-breaking and emits valid JSON', async () => {
    const c = capture();
    expect(await main(['old', 'new', '--fail-on-breaking', '--format', 'json'], { ...c, resolver: resolver() })).toBe(1);
    const report = JSON.parse(c.out.join('\n')) as { summary: { breaking: number } };
    expect(report.summary.breaking).toBe(2);
  });

  it('writes to --out instead of stdout', async () => {
    const c = capture();
    const out = join(tmpDir('br-out-'), 'report.md');
    expect(await main(['old', 'new', '--out', out], { ...c, resolver: resolver() })).toBe(0);
    expect(c.out).toEqual([]);
    expect(readFileSync(out, 'utf8')).toContain('Blast radius');
  });

  it('prints usage for --help and for bad arguments (exit 2, on stderr)', async () => {
    const help = capture();
    expect(await main(['--help'], help)).toBe(0);
    expect(help.out[0]).toContain('usage: blast-radius');
    const bad = capture();
    expect(await main(['only-one'], bad)).toBe(2);
    expect(bad.err[0]).toMatch(/exactly two arguments[\s\S]*usage:/);
    expect(bad.out).toEqual([]);
  });

  it('reports resolution failures as errors with exit code 2', async () => {
    const c = capture();
    expect(await main(['old', 'missing@1.0.0'], { ...c, resolver: resolver() })).toBe(2);
    expect(c.err[0]).toBe('error: no such package: missing@1.0.0');
  });

  it('reports an empty package directory clearly', async () => {
    const c = capture();
    const empty = tmpDir('br-empty-');
    expect(await main([empty, empty], { ...c, cwd: process.cwd() })).toBe(2);
    expect(c.err[0]).toMatch(/error: no package\.json found/);
  });
});

describe('createResolver', () => {
  it('resolves registry specs from the cache with --offline and never needs the network', async () => {
    const cache = seedCache('lib', '1.0.0', OLD_DTS);
    const resolver = createResolver({ offline: true, cacheRoot: cache.root, env: {}, cwd: tmpDir('br-cwd-') });
    const got = await resolver.resolve('lib@1.0.0');
    expect([got.name, got.version, got.source]).toEqual(['lib', '1.0.0', 'cache']);
    await expect(resolver.resolve('lib@9.9.9')).rejects.toThrow(/not in the local cache and --offline/);
  });

  it('runs end to end with one cached version and one local directory', async () => {
    const cache = seedCache('lib', '1.0.0', OLD_DTS);
    const resolver = createResolver({ offline: true, cacheRoot: cache.root, env: {}, cwd: tmpDir('br-cwd-') });
    const c = capture();
    const code = await main(['lib@1.0.0', pkgDir('lib', '2.0.0', NEW_DTS), '--project', project(), '--format', 'json', '--fail-on-breaking'], { ...c, resolver });
    expect(code).toBe(1);
    expect((JSON.parse(c.out.join('\n')) as { from: string }).from).toBe('1.0.0');
  });
});
