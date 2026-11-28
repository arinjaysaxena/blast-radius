import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ProjectError, createPrograms, loadProject, relPosix, syntheticOptions } from '../src/usage/index.js';
import { tmpDir, writeTree } from './helpers.js';

const rel = (root: string, files: string[]): string[] => files.map((f) => relPosix(root, f));

describe('loadProject: tsconfig', () => {
  it('uses include/exclude and drops declaration files and node_modules', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src', 'node_modules/x'], exclude: ['src/skip'] }),
      'src/a.ts': 'export const a = 1;',
      'src/types.d.ts': 'declare const t: number;',
      'src/skip/b.ts': 'export const b = 1;',
      'node_modules/x/index.ts': 'export const x = 1;',
      'src/c.js': 'exports.c = 1;',
    });
    const p = loadProject(d);
    expect(rel(d, p.fileNames)).toEqual(['src/a.ts']);
    expect(p.configs).toHaveLength(1);
    expect(p.configs[0]?.options.strict).toBe(true);
    expect(p.truncated).toBe(false);
  });

  it('includes JavaScript when the config sets allowJs', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true } }), 'a.ts': '', 'b.js': '', 'c.mjs': '' });
    expect(rel(d, loadProject(d).fileNames)).toEqual(['a.ts', 'b.js', 'c.mjs']);
  });

  it('follows extends with paths resolved relative to the base config', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, {
      'config/base.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['lib/*'] }, target: 'es2020' } }),
      'tsconfig.json': JSON.stringify({ extends: './config/base.json', include: ['app'] }),
      'app/main.ts': "import { util } from '@lib/util';\nexport const v = util;\n",
      'lib/util.ts': 'export const util = 1;\n',
    });
    const project = loadProject(d);
    expect(project.configs[0]?.options.target).toBe(ts.ScriptTarget.ES2020);
    const program = createPrograms(project)[0]?.program;
    if (!program) throw new Error('expected a program');
    const loaded = program.getSourceFiles().map((f) => relPosix(d, f.fileName));
    expect(loaded).toContain('lib/util.ts'); // resolved through `paths`, not in `include`
    expect(program.getSemanticDiagnostics(program.getSourceFile(`${d}/app/main.ts`)).filter((x) => x.code === 2307)).toEqual([]);
  });

  it('honours an explicit tsconfig file name', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, {
      'tsconfig.json': JSON.stringify({ include: ['a.ts'] }),
      'tsconfig.app.json': JSON.stringify({ include: ['b.ts'] }),
      'a.ts': '',
      'b.ts': '',
    });
    expect(rel(d, loadProject(d, { tsconfig: 'tsconfig.app.json' }).fileNames)).toEqual(['b.ts']);
    expect(() => loadProject(d, { tsconfig: 'nope.json' })).toThrow(ProjectError);
  });

  it('does not borrow a parent directory tsconfig', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'tsconfig.json': JSON.stringify({ include: [] }), 'pkg/a.js': 'module.exports = 1;' });
    const p = loadProject(`${d}/pkg`);
    expect(p.configs[0]?.configPath).toBeNull();
    expect(rel(`${d}/pkg`, p.fileNames)).toEqual(['a.js']);
  });

  it('throws ProjectError for malformed JSON and missing directories', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'tsconfig.json': '{ "compilerOptions": ' });
    expect(() => loadProject(d)).toThrow(/cannot read .*tsconfig\.json/);
    expect(() => loadProject(`${d}/missing`)).toThrow(/project directory not found/);
  });

  it('collects non-fatal config problems as warnings', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es1999' } }), 'a.ts': '' });
    const p = loadProject(d);
    expect(p.warnings.join('\n')).toMatch(/es1999|target/i);
    expect(rel(d, p.fileNames)).toEqual(['a.ts']);
  });
});

describe('loadProject: project references', () => {
  const solution = (d: string): void => {
    writeTree(d, {
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'packages/a' }, { path: './packages/b/tsconfig.json' }] }),
      'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, baseUrl: '.', paths: { '#a/*': ['src/*'] } }, include: ['src'] }),
      'packages/a/src/index.ts': "import { h } from '#a/helper';\nexport const a = h;\n",
      'packages/a/src/helper.ts': 'export const h = 1;\n',
      'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true }, include: ['lib'], references: [{ path: '../a' }] }),
      'packages/b/lib/b.ts': 'export const b = 2;\n',
    });
  };

  it('loads a solution-style root without inputs and every referenced config once', () => {
    const d = tmpDir('br-proj-');
    solution(d);
    const p = loadProject(d);
    expect(p.warnings).toEqual([]);
    expect(p.configs.map((c) => relPosix(d, c.configPath ?? ''))).toEqual(['tsconfig.json', 'packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
    expect(rel(d, p.fileNames)).toEqual(['packages/a/src/helper.ts', 'packages/a/src/index.ts', 'packages/b/lib/b.ts']);
  });

  it('builds one program per config so each project keeps its own `paths`', () => {
    const d = tmpDir('br-proj-');
    solution(d);
    const programs = createPrograms(loadProject(d));
    expect(programs.map((p) => relPosix(d, p.config.dir))).toEqual(['packages/a', 'packages/b']);
    const a = programs[0]?.program;
    expect(a?.getSemanticDiagnostics(a.getSourceFile(`${d}/packages/a/src/index.ts`)).filter((x) => x.code === 2307)).toEqual([]);
  });

  it('survives reference cycles and missing references', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, {
      'tsconfig.json': JSON.stringify({ include: ['x.ts'], references: [{ path: 'a' }, { path: 'ghost' }] }),
      'x.ts': '',
      'a/tsconfig.json': JSON.stringify({ include: ['a.ts'], references: [{ path: '..' }] }),
      'a/a.ts': '',
    });
    const p = loadProject(d);
    expect(p.configs).toHaveLength(2);
    expect(p.warnings.some((w) => w.includes('referenced project not found'))).toBe(true);
  });
});

describe('loadProject: plain JavaScript', () => {
  it('synthesises an allowJs config and scans js, jsx, mjs and cjs', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'index.js': '', 'ui/app.jsx': '', 'lib/m.mjs': '', 'lib/c.cjs': '', 'node_modules/dep/i.js': '', 'dist/out.js': '' });
    const p = loadProject(d);
    expect(p.configs[0]?.configPath).toBeNull();
    expect(p.configs[0]?.options.allowJs).toBe(true);
    expect(rel(d, p.fileNames)).toEqual(['index.js', 'lib/c.cjs', 'lib/m.mjs', 'ui/app.jsx']);
  });

  it('type-checks JavaScript through the synthesised config', () => {
    const d = tmpDir('br-proj-');
    writeTree(d, { 'a.js': "const b = require('./b');\nmodule.exports = b.value;\n", 'b.js': 'exports.value = 3;\n' });
    const [only] = createPrograms(loadProject(d));
    expect(only?.program.getSourceFiles().map((f) => relPosix(d, f.fileName))).toEqual(expect.arrayContaining(['a.js', 'b.js']));
    expect(syntheticOptions().checkJs).toBe(false);
  });

  it('truncates to maxFiles and reports it', () => {
    const d = tmpDir('br-proj-');
    for (let i = 0; i < 12; i++) writeTree(d, { [`f${String(i).padStart(2, '0')}.ts`]: '' });
    const p = loadProject(d, { maxFiles: 5 });
    expect(p.fileNames).toHaveLength(5);
    const t = loadProject(d);
    expect(t.truncated).toBe(false);
    writeTree(d, { 'tsconfig.json': '{}' });
    expect(loadProject(d, { maxFiles: 5 }).truncated).toBe(true);
  });
});
