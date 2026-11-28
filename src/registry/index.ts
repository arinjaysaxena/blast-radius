export { PackageCache, defaultCacheRoot } from './cache.js';
export { RegistryClient, RegistryError, pickVersion } from './client.js';
export type { Packument, VersionManifest } from './client.js';
export { IntegrityError, computeIntegrity, verifyIntegrity } from './integrity.js';
export { DEFAULT_REGISTRY, loadNpmConfig, parseNpmrc } from './npmrc.js';
export type { NpmConfig } from './npmrc.js';
export { PackageResolver, parseSpec } from './resolver.js';
export type { ParsedSpec, ResolvedPackage, ResolverOptions } from './resolver.js';
export { shipsTypes, typesPackageName } from './types-fallback.js';
