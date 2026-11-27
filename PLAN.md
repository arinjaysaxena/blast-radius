# blast-radius plan

Status: v1 rebuild in progress (TypeScript). Spec: [docs/DESIGN.md](docs/DESIGN.md).

v0.1 was a JavaScript prototype. v1 is a rewrite in strict TypeScript with two engines (structural API diff and a virtual upgrade type-check), a registry client with cache, SARIF output and a lockfile-aware GitHub Action.

Rules for v1:
- Work through the milestones in order; one or two tasks per working session, each a complete, tested change.
- v1 ships only when **every acceptance criterion** below passes and not before 2026-12-04.
- After v1 ships, keep going down the Roadmap section. There is always a next task.

## Milestone 1: TypeScript foundation (2026-11-27)
- [x] Add TypeScript strict config, tsup build, vitest, typescript-eslint; CI matrix Node 20/22 on Ubuntu and Windows
- [x] Port `model/` types and `report/` (markdown, json) to TS with tests
- [x] Port `extract/` to TS, keeping all existing behaviour covered by tests

## Milestone 2: real extraction (2026-11-28)
- [x] Entry resolution: `exports` conditions and subpaths, `typesVersions`, `types`, `main` + sibling `.d.ts`; one module per subpath export
- [x] Resolve aliases and re-exports (`export *`, `export { a as b }`, `export =`); capture overloads, type params, members, enum values, JSDoc `@deprecated`
- [x] Fixture packages for each pattern under `test/fixtures/packages/`

## Milestone 3: checker-based diff (2026-11-29)
- [x] Load old and new versions into one program under synthetic roots; wrap `isTypeAssignableTo` with a fallback and a guard test
- [ ] Compatibility rules table from DESIGN.md (parameters, returns, members, enums, overloads, constraints), variance-aware
- [ ] Rename detection with confidence scoring; deprecation reporting

## Milestone 4: registry + cache (2026-11-30)
- [ ] npm registry client honouring `.npmrc`, tarball download with sha512 integrity check, content-addressed cache
- [ ] Automatic `@types/<name>` fallback; `file:` and local path specs
- [ ] Port and delete the remaining JavaScript; repo is TypeScript only

## Milestone 5: usage scanner (2026-12-01)
- [ ] tsconfig loading (paths, project references), JS projects via allowJs
- [ ] Workspace discovery for npm, pnpm and yarn monorepos
- [ ] Resolve imports, requires, subpaths and method chains back to package symbols; record call sites with argument info

## Milestone 6: virtual upgrade type-check (2026-12-02)
- [ ] Overlay `CompilerHost` resolving the package to the cached new version
- [ ] Old-vs-new diagnostic delta limited to reachable files; map diagnostics to call sites
- [ ] Merge structural and semantic findings into one report with per-finding provenance

## Milestone 7: outputs + Action (2026-12-03)
- [ ] Terminal renderer with code frames and `--fail-on`
- [ ] SARIF 2.1.0 output; JSON schema doc (`docs/json-schema.md`)
- [ ] Action: lockfile diff (npm, pnpm, yarn) → analysis per bumped package → sticky comment + optional SARIF upload

## Milestone 8: v1 release (2026-12-04)
- [ ] Opt-in real-world e2e suite (zod, commander, uuid, date-fns, @types/node, chalk) and `npm run bench`
- [ ] README rewrite: pitch, real example output, install, CLI reference, Action usage, how it works, benchmarks
- [ ] CHANGELOG, version 1.0.0, release notes

### v1 acceptance criteria
- [ ] No `.js` sources left in `src/`; `tsc --noEmit` clean in strict mode
- [ ] Golden tests cover every rule in the compatibility table
- [ ] Semantic engine flags a real type error introduced by an upgrade in a fixture project
- [ ] Works on a pnpm monorepo fixture and a plain JS fixture
- [ ] SARIF validates against the 2.1.0 schema
- [ ] Action dry-run test produces the expected comment for a Dependabot-style lockfile diff
- [ ] CI green on Node 20 and 22, Ubuntu and Windows

## Roadmap (after v1, keep working down this list)
- [ ] `--fix`: codemods for renames and moved APIs (ts-morph based), dry run by default
- [ ] Transitive impact: flag breaking changes in dependencies of dependencies that leak through public types
- [ ] Changelog cross-reference: attach the release-notes paragraph that mentions each changed symbol
- [ ] Watch mode for local package development (`--watch` against a linked package)
- [ ] HTML report with a sortable table and inline code
- [ ] Performance: incremental extraction cache keyed by package integrity; parallel workspaces
- [ ] Docs site (GitHub Pages) with real upgrade case studies
