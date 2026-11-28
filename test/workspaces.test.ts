import { describe, expect, it } from 'vitest';
import { discoverWorkspaces, expandGlob, parsePnpmWorkspace, workspacePath, workspacesUsing } from '../src/usage/index.js';
import { tmpDir, writeTree } from './helpers.js';

const pkg = (name: string, deps: Record<string, string> = {}, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', dependencies: deps, ...extra });

const rels = (root: string, dirs: string[]): string[] => dirs.map((d) => d.slice(root.length + 1).replace(/\\/g, '/'));

describe('parsePnpmWorkspace', () => {
  it('reads block lists with quotes, comments and negations', () => {
    const text = "# comment\npackages:\n  - 'packages/*'\n  - \"apps/**\"   # apps\n  - '!**/test/**'\n\ncatalog:\n  - nope\n";
    expect(parsePnpmWorkspace(text)).toEqual(['packages/*', 'apps/**', '!**/test/**']);
  });

  it('reads flow lists and CRLF files, and tolerates a missing key', () => {
    expect(parsePnpmWorkspace("packages: ['a/*', b]\n")).toEqual(['a/*', 'b']);
    expect(parsePnpmWorkspace('packages:\r\n  - a/*\r\n  - b\r\n')).toEqual(['a/*', 'b']);
    expect(parsePnpmWorkspace('other: 1\n')).toEqual([]);
  });
});

describe('expandGlob', () => {
  const tree = (): string => {
    const d = tmpDir('br-glob-');
    writeTree(d, {
      'packages/a/package.json': '{}',
      'packages/b/package.json': '{}',
      'packages/b/nested/c/package.json': '{}',
      'packages/node_modules/dep/package.json': '{}',
      'apps/web/plugins/p/package.json': '{}',
      'apps/api/plugins/q/package.json': '{}',
      'file.txt': 'x',
    });
    return d;
  };

  it('matches single-level wildcards and ignores files and node_modules', () => {
    const d = tree();
    expect(rels(d, expandGlob(d, 'packages/*'))).toEqual(['packages/a', 'packages/b']);
    expect(rels(d, expandGlob(d, './packages/*/'))).toEqual(['packages/a', 'packages/b']);
  });

  it('supports ** across levels, mid-path wildcards and literals', () => {
    const d = tree();
    expect(rels(d, expandGlob(d, 'packages/**'))).toEqual(['packages', 'packages/a', 'packages/b', 'packages/b/nested', 'packages/b/nested/c']);
    expect(rels(d, expandGlob(d, 'apps/*/plugins/*'))).toEqual(['apps/api/plugins/q', 'apps/web/plugins/p']);
    expect(rels(d, expandGlob(d, 'packages/b'))).toEqual(['packages/b']);
    expect(expandGlob(d, 'missing/*')).toEqual([]);
  });

  it('supports partial-name wildcards', () => {
    const d = tmpDir('br-glob-');
    writeTree(d, { 'libs/ui-button/x': '', 'libs/ui-card/x': '', 'libs/core/x': '' });
    expect(rels(d, expandGlob(d, 'libs/ui-*'))).toEqual(['libs/ui-button', 'libs/ui-card']);
  });
});

describe('discoverWorkspaces', () => {
  it('finds npm workspaces from the array form', () => {
    const d = tmpDir('br-ws-');
    writeTree(d, {
      'package.json': pkg('root', {}, { workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('@org/a', { zod: '^3' }),
      'packages/b/package.json': pkg('@org/b', { '@org/a': '*' }, { devDependencies: { zod: '^3' } }),
      'packages/c/readme.md': 'no manifest',
    });
    const layout = discoverWorkspaces(d);
    expect(layout.manager).toBe('npm');
    expect(layout.workspaces.map((w) => w.name)).toEqual(['@org/a', '@org/b']);
    expect(workspacesUsing(layout, 'zod').map((w) => workspacePath(layout, w))).toEqual(['packages/a', 'packages/b']);
    expect(workspacesUsing(layout, '@org/a').map((w) => w.name)).toEqual(['@org/b']);
    expect(workspacesUsing(layout, 'left-pad')).toEqual([]);
  });

  it('detects yarn by lockfile and reads the { packages } object form', () => {
    const d = tmpDir('br-ws-');
    writeTree(d, {
      'package.json': pkg('root', {}, { workspaces: { packages: ['apps/*'] } }),
      'yarn.lock': '# yarn',
      'apps/web/package.json': pkg('web', {}, { peerDependencies: { react: '*' } }),
    });
    const layout = discoverWorkspaces(d);
    expect(layout.manager).toBe('yarn');
    expect(workspacesUsing(layout, 'react').map((w) => w.name)).toEqual(['web']);
  });

  it('reads pnpm-workspace.yaml including negated patterns', () => {
    const d = tmpDir('br-ws-');
    writeTree(d, {
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n",
      'packages/new/package.json': pkg('new', {}, { optionalDependencies: { fsevents: '*' } }),
      'packages/legacy/package.json': pkg('legacy'),
    });
    const layout = discoverWorkspaces(d);
    expect(layout.manager).toBe('pnpm');
    expect(layout.workspaces.map((w) => w.name)).toEqual(['new']);
    expect(workspacesUsing(layout, 'fsevents')).toHaveLength(1);
  });

  it('treats a plain package as a single workspace named by its manifest', () => {
    const d = tmpDir('br-ws-');
    writeTree(d, { 'package.json': pkg('solo', { lodash: '^4' }) });
    const layout = discoverWorkspaces(d);
    expect(layout.manager).toBe('none');
    expect(layout.workspaces.map((w) => [w.name, workspacePath(layout, w)])).toEqual([['solo', '.']]);
  });

  it('falls back to the directory name and skips malformed manifests', () => {
    const d = tmpDir('br-ws-');
    writeTree(d, {
      'package.json': JSON.stringify({ workspaces: ['p/*'] }),
      'p/unnamed/package.json': '{"dependencies":{"x":"1"}}',
      'p/broken/package.json': '{ nope',
    });
    expect(discoverWorkspaces(d).workspaces.map((w) => w.name)).toEqual(['unnamed']);
  });

  it('returns no workspaces for a directory without a package.json', () => {
    expect(discoverWorkspaces(tmpDir('br-ws-')).workspaces).toEqual([]);
  });
});
