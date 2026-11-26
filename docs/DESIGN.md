# blast-radius v1 design

> Before you bump a dependency, see exactly which lines of *your* code it breaks, type-checked against the new version, without installing it.

## The problem

Dependabot and Renovate open a PR that says `zod 3.23 → 4.0`. The changelog is 400 lines long. CI might catch the break, or might not: tests rarely cover every call site, and types only fail if the upgrade is actually installed and compiled. blast-radius answers the real question directly: **which of my call sites are affected, and why.**

## What v1 does

Illustrative output (exact messages come from the analysis):

```
$ blast-radius zod@3.23.8 zod@4.0.0 --project .

zod 3.23.8 → 4.0.0   12 API changes · 3 breaking for you · 41 call sites scanned

✖ src/forms/signup.ts:18:24   z.string().email()        BREAKING
    `email` moved to top level: use `z.email()`; `ZodString.email` is deprecated
    16 │ const schema = z.object({
    17 │   name: z.string().min(1),
  > 18 │   email: z.string().email({ message: "bad" }),
       │                    ^^^^^
✖ src/api/errors.ts:7:10      err.errors               BREAKING  type error TS2339
    property `errors` no longer exists on `ZodError` (renamed to `issues`)
⚠ src/util/parse.ts:33:5      z.nativeEnum(Role)        DEPRECATED

Not affected: 38 call sites use APIs that are unchanged or changed compatibly.
```

Two independent engines feed one report:

1. **API diff engine (structural).** Extracts the public API of both versions with the TypeScript compiler API and diffs it symbol by symbol, using the type checker's assignability relation, not string comparison.
2. **Virtual upgrade type-check (semantic).** Builds an in-memory `ts.Program` of the user's project in which the package resolves to the *new* version (from the fetched tarball), then reports only the diagnostics that are new compared with the old version and that sit on lines touching the package. This is the "compile against the upgrade without installing it" feature.

Each finding records which engine produced it: the structural engine explains *what changed*, the semantic engine proves *it breaks here*.

## Language and tooling

- **TypeScript (strict)** for everything. Node 20+.
- `typescript` as a runtime dependency (the compiler API is the core of the product).
- `vitest` for tests, `typescript-eslint` for linting, `tsup` for the build (ESM + CJS + `.d.ts`).
- CI matrix: Node 20 and 22, Ubuntu plus Windows (path handling matters).
- **Migration:** the current JavaScript implementation is ported module by module into `src/**/*.ts`. Once the TS version passes the existing tests plus the new ones, the JS files are deleted. The repo must end up TypeScript only.

## Architecture

```
src/
  cli/            argument parsing, terminal renderer (code frames, colours)
  registry/       npm registry client + tarball fetch + content-addressed cache
  model/          ApiSymbol, ApiChange, Finding, Report types (pure data)
  extract/        package entry resolution + public API extraction
  diff/           structural diff + compatibility rules + rename detection
  usage/          project scanner: imports → symbols → call sites
  upgrade/        virtual compiler host + diagnostic delta (semantic engine)
  report/         terminal / markdown / json / sarif renderers
  action/         GitHub Action entry: lockfile diff → analysis → PR comment
```

### registry/

- Resolve `name@range` through `https://registry.npmjs.org/<name>` (respect `.npmrc` registry and auth token if present).
- Download the tarball, verify `integrity` (sha512), and unpack into `~/.cache/blast-radius/<name>/<version>/` (XDG on Linux, `%LOCALAPPDATA%` on Windows). Content-addressed, so a second run is offline.
- Also fetch `@types/<name>` automatically when the package ships no types and an `@types` package exists for that major version.
- Local paths and `file:` specs work too (useful for testing a fork).

### extract/

- Entry resolution follows real Node and TypeScript rules: `exports` (conditions `types`, `import`, `require`, `default`, nested subpaths), `typesVersions`, `types`/`typings`, then `main` with sibling `.d.ts`. Every **subpath export** (`pkg/sub`) is its own module in the model.
- Build a `ts.Program` over the package's declaration files only, then for each entry `checker.getExportsOfModule(moduleSymbol)`, resolving aliases and re-exports (`export * from`, `export { a as b }`, `export =`).
- An `ApiSymbol` captures: kind (function, class, interface, type alias, enum, variable, namespace), fully qualified name (`zod#ZodString.email`), every call or construct signature (parameters with optionality, rest, defaults, type text **and** a handle to the `ts.Type`), type parameters with constraints, members for classes and interfaces (visibility, static, readonly, optional), enum members with values, and JSDoc tags (`@deprecated` with its message, `@since`).

### diff/

Changes are classified with the checker, not regexes:

| Change | Breaking for callers when |
|---|---|
| Symbol removed | always (unless a rename is detected) |
| Parameter added | it is required |
| Parameter type changed | the old parameter type is **not assignable** to the new one (narrowed) |
| Return type changed | the new return type is **not assignable** to the old one (widened) |
| Property / member removed | always |
| Property became required (input types) or optional (output types) | variance-aware: depends on whether the type is used in input or output position |
| Enum member removed or value changed | always |
| Overload removed | when no remaining overload accepts the old parameter list |
| Type parameter constraint tightened | old constraint not assignable to new |
| `@deprecated` added | never breaking, reported as DEPRECATED with the message |

Cross-version assignability needs both versions in one checker. Put both declaration trees in one program under synthetic roots (`/__old__/node_modules/pkg`, `/__new__/node_modules/pkg`) and compare types with `checker.isTypeAssignableTo`. That API is internal: wrap it behind one function with a fallback structural comparison, and add a test that fails loudly if a TypeScript upgrade removes it.

**Rename detection:** among removed and added symbols of the same kind, score candidate pairs by signature similarity (parameter count and types, member-set Jaccard), name similarity (normalised edit distance, shared tokens such as `errors`→`issues`), and `@deprecated` messages that mention the new name. Pairs above a threshold become `renamed` with a confidence value.

### usage/

- Load the user's `tsconfig.json` (or synthesise one with `allowJs`/`checkJs` for JavaScript projects). Respect `paths`, project references and monorepo workspaces (npm, pnpm and yarn workspaces: analyse every workspace that depends on the package).
- Find every import of the package or any of its subpaths: ESM `import`, `import()`, `require()`, `import x = require()`, re-exports, and type-only imports.
- Resolve each identifier use back to the package's exported symbol through the checker (handles aliases, destructuring, namespace imports, `z.string().email()` chains through return types, and instance methods via the declared type of the receiver).
- A call site records: file, line, column, the symbol path, the argument list, and whether it's a call, construct, property access, type reference or `extends`/`implements`.

### upgrade/ (semantic engine)

- A custom `ts.CompilerHost` overlays the module resolution: requests for `pkg` and `pkg/*` resolve into the cached new version; everything else resolves normally from the user's real `node_modules`.
- Run `getSemanticDiagnostics` on files that import the package, once with the old version and once with the new one. The **delta** (diagnostics present only with the new version) are the breakages, matched back to call sites by position.
- Bounded: only files reachable from importing files are type-checked, and a `--max-files` guard keeps big monorepos fast. Target: under 10 s for a 2,000-file project.

### report/

- **Terminal:** grouped by severity, with code frames, colours and a one-line summary. Exit code 1 with `--fail-on breaking`.
- **Markdown:** for PR comments, collapsible per-package sections, and links to the exact lines in the PR's head commit.
- **JSON:** a stable, versioned schema (`schemaVersion: 1`) documented in `docs/json-schema.md`.
- **SARIF 2.1.0:** so findings appear in GitHub code scanning as annotations on the diff.

### action/

- `action.yml` (Node 20 action). On a PR, diff `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` between base and head to find bumped packages (direct dependencies only by default), run the analysis for each, and post or update a single sticky comment. Optional SARIF upload.
- Works on Dependabot and Renovate PRs with the default `GITHUB_TOKEN`.

## Quality bar

- Strict TypeScript, no `any` in `src/` except at compiler-API boundaries (wrapped and commented).
- **Offline tests:** fixture packages live in `test/fixtures/packages/<name>/<version>/` as small hand-written `.d.ts` packages that reproduce real breaking-change patterns. Fixture user projects live in `test/fixtures/projects/`.
- **Golden tests:** each fixture scenario has a checked-in expected JSON report.
- **Real-world e2e suite** (network, opt-in via `npm run test:e2e`, not in default CI): `zod 3→4`, `commander 11→12`, `uuid 8→9`, `date-fns 2→3`, `@types/node 18→20`, `chalk 4→5`. Each asserts on known breaking findings.
- Benchmarks script (`npm run bench`) that prints extraction and diff times for the e2e packages.

## Out of scope for v1

Non-TypeScript ecosystems, runtime behaviour changes that aren't visible in types, and automatic code fixes (that's the roadmap).
