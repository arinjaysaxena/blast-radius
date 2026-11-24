# blast-radius

Diff the public API of two versions of an npm package and see exactly which places in **your** code are affected: "these 6 places touch changed APIs".

It reads the type declarations of both versions with the TypeScript compiler API, classifies every change (added, removed, renamed, signature changed, breaking or not), then scans your project for imports and usages of the symbols that changed. No network or model is needed for the analysis.

<!-- ![demo](docs/demo.gif) -->
_Demo GIF: coming soon (recording steps below)._

<!-- To record docs/demo.gif, then uncomment the image above:
  1. Run the "Try it" commands below in a clean terminal (font size 16, width 100 columns).
  2. Record with: asciinema rec demo.cast && agg demo.cast docs/demo.gif
  3. Keep it under 15 seconds and commit docs/demo.gif. -->

## Install

Requires Node 20 or newer.

```sh
git clone https://github.com/arinjaysaxena/blast-radius
cd blast-radius && npm install
node bin/blast-radius.js
```

Run it with no arguments to print the usage line.

## Usage

```sh
blast-radius <old> <new> [--project dir] [--format md|json] [--out file] [--fail-on-breaking]
```

`<old>` and `<new>` are either package directories (with a `package.json` that points at its types) or npm specs such as `lodash@4.17.20`; specs are downloaded with `npm pack`.

| Option | Meaning |
| --- | --- |
| `--project dir` | Scan this project for call sites of changed symbols |
| `--format md\|json` | Markdown (default) or JSON report |
| `--out file` | Write the report to a file instead of stdout |
| `--fail-on-breaking` | Exit with status 1 when breaking changes are found |

### Try it

```sh
mkdir -p /tmp/br/old /tmp/br/new /tmp/br/proj/src
echo '{"name":"acme-http","version":"1.0.0","types":"index.d.ts"}' > /tmp/br/old/package.json
echo '{"name":"acme-http","version":"2.0.0","types":"index.d.ts"}' > /tmp/br/new/package.json
printf 'export function get(url: string): Promise<string>;\nexport function fetchJson(url: string): Promise<unknown>;\nexport function legacy(): void;\n' > /tmp/br/old/index.d.ts
printf 'export function get(url: string, opts: { timeout: number }): Promise<string>;\nexport function getJson(url: string): Promise<unknown>;\n' > /tmp/br/new/index.d.ts
printf "import { get, fetchJson, legacy } from 'acme-http';\nlegacy();\nfetchJson('/a');\nget('/b');\n" > /tmp/br/proj/src/app.ts
node bin/blast-radius.js /tmp/br/old /tmp/br/new --project /tmp/br/proj
```

Output:

```text
## Blast radius: `acme-http` `1.0.0` → `2.0.0`

3 API changes: 3 breaking, 0 added, 1 removed, 1 renamed, 1 changed.

#### `fetchJson` (renamed, breaking)
- renamed to "getJson"
- `src/app.ts:1`
- `src/app.ts:3`
...
```

## GitHub Action

Comment the report on every pull request that bumps a dependency. The action creates one comment and updates it on later pushes.

```yaml
on: pull_request
permissions:
  pull-requests: write
jobs:
  blast-radius:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: arinjaysaxena/blast-radius@main
        with:
          old: acme-http@1.0.0
          new: acme-http@2.0.0
          project: .
          fail-on-breaking: 'false'
```

Inputs: `old`, `new`, `project` (default `.`), `token` (default `github.token`), `fail-on-breaking`, `dry-run` (print the comment instead of posting it).

## How it works

1. **Extract.** Resolve each package's entry types via `package.json` (`types`, `typings`, `exports`) and walk the exported declarations with the TypeScript compiler API: functions and overloads, classes (public members only), interfaces, enums, namespaces, type aliases, re-exports and default exports.
2. **Diff.** Compare the two symbol tables. Removed symbols, new required parameters, changed types and removed members are classified as breaking; additions and new optional parameters are not. A removed symbol with a matching signature and a similar name is reported as a rename.
3. **Map.** Scan the project's TypeScript and JavaScript files, resolve imports from the package (including aliased and namespace imports) and use the type checker to find every usage of a changed symbol, reported as `file:line`.
4. **Report.** Render Markdown or JSON. Very large files are skipped with a warning.

## Roadmap

- Member-level call sites for changed class methods and properties
- Peer-dependency and `exports` map diffing
- SARIF output for code scanning
- Monorepo mode: scan several projects at once

## Development

```sh
npm install
npm test        # offline; uses fixture packages on disk
npm run lint
npm run build
```

## License

MIT
