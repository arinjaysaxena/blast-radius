import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageCache } from '../src/registry/cache.js';
import { RegistryClient, RegistryError, pickVersion, type Packument } from '../src/registry/client.js';
import { computeIntegrity } from '../src/registry/integrity.js';
import { configFrom, parseNpmrc } from '../src/registry/npmrc.js';
import { PackageResolver, parseSpec } from '../src/registry/resolver.js';
import { pickTypesVersion, shipsTypes, typesPackageName } from '../src/registry/types-fallback.js';
import { makeTgz, packageTgz } from './tarball.js';
import { tmpDir, writeTree } from './helpers.js';

interface Published {
  tgz: Buffer;
  integrity?: string | null; // null = omit, string = override
}

class FakeRegistry {
  readonly server: Server;
  readonly requests: { url: string; auth: string | undefined }[] = [];
  readonly packages = new Map<string, Map<string, Published>>();
  tags = new Map<string, Record<string, string>>();
  failures = 0;
  url = '';

  constructor() {
    this.server = createServer((req, res) => { this.handle(req, res); });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  publish(name: string, version: string, tgz: Buffer = packageTgz(name, version), integrity?: string | null): void {
    const versions = this.packages.get(name) ?? new Map<string, Published>();
    versions.set(version, { tgz, integrity });
    this.packages.set(name, versions);
  }

  private handle(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    const url = req.url ?? '/';
    this.requests.push({ url, auth: req.headers.authorization });
    if (this.failures > 0) {
      this.failures--;
      res.writeHead(503).end();
      return;
    }
    const tarball = /^\/-\/(.+)\/(.+)\.tgz$/.exec(url);
    if (tarball) {
      const entry = this.packages.get(decodeURIComponent(tarball[1] ?? ''))?.get(tarball[2] ?? '');
      if (!entry) return void res.writeHead(404).end();
      return void res.writeHead(200).end(entry.tgz);
    }
    const name = decodeURIComponent(url.slice(1));
    const versions = this.packages.get(name);
    if (!versions) return void res.writeHead(404).end('{}');
    const doc: Packument = { name, 'dist-tags': this.tags.get(name) ?? {}, versions: {} };
    let latest = '';
    for (const [version, p] of versions) {
      latest = version;
      const dist: Packument['versions'][string]['dist'] = { tarball: `${this.url}-/${encodeURIComponent(name)}/${version}.tgz` };
      if (p.integrity !== null) dist.integrity = p.integrity ?? computeIntegrity(p.tgz);
      doc.versions[version] = { name, version, dist };
    }
    doc['dist-tags']['latest'] ??= latest;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
  }
}

const open: FakeRegistry[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await new Promise((done) => r.server.close(done));
});

async function setup(npmrc: string | ((registryUrl: string) => string) = '', opts: { offline?: boolean; typesFallback?: boolean } = {}) {
  const registry = new FakeRegistry();
  await registry.start();
  open.push(registry);
  const config = configFrom([parseNpmrc(`registry=${registry.url}\n${typeof npmrc === 'function' ? npmrc(registry.url) : npmrc}`)]);
  const client = new RegistryClient({ config, retryDelayMs: 0 });
  const cache = new PackageCache(tmpDir('br-resolver-cache-'));
  const resolver = new PackageResolver({ client, cache, ...opts });
  return { registry, client, cache, resolver, config };
}

describe('parseSpec', () => {
  it('classifies paths and registry specs', () => {
    expect(parseSpec('zod@3.22.0')).toEqual({ kind: 'registry', name: 'zod', range: '3.22.0' });
    expect(parseSpec('@types/node@^20')).toEqual({ kind: 'registry', name: '@types/node', range: '^20' });
    expect(parseSpec('@scope/pkg')).toEqual({ kind: 'registry', name: '@scope/pkg', range: 'latest' });
    expect(parseSpec('./local')).toEqual({ kind: 'path', path: './local' });
    expect(parseSpec('../up')).toEqual({ kind: 'path', path: '../up' });
    expect(parseSpec('/abs/dir')).toEqual({ kind: 'path', path: '/abs/dir' });
    expect(parseSpec('C:\\work\\pkg')).toEqual({ kind: 'path', path: 'C:\\work\\pkg' });
    expect(parseSpec('file:../fork')).toEqual({ kind: 'path', path: '../fork' });
    expect(parseSpec('not a spec!')).toBeUndefined();
    expect(parseSpec('pkg@')).toBeUndefined();
  });
});

describe('version picking', () => {
  const doc: Packument = {
    name: 'p',
    'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
    versions: Object.fromEntries(['1.0.0', '1.2.0', '1.10.0', '2.0.0', '3.0.0-beta.1'].map((v) => [v, { name: 'p', version: v, dist: { tarball: 't' } }])),
  };
  it('handles tags, exact versions and ranges', () => {
    expect(pickVersion(doc, 'latest').version).toBe('2.0.0');
    expect(pickVersion(doc, 'next').version).toBe('3.0.0-beta.1');
    expect(pickVersion(doc, '1.2.0').version).toBe('1.2.0');
    expect(pickVersion(doc, '^1.0.0').version).toBe('1.10.0');
    expect(pickVersion(doc, '~1.2').version).toBe('1.2.0');
    expect(() => pickVersion(doc, '^9.0.0')).toThrow(/no version of "p" matches/);
  });
});

describe('registry resolver', () => {
  it('downloads, verifies, unpacks and then serves exact versions offline', async () => {
    const { registry, resolver } = await setup();
    registry.publish('left-pad', '1.0.0');
    registry.publish('left-pad', '1.3.0');
    const first = await resolver.resolve('left-pad@^1.0.0');
    expect(first).toMatchObject({ name: 'left-pad', version: '1.3.0', source: 'registry', label: 'left-pad@^1.0.0' });
    expect(readFileSync(join(first.dir, 'package.json'), 'utf8')).toContain('"1.3.0"');

    const before = registry.requests.length;
    const second = await resolver.resolve('left-pad@1.3.0');
    expect(second.source).toBe('cache');
    expect(second.dir).toBe(first.dir);
    expect(registry.requests.length).toBe(before); // second run is fully offline
  });

  it('reuses the cache for a range once the version is known, downloading only the packument', async () => {
    const { registry, resolver } = await setup();
    registry.publish('p', '1.0.0');
    await resolver.resolve('p');
    const tarballRequests = () => registry.requests.filter((r) => r.url.includes('.tgz')).length;
    expect(tarballRequests()).toBe(1);
    const again = await resolver.resolve('p@latest');
    expect(again.source).toBe('cache');
    expect(tarballRequests()).toBe(1);
  });

  it('resolves from cache only in offline mode', async () => {
    const online = await setup();
    online.registry.publish('p', '1.0.0');
    online.registry.publish('p', '1.1.0');
    await online.resolver.resolve('p@1.1.0');
    const offline = new PackageResolver({ client: online.client, cache: online.cache, offline: true });
    const before = online.registry.requests.length;
    expect((await offline.resolve('p@^1.0.0')).version).toBe('1.1.0');
    await expect(offline.resolve('p@1.0.0')).rejects.toThrow(/--offline/);
    await expect(offline.resolve('other@1.0.0')).rejects.toThrow(/--offline/);
    expect(online.registry.requests.length).toBe(before);
  });

  it('rejects a tarball whose integrity does not match and caches nothing', async () => {
    const { registry, resolver, cache } = await setup();
    registry.publish('bad', '1.0.0', packageTgz('bad', '1.0.0'), computeIntegrity(Buffer.from('something else')));
    await expect(resolver.resolve('bad@1.0.0')).rejects.toThrow(/integrity check failed/);
    expect(cache.lookup('bad', '1.0.0')).toBeUndefined();
  });

  it('refuses a download with no integrity information', async () => {
    const { registry, resolver } = await setup();
    registry.publish('noint', '1.0.0', packageTgz('noint', '1.0.0'), null);
    await expect(resolver.resolve('noint@1.0.0')).rejects.toThrow(/no integrity/);
  });

  it('reports missing packages and unreachable registries clearly', async () => {
    const { resolver } = await setup();
    await expect(resolver.resolve('ghost@1.0.0')).rejects.toThrow(/"ghost" was not found/);
    const dead = new PackageResolver({
      client: new RegistryClient({ config: configFrom([parseNpmrc('registry=http://127.0.0.1:1/')]), retries: 1, retryDelayMs: 0 }),
      cache: new PackageCache(tmpDir('br-dead-')),
    });
    await expect(dead.resolve('x@1.0.0')).rejects.toThrow(/could not reach/);
  });

  it('retries transient 5xx responses', async () => {
    const { registry, resolver } = await setup();
    registry.publish('flaky', '1.0.0');
    registry.failures = 2;
    expect((await resolver.resolve('flaky@1.0.0')).version).toBe('1.0.0');
  });

  it('sends .npmrc credentials to the registry and uses scoped registries', async () => {
    const scoped = new FakeRegistry();
    await scoped.start();
    open.push(scoped);
    const host = new URL(scoped.url).host;
    const { registry, resolver } = await setup(`@acme:registry=${scoped.url}\n//${host}/:_authToken=sekret\n`);
    scoped.publish('@acme/ui', '2.0.0');
    registry.publish('plain', '1.0.0');
    const ui = await resolver.resolve('@acme/ui@2.0.0');
    expect(ui.version).toBe('2.0.0');
    expect(scoped.requests[0]?.url).toBe('/@acme%2Fui');
    expect(scoped.requests.every((r) => r.auth === 'Bearer sekret')).toBe(true);
    await resolver.resolve('plain@1.0.0');
    expect(registry.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('does not leak credentials to a tarball host that differs from the registry', async () => {
    const cdn = new FakeRegistry();
    await cdn.start();
    open.push(cdn);
    const { registry, resolver } = await setup((url) => `//${new URL(url).host}/:_authToken=sekret\n`);
    const tgz = packageTgz('x', '1.0.0');
    cdn.publish('x', '1.0.0', tgz);
    registry.publish('x', '1.0.0', tgz);
    const original = registry.server.listeners('request')[0] as (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
    registry.server.removeAllListeners('request');
    registry.server.on('request', (req, res) => {
      if (req.url === '/x') {
        registry.requests.push({ url: '/x', auth: req.headers.authorization });
        const doc = { name: 'x', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'x', version: '1.0.0', dist: { tarball: `${cdn.url}-/x/1.0.0.tgz`, integrity: computeIntegrity(tgz) } } } };
        return void res.writeHead(200).end(JSON.stringify(doc));
      }
      original(req, res);
    });
    await resolver.resolve('x@1.0.0');
    expect(registry.requests[0]?.auth).toBe('Bearer sekret');
    expect(cdn.requests.length).toBe(1);
    expect(cdn.requests[0]?.auth).toBeUndefined();
  });
});

describe('local specs', () => {
  it('resolves directories and file: specs without a registry', async () => {
    const { resolver, registry } = await setup();
    const dir = tmpDir('br-local-');
    writeTree(dir, { 'package.json': '{"name":"fork","version":"9.9.9","types":"i.d.ts"}', 'i.d.ts': 'export {};' });
    const a = await resolver.resolve(dir);
    expect(a).toMatchObject({ dir, name: 'fork', version: '9.9.9', source: 'local' });
    const b = await resolver.resolve(`file:${dir}`);
    expect(b.dir).toBe(dir);
    expect(registry.requests.length).toBe(0);
  });

  it('explains bad local specs', async () => {
    const { resolver } = await setup();
    const empty = tmpDir('br-empty-');
    await expect(resolver.resolve(empty)).rejects.toThrow(/no package\.json/);
    await expect(resolver.resolve(join(empty, 'missing'))).rejects.toThrow(/not a directory/);
    await expect(resolver.resolve('what is this')).rejects.toBeInstanceOf(RegistryError);
  });
});

describe('@types fallback', () => {
  const untyped = (name: string, version: string) =>
    makeTgz([
      { name: 'package/package.json', content: JSON.stringify({ name, version, main: 'index.js' }) },
      { name: 'package/index.js', content: 'module.exports = {};' },
    ]);
  const typesTgz = (name: string, version: string) =>
    makeTgz([
      { name: 'package/package.json', content: JSON.stringify({ name, version, types: 'index.d.ts' }) },
      { name: 'package/index.d.ts', content: 'export declare function run(): void;\n' },
    ]);

  it('names and version-matches DefinitelyTyped packages', () => {
    expect(typesPackageName('lodash')).toBe('@types/lodash');
    expect(typesPackageName('@babel/core')).toBe('@types/babel__core');
    const doc: Packument = {
      name: '@types/x',
      'dist-tags': {},
      versions: Object.fromEntries(['4.14.1', '4.14.9', '4.17.0', '5.0.3'].map((v) => [v, { name: '@types/x', version: v, dist: { tarball: '' } }])),
    };
    expect(pickTypesVersion(doc, '4.14.2')).toBe('4.14.9');
    expect(pickTypesVersion(doc, '4.15.0')).toBe('4.17.0'); // same major fallback
    expect(pickTypesVersion(doc, '6.0.0')).toBeUndefined();
    expect(pickTypesVersion(doc, 'garbage')).toBeUndefined();
  });

  it('detects shipped types in every supported layout', () => {
    const cases: [Record<string, string>, boolean][] = [
      [{ 'package.json': '{"types":"a.d.ts"}' }, true],
      [{ 'package.json': '{"typings":"a.d.ts"}' }, true],
      [{ 'package.json': '{"exports":{".":{"import":{"types":"./a.d.mts","default":"./a.mjs"}}}}' }, true],
      [{ 'package.json': '{"main":"lib/x.js"}', 'lib/x.d.ts': '' }, true],
      [{ 'package.json': '{}', 'index.d.ts': '' }, true],
      [{ 'package.json': '{"main":"x.js","exports":{".":"./x.js"}}' }, false],
    ];
    for (const [files, expected] of cases) {
      const dir = tmpDir('br-ships-');
      writeTree(dir, files);
      expect(shipsTypes(dir)).toBe(expected);
    }
  });

  it('merges @types into an untyped package so it extracts like a typed one', async () => {
    const { registry, resolver, cache } = await setup();
    registry.publish('untyped', '2.3.1', untyped('untyped', '2.3.1'));
    registry.publish('@types/untyped', '2.3.0', typesTgz('@types/untyped', '2.3.0'));
    registry.publish('@types/untyped', '2.3.4', typesTgz('@types/untyped', '2.3.4'));
    const res = await resolver.resolve('untyped@2.3.1');
    expect(res.typesVersion).toBe('2.3.4');
    expect(res.dir).not.toBe(cache.lookup('untyped', '2.3.1')?.dir);
    expect(shipsTypes(res.dir)).toBe(true);
    expect(existsSync(join(res.dir, 'index.js'))).toBe(true);
    expect(readFileSync(join(res.dir, 'index.d.ts'), 'utf8')).toContain('run');
    expect(JSON.parse(readFileSync(join(res.dir, 'package.json'), 'utf8'))).toMatchObject({ name: 'untyped', types: 'index.d.ts' });
  });

  it('keeps the original package when no @types package exists, or when disabled', async () => {
    const { registry, resolver } = await setup();
    registry.publish('lonely', '1.0.0', untyped('lonely', '1.0.0'));
    const res = await resolver.resolve('lonely@1.0.0');
    expect(res.typesVersion).toBeUndefined();
    expect(res.source).toBe('registry');

    const off = await setup('', { typesFallback: false });
    off.registry.publish('u', '1.0.0', untyped('u', '1.0.0'));
    off.registry.publish('@types/u', '1.0.0', typesTgz('@types/u', '1.0.0'));
    expect((await off.resolver.resolve('u@1.0.0')).typesVersion).toBeUndefined();
  });

  it('serves the merged package offline on the second run', async () => {
    const { registry, resolver, client, cache } = await setup();
    registry.publish('u', '1.0.0', untyped('u', '1.0.0'));
    registry.publish('@types/u', '1.0.5', typesTgz('@types/u', '1.0.5'));
    const first = await resolver.resolve('u@1.0.0');
    const before = registry.requests.length;
    const offline = new PackageResolver({ client, cache, offline: true });
    const second = await offline.resolve('u@1.0.0');
    expect(second.dir).toBe(first.dir);
    expect(second.typesVersion).toBe('1.0.5');
    expect(registry.requests.length).toBe(before);
  });
});
