// Command-line argument parsing for the blast-radius CLI.

export type OutputFormat = 'md' | 'json';

export interface CliOptions {
  old: string;
  new: string;
  project: string | null;
  format: OutputFormat;
  out: string | null;
  failOnBreaking: boolean;
  /** Resolve registry specs from the local cache only. */
  offline: boolean;
  /** Do not merge `@types/<name>` into packages that ship no declarations. */
  noTypesFallback: boolean;
  /** Maximum number of project files to scan. */
  maxFiles: number | null;
  help: boolean;
}

/** Thrown for invalid command lines; the CLI prints the message plus usage and exits with 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export const USAGE = [
  'usage: blast-radius <old> <new> [options]',
  '  <old>/<new> are package directories, file: specs or npm specs such as lodash@4.17.20',
  '',
  'options:',
  '  --project <dir>       scan this project for call sites of changed symbols',
  '  --format md|json      report format (default md)',
  '  --out <file>          write the report to a file instead of stdout',
  '  --fail-on-breaking    exit with status 1 when breaking changes are found',
  '  --offline             only use package versions that are already cached',
  '  --no-types-fallback   do not look for @types/<name> when a package ships no types',
  '  --max-files <n>       scan at most n project files',
  '  -h, --help            show this help',
].join('\n');

/** Parse `argv` (without the node and script entries). */
export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    old: '', new: '', project: null, format: 'md', out: null,
    failOnBreaking: false, offline: false, noTypesFallback: false, maxFiles: null, help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    // Accept both `--flag value` and `--flag=value`.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case '--project': o.project = value(); break;
      case '--format': {
        const f = value();
        if (f !== 'md' && f !== 'json') throw new UsageError('--format must be md or json');
        o.format = f;
        break;
      }
      case '--out': o.out = value(); break;
      case '--fail-on-breaking': o.failOnBreaking = true; break;
      case '--offline': o.offline = true; break;
      case '--no-types-fallback': o.noTypesFallback = true; break;
      case '--max-files': {
        const raw = value();
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || n < 1) throw new UsageError('--max-files must be a positive integer');
        o.maxFiles = n;
        break;
      }
      case '-h':
      case '--help': o.help = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${flag}`);
        positional.push(arg);
    }
  }
  if (o.help) return o;
  if (positional.length !== 2) throw new UsageError('expected exactly two arguments: <old> <new>');
  [o.old, o.new] = positional as [string, string];
  return o;
}
