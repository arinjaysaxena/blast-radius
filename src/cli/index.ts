// blast-radius CLI entry logic. `main` takes injectable I/O so tests never touch the network or process state.
import { writeFileSync } from 'node:fs';
import { UsageError, USAGE, parseArgs } from './args.js';
import { createResolver, run } from './run.js';
import type { SpecResolver } from './run.js';

export { USAGE, UsageError, parseArgs } from './args.js';
export type { CliOptions, OutputFormat } from './args.js';
export { createResolver, run } from './run.js';
export type { ResolverConfig, RunDeps, RunOptions, RunResult, SpecResolver } from './run.js';

export interface MainDeps {
  /** Normal output (reports, usage). */
  log?: (message: string) => void;
  /** Diagnostics: warnings and errors. */
  warn?: (message: string) => void;
  resolver?: SpecResolver;
  cwd?: string;
}

/** Run the CLI and return the process exit code: 0 ok, 1 breaking changes with `--fail-on-breaking`, 2 error. */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => { console.log(m); });
  const warn = deps.warn ?? ((m: string) => { console.error(m); });
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    warn(`error: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  try {
    const resolver =
      deps.resolver ??
      createResolver({ offline: opts.offline, noTypesFallback: opts.noTypesFallback, ...(deps.cwd ? { cwd: deps.cwd } : {}) });
    const { report, text } = await run(opts, { resolver, warn: (m) => { warn(`warning: ${m}`); } });
    if (opts.out) writeFileSync(opts.out, text);
    else log(text.replace(/\n$/, ''));
    return opts.failOnBreaking && report.summary.breaking > 0 ? 1 : 0;
  } catch (e) {
    warn(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
