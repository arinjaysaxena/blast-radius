// npm registry client: packument lookup, version resolution and verified tarball download.
import semver from 'semver';
import { DEFAULT_REGISTRY, authHeaders, type NpmConfig } from './npmrc.js';
import { verifyIntegrity } from './integrity.js';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface VersionManifest {
  name: string;
  version: string;
  deprecated?: string;
  types?: string;
  typings?: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, VersionManifest>;
}

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface ClientOptions {
  config: NpmConfig;
  fetch?: FetchFn;
  /** Extra attempts after a network error or 5xx response. */
  retries?: number;
  /** Base delay between attempts in ms (multiplied by the attempt number). */
  retryDelayMs?: number;
  timeoutMs?: number;
}

const ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/** `@scope/name` → `@scope%2Fname`, as the registry expects. */
export function packumentUrl(registry: string, name: string): string {
  const base = registry.endsWith('/') ? registry : registry + '/';
  return base + name.replace('/', '%2F');
}

export class RegistryClient {
  private readonly fetchFn: FetchFn;
  private readonly cache = new Map<string, Promise<Packument>>();

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  registryFor(name: string): string {
    return this.opts.config.registryFor(name) || DEFAULT_REGISTRY;
  }

  private async request(url: string, registry: string, accept: string): Promise<Response> {
    const retries = this.opts.retries ?? 2;
    const delay = this.opts.retryDelayMs ?? 250;
    // Credentials only go to the configured registry, never to a foreign tarball host.
    const sameHost = new URL(url).host === new URL(registry).host;
    const headers = { accept, 'user-agent': 'blast-radius', ...(sameHost ? authHeaders(this.opts.config.authFor(registry)) : {}) };
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay * attempt));
      try {
        const res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
        if (res.status >= 500 && attempt < retries) {
          lastError = new RegistryError(`HTTP ${res.status} from ${url}`, res.status);
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new RegistryError(`could not reach ${new URL(url).host}: ${reason}`);
  }

  /** Fetch (and memoise) the package metadata document. */
  packument(name: string): Promise<Packument> {
    let p = this.cache.get(name);
    if (!p) {
      p = this.loadPackument(name);
      this.cache.set(name, p);
      p.catch(() => this.cache.delete(name));
    }
    return p;
  }

  private async loadPackument(name: string): Promise<Packument> {
    const registry = this.registryFor(name);
    const res = await this.request(packumentUrl(registry, name), registry, ACCEPT);
    if (res.status === 404) throw new RegistryError(`package "${name}" was not found in ${registry}`, 404);
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError(`access to "${name}" was denied by ${registry} (HTTP ${res.status}); check the auth token in your .npmrc`, res.status);
    }
    if (!res.ok) throw new RegistryError(`registry returned HTTP ${res.status} for "${name}"`, res.status);
    const doc = (await res.json()) as Partial<Packument>;
    if (!doc.versions || typeof doc.versions !== 'object') throw new RegistryError(`registry response for "${name}" has no versions`);
    return { name: doc.name ?? name, 'dist-tags': doc['dist-tags'] ?? {}, versions: doc.versions };
  }

  /** Resolve a dist-tag, exact version or semver range to one published version. */
  async resolve(name: string, spec = 'latest'): Promise<VersionManifest> {
    const doc = await this.packument(name);
    return pickVersion(doc, spec);
  }

  /** Download the tarball of `manifest` and verify its integrity before returning the bytes. */
  async tarball(manifest: VersionManifest): Promise<{ data: Buffer; integrity: string }> {
    const registry = this.registryFor(manifest.name);
    const res = await this.request(manifest.dist.tarball, registry, 'application/octet-stream');
    if (!res.ok) throw new RegistryError(`downloading ${manifest.name}@${manifest.version} failed (HTTP ${res.status})`, res.status);
    const data = Buffer.from(await res.arrayBuffer());
    const integrity = verifyIntegrity(data, manifest.dist.integrity, manifest.dist.shasum);
    return { data, integrity };
  }
}

/** Pure version selection, shared with offline lookups. */
export function pickVersion(doc: Packument, spec: string): VersionManifest {
  const tag = doc['dist-tags'][spec];
  const wanted = tag ?? spec;
  const exact = doc.versions[wanted];
  if (exact) return exact;
  const range = semver.validRange(wanted);
  if (range) {
    const best = semver.maxSatisfying(Object.keys(doc.versions), range);
    const manifest = best ? doc.versions[best] : undefined;
    if (manifest) return manifest;
  }
  const known = Object.keys(doc.versions).slice(-5).join(', ');
  throw new RegistryError(`no version of "${doc.name}" matches "${spec}" (latest versions: ${known || 'none'})`);
}
