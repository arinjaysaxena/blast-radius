import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackageCache, defaultCacheRoot } from '../src/registry/cache.js';
import { IntegrityError, computeIntegrity, parseIntegrity, verifyIntegrity } from '../src/registry/integrity.js';
import { authHeaders, configFrom, loadNpmConfig, parseNpmrc } from '../src/registry/npmrc.js';
import { TarError, extractTarball, readTarball } from '../src/registry/tar.js';
import { makeTgz, packageTgz } from './tarball.js';
import { tmpDir, writeTree } from './helpers.js';

describe('npmrc', () => {
  it('parses comments, quotes and env expansion', () => {
    const m = parseNpmrc('# c\n; c\nregistry = "https://r.example/"\n//r.example/:_authToken=${TOK}\nmissing=${NOPE}\n', { TOK: 'abc' });
    expect(m.get('registry')).toBe('https://r.example/');
    expect(m.get('//r.example/:_authToken')).toBe('abc');
    expect(m.get('missing')).toBe('${NOPE}');
  });

  it('resolves scoped registries and falls back to the default', () => {
    const cfg = configFrom([parseNpmrc('registry=https://main.example\n@acme:registry=https://acme.example/npm\n')]);
    expect(cfg.registryFor('left-pad')).toBe('https://main.example/');
    expect(cfg.registryFor('@acme/ui')).toBe('https://acme.example/npm/');
    expect(cfg.registryFor('@other/ui')).toBe('https://main.example/');
    expect(configFrom([]).registryFor('x')).toBe('https://registry.npmjs.org/');
  });

  it('lets NPM_CONFIG_REGISTRY override files', () => {
    const cfg = configFrom([parseNpmrc('registry=https://file.example/')], { NPM_CONFIG_REGISTRY: 'https://env.example' });
    expect(cfg.registryFor('x')).toBe('https://env.example/');
  });

  it('finds auth by registry prefix, walking up paths', () => {
    const cfg = configFrom([parseNpmrc('//r.example/:_authToken=host\n//r.example/deep/path/:_authToken=deep\n//b.example/:_auth=dTpw\n')]);
    expect(cfg.authFor('https://r.example/deep/path/')).toEqual({ token: 'deep' });
    expect(cfg.authFor('https://r.example/other/')).toEqual({ token: 'host' });
    expect(cfg.authFor('https://B.example')).toEqual({ basic: 'dTpw' });
    expect(cfg.authFor('https://none.example/')).toBeUndefined();
    expect(authHeaders({ token: 't' })).toEqual({ authorization: 'Bearer t' });
    expect(authHeaders({ basic: 'b' })).toEqual({ authorization: 'Basic b' });
    expect(authHeaders(undefined)).toEqual({});
  });

  it('merges user and project files with the project winning', () => {
    const home = tmpDir('br-home-');
    const proj = tmpDir('br-proj-');
    writeTree(home, { '.npmrc': 'registry=https://user.example/\n@s:registry=https://user-scope.example/\n' });
    writeTree(proj, { '.npmrc': 'registry=https://proj.example/\n' });
    const cfg = loadNpmConfig({ cwd: proj, home, env: {} });
    expect(cfg.registryFor('a')).toBe('https://proj.example/');
    expect(cfg.registryFor('@s/a')).toBe('https://user-scope.example/');
  });
});

describe('integrity', () => {
  const data = Buffer.from('hello tarball');
  it('verifies sha512 and returns the SRI', () => {
    const sri = computeIntegrity(data);
    expect(verifyIntegrity(data, sri)).toBe(sri);
  });
  it('prefers the strongest algorithm in a multi-hash string', () => {
    const sri = `${computeIntegrity(data, 'sha1')} ${computeIntegrity(data, 'sha512')}`;
    expect(parseIntegrity(sri)?.algorithm).toBe('sha512');
  });
  it('rejects tampered data with expected and actual hashes', () => {
    const sri = computeIntegrity(data);
    try {
      verifyIntegrity(Buffer.from('tampered'), sri);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect((e as IntegrityError).expected).toBe(sri);
      expect((e as IntegrityError).actual).not.toBe(sri);
    }
  });
  it('falls back to the legacy shasum and refuses unverifiable downloads', () => {
    const shasum = computeIntegrity(data, 'sha1');
    const hex = Buffer.from(shasum.slice(5), 'base64').toString('hex');
    expect(verifyIntegrity(data, undefined, hex)).toBe(shasum);
    expect(() => verifyIntegrity(data, undefined, '0'.repeat(40))).toThrow(IntegrityError);
    expect(() => verifyIntegrity(data, undefined)).toThrow(/no integrity/);
    expect(() => verifyIntegrity(data, 'md5-xxxx')).toThrow(/no integrity/);
  });
});

describe('tar', () => {
  it('strips the package directory and extracts regular files only', () => {
    const tgz = makeTgz([
      { name: 'package/', type: '5' },
      { name: 'package/package.json', content: '{"name":"a"}' },
      { name: 'package/lib/deep/index.d.ts', content: 'export {};' },
      { name: 'package/link', type: '2' },
      { name: 'README-outside', content: 'ignored' },
    ]);
    const entries = readTarball(tgz);
    expect(entries.map((e) => e.path)).toEqual(['package.json', 'lib/deep/index.d.ts']);
    const dest = tmpDir('br-tar-');
    expect(extractTarball(tgz, dest)).toBe(2);
    expect(readFileSync(join(dest, 'lib', 'deep', 'index.d.ts'), 'utf8')).toBe('export {};');
  });

  it('handles long names via GNU long-name records', () => {
    const long = 'package/' + 'd'.repeat(60) + '/' + 'f'.repeat(60) + '.d.ts';
    const [entry] = readTarball(makeTgz([{ name: long, content: 'x' }]));
    expect(entry?.path).toBe('d'.repeat(60) + '/' + 'f'.repeat(60) + '.d.ts');
  });

  it('rejects path traversal and garbage', () => {
    expect(() => readTarball(makeTgz([{ name: 'package/../../evil.txt', content: 'x' }]))).toThrow(TarError);
    expect(() => readTarball(makeTgz([{ name: '/abs/evil.txt', content: 'x' }]))).toThrow(TarError);
    expect(() => readTarball(Buffer.from('not gzip'))).toThrow(/gzip/);
  });
});

describe('PackageCache', () => {
  it('stores atomically, looks up by integrity and lists versions', () => {
    const cache = new PackageCache(tmpDir('br-cache-'));
    expect(cache.lookup('@s/pkg', '1.0.0')).toBeUndefined();
    const stored = cache.store('@s/pkg', '1.0.0', 'sha512-AAA', (dir) => extractTarball(packageTgz('@s/pkg', '1.0.0'), dir));
    expect(existsSync(join(stored.dir, 'index.d.ts'))).toBe(true);
    expect(cache.lookup('@s/pkg', '1.0.0')?.dir).toBe(stored.dir);
    expect(cache.lookup('@s/pkg', '1.0.0', 'sha512-AAA')).toBeDefined();
    expect(cache.lookup('@s/pkg', '1.0.0', 'sha512-BBB')).toBeUndefined();
    cache.store('@s/pkg', '1.1.0', 'sha512-CCC', (dir) => extractTarball(packageTgz('@s/pkg', '1.1.0'), dir));
    expect(cache.versions('@s/pkg').sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('leaves nothing behind when populating fails', () => {
    const cache = new PackageCache(tmpDir('br-cache-'));
    expect(() =>
      cache.store('p', '1.0.0', 'sha512-AAA', () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(cache.lookup('p', '1.0.0')).toBeUndefined();
    expect(cache.versions('p')).toEqual([]);
  });

  it('picks platform cache roots', () => {
    expect(defaultCacheRoot({ BLAST_RADIUS_CACHE: '/x' }, 'linux', '/h')).toBe('/x');
    expect(defaultCacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/h')).toBe(join('/xdg', 'blast-radius'));
    expect(defaultCacheRoot({}, 'linux', '/h')).toBe(join('/h', '.cache', 'blast-radius'));
    expect(defaultCacheRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32', '/h')).toBe(join('C:\\L', 'blast-radius', 'Cache'));
    expect(defaultCacheRoot({}, 'darwin', '/h')).toBe(join('/h', 'Library', 'Caches', 'blast-radius'));
  });
});
