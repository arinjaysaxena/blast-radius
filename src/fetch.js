// Resolve a CLI argument to a package directory: a local path, or `pkg@version` fetched via `npm pack`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Split "pkg@1.2.3", "@scope/pkg@^2" or "pkg" into { name, version }. Returns null for obviously non-registry specs. */
export function parseSpec(spec) {
  const m = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@([^\s/]+))?$/.exec(spec);
  return m ? { name: m[1], version: m[2] ?? 'latest' } : null;
}

const defaultExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Create a resolver. `exec(cmd, args, cwd)` is injectable so tests never touch the network.
 * resolve(spec) returns { dir, label }.
 */
export function createResolver({ exec = defaultExec, tmpRoot = tmpdir() } = {}) {
  const work = mkdtempSync(join(tmpRoot, 'blast-radius-'));
  let n = 0;
  return {
    work,
    resolve(spec) {
      if (existsSync(spec) && statSync(spec).isDirectory()) return { dir: resolve(spec), label: spec };
      const parsed = parseSpec(spec);
      if (!parsed) {
        throw new Error(`"${spec}" is neither a directory nor a package spec like name@1.2.3`);
      }
      const dest = join(work, String(++n));
      mkdirSync(dest, { recursive: true });
      let packed;
      try {
        packed = exec('npm', ['pack', `${parsed.name}@${parsed.version}`, '--silent', '--pack-destination', dest], dest).trim().split('\n').pop();
        exec('tar', ['-xzf', join(dest, packed), '-C', dest, '--strip-components=1'], dest);
      } catch (e) {
        throw new Error(`Could not fetch ${spec} with npm: ${(e.stderr ?? e.message).toString().trim().split('\n')[0]}`);
      }
      return { dir: dest, label: spec };
    },
  };
}
