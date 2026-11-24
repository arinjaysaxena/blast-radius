// CLI: blast-radius <old> <new> [--project .] [--format md|json] [--out file] [--fail-on-breaking]
import { writeFileSync } from 'node:fs';
import { extractPackage } from './package.js';
import { diffApi } from './diff.js';
import { scanProject } from './scan.js';
import { buildReport, renderJson, renderMarkdown } from './report.js';
import { createResolver } from './fetch.js';

export const USAGE = 'usage: blast-radius <old> <new> [--project dir] [--format md|json] [--out file] [--fail-on-breaking]\n  <old>/<new> are package directories or npm specs such as lodash@4.17.20';

export function parseArgs(argv) {
  const o = { old: null, new: null, project: null, format: 'md', out: null, failOnBreaking: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--project') o.project = val();
    else if (a === '--format') o.format = val();
    else if (a === '--out') o.out = val();
    else if (a === '--fail-on-breaking') o.failOnBreaking = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error('expected exactly two arguments: <old> <new>');
  [o.old, o.new] = pos;
  if (!['md', 'json'].includes(o.format)) throw new Error('--format must be md or json');
  return o;
}

/** Run the pipeline; returns { report, text }. `resolver` is injectable for tests. */
export function run(opts, { resolver = createResolver() } = {}) {
  const a = resolver.resolve(opts.old);
  const b = resolver.resolve(opts.new);
  const oldPkg = extractPackage(a.dir);
  const newPkg = extractPackage(b.dir);
  const entries = diffApi(oldPkg.api, newPkg.api);
  const name = newPkg.name ?? oldPkg.name;
  const sites = opts.project && name ? scanProject(opts.project, name, { onSkip: (f) => console.error(`warning: skipped ${f} (file too large)`) }) : [];
  const report = buildReport(entries, sites, {
    pkg: name,
    oldLabel: oldPkg.version ?? a.label,
    newLabel: newPkg.version ?? b.label,
    scanned: Boolean(opts.project),
  });
  return { report, text: opts.format === 'json' ? renderJson(report) : renderMarkdown(report) };
}

export function main(argv, { log = console.log, resolver } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(`${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    const { report, text } = run(opts, { resolver });
    if (opts.out) writeFileSync(opts.out, text);
    else log(text.replace(/\n$/, ''));
    return opts.failOnBreaking && report.summary.breaking > 0 ? 1 : 0;
  } catch (e) {
    log(`error: ${e.message}`);
    return 2;
  }
}
