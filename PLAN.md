# blast-radius plan

**Pitch.** blast-radius diffs the public API of two versions of an npm package (exports, signatures, removed or renamed symbols) and maps the changes onto your own call sites: "these 7 places touch changed APIs". It uses the TypeScript compiler API, so it understands declarations, overloads and re-exports, and it ships a GitHub Action that comments the report on a pull request. No network or model is needed for the analysis.

## v0.1 scope
- API extraction from `.d.ts` / TS sources via the TypeScript compiler API
- API diff: added, removed, renamed (heuristic), signature-changed symbols with breaking/non-breaking classification
- Call-site scanner for a user project: imports and usages of changed symbols
- CLI: `blast-radius <old> <new> [--project .]` (paths or `pkg@version`)
- Markdown + JSON report; GitHub Action that comments the report
- Tests are offline (fixture packages on disk)

## Schedule
### 2026-11-23 - foundations
- [x] Skeleton: ESM, node:test, eslint, CI
- [x] Public API extractor over in-memory TS sources (exports + signatures)

### 2026-11-24 - extraction
- [ ] Extractor for a package directory (package.json types/exports resolution)
- [ ] Classes, interfaces, enums, type aliases, re-exports, default exports

### 2026-11-25 - diff
- [ ] Diff engine: added / removed / changed with breaking classification
- [ ] Rename detection heuristic (same signature, similar name)

### 2026-11-27 - call sites
- [ ] Project scanner: resolve imports from the package, find usages via the checker
- [ ] Map diff entries to call sites with file:line

### 2026-11-29 - CLI + report
- [ ] CLI wiring, `pkg@version` fetching via npm pack (injectable)
- [ ] Markdown and JSON reporters

### 2026-12-01 - GitHub Action
- [ ] action.yml + comment script (updates existing comment)
- [ ] Action dry-run tests

### 2026-12-03 - quality
- [ ] Fixture-based end to end tests, large-package performance guard

### 2026-12-05 - ship
- [ ] README (pitch, demo GIF steps, install, usage, how it works, roadmap)
- [ ] LICENSE (MIT), polish, CI green

Status: in progress
