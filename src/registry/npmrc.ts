// Minimal .npmrc support: registry URLs (default and per scope) and auth tokens.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export interface RegistryAuth {
  /** Bearer token (`_authToken`). */
  token?: string;
  /** Pre-encoded basic credentials (`_auth`). */
  basic?: string;
}

export interface NpmConfig {
  /** Registry base URL (always with a trailing slash) responsible for the package name. */
  registryFor(packageName: string): string;
  /** Credentials for a registry URL, or undefined for anonymous access. */
  authFor(registryUrl: string): RegistryAuth | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Parse `.npmrc` text into key/value pairs, expanding `${VAR}` from `env`. Comments start with `#` or `;`. */
export function parseNpmrc(text: string, env: Env = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    value = value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => env[name] ?? whole);
    out.set(key, value);
  }
  return out;
}

const withSlash = (url: string): string => (url.endsWith('/') ? url : url + '/');

/** `//registry.example.com/path/` form used as the prefix of auth keys. */
function authPrefix(registryUrl: string): string {
  return withSlash(registryUrl).replace(/^[a-z]+:/i, '').toLowerCase();
}

/** Build a config from already-parsed settings (later maps override earlier ones). */
export function configFrom(layers: readonly Map<string, string>[], env: Env = {}): NpmConfig {
  const merged = new Map<string, string>();
  for (const layer of layers) for (const [k, v] of layer) merged.set(k, v);
  const envRegistry = env['NPM_CONFIG_REGISTRY'] ?? env['npm_config_registry'];
  const defaultRegistry = withSlash(envRegistry ?? merged.get('registry') ?? DEFAULT_REGISTRY);

  return {
    registryFor(name) {
      if (name.startsWith('@')) {
        const scope = name.slice(0, name.indexOf('/'));
        const scoped = merged.get(`${scope}:registry`);
        if (scoped) return withSlash(scoped);
      }
      return defaultRegistry;
    },
    authFor(registryUrl) {
      // Walk from the full path up to the host so `//host/a/b/` can fall back to `//host/`.
      let prefix = authPrefix(registryUrl);
      for (;;) {
        const token = merged.get(`${prefix}:_authToken`);
        const basic = merged.get(`${prefix}:_auth`);
        if (token) return { token };
        if (basic) return { basic };
        const trimmed = prefix.replace(/[^/]+\/$/, '');
        if (trimmed === prefix || trimmed === '//') return undefined;
        prefix = trimmed;
      }
    },
  };
}

function readIfExists(path: string, env: Env): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    return parseNpmrc(readFileSync(path, 'utf8'), env);
  } catch {
    return new Map(); // unreadable config is treated as absent
  }
}

export interface LoadOptions {
  /** Project directory whose `.npmrc` takes priority over the user's. */
  cwd?: string;
  home?: string;
  env?: Env;
}

/** Load `~/.npmrc` and `<cwd>/.npmrc` (project wins), then apply `NPM_CONFIG_REGISTRY`. */
export function loadNpmConfig(opts: LoadOptions = {}): NpmConfig {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const layers = [readIfExists(join(home, '.npmrc'), env), readIfExists(join(opts.cwd ?? process.cwd(), '.npmrc'), env)];
  return configFrom(layers, env);
}

/** HTTP headers carrying the credentials, if any. */
export function authHeaders(auth: RegistryAuth | undefined): Record<string, string> {
  if (auth?.token) return { authorization: `Bearer ${auth.token}` };
  if (auth?.basic) return { authorization: `Basic ${auth.basic}` };
  return {};
}
