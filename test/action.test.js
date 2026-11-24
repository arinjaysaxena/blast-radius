import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readInputs, commentBody, upsertComment, MARKER } from '../src/action.js';

const pkg = (version, dts) => {
  const d = mkdtempSync(join(tmpdir(), 'br-act-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'lib', version, types: 'index.d.ts' }));
  writeFileSync(join(d, 'index.d.ts'), dts);
  return d;
};
const OLD = pkg('1.0.0', 'export function parse(s: string): number;\nexport function gone(): void;\n');
const NEW = pkg('2.0.0', 'export function parse(s: string, strict: boolean): number;\n');
const proj = mkdtempSync(join(tmpdir(), 'br-actp-'));
mkdirSync(join(proj, 'src'));
writeFileSync(join(proj, 'src/a.ts'), "import { parse, gone } from 'lib';\nparse('x');\ngone();\n");
const event = join(mkdtempSync(join(tmpdir(), 'br-ev-')), 'event.json');
writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));

const baseEnv = { INPUT_OLD: OLD, INPUT_NEW: NEW, INPUT_PROJECT: proj, INPUT_TOKEN: 'tok', GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_PATH: event };

function fakeApi(existing = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method, path: url.replace('https://api.github.com', ''), body: init.body ? JSON.parse(init.body) : null });
    const json = init.method === 'GET' ? existing : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}

test('readInputs parses flags and requires old/new', () => {
  const i = readInputs({ INPUT_OLD: 'a', INPUT_NEW: 'b', INPUT_FAIL_ON_BREAKING: 'true', INPUT_DRY_RUN: 'false' });
  assert.deepEqual([i.project, i.failOnBreaking, i.dryRun], ['.', true, false]);
  assert.throws(() => readInputs({ INPUT_OLD: 'a' }), /required/);
});

test('commentBody prefixes the marker and truncates huge reports', () => {
  assert.ok(commentBody('hello').startsWith(MARKER));
  const big = commentBody('x'.repeat(70000));
  assert.ok(big.length < 61000);
  assert.match(big, /truncated/);
});

test('dry run prints the comment and posts nothing', async () => {
  const api = fakeApi();
  const lines = [];
  const code = await main({ ...baseEnv, INPUT_DRY_RUN: 'true' }, { fetchImpl: api.fetchImpl, log: (m) => lines.push(m) });
  assert.equal(code, 0);
  assert.equal(api.calls.length, 0);
  assert.match(lines[0], /blast-radius-report/);
  assert.match(lines[0], /gone/);
});

test('creates a comment when none carries the marker', async () => {
  const api = fakeApi([{ id: 1, body: 'unrelated' }]);
  const lines = [];
  assert.equal(await main(baseEnv, { fetchImpl: api.fetchImpl, log: (m) => lines.push(m) }), 0);
  assert.deepEqual(api.calls.map((c) => c.method), ['GET', 'POST']);
  assert.equal(api.calls[1].path, '/repos/acme/app/issues/42/comments');
  assert.ok(api.calls[1].body.body.startsWith(MARKER));
  assert.equal(lines[0], 'comment created');
});

test('updates the existing marked comment in place', async () => {
  const api = fakeApi([{ id: 7, body: `${MARKER}\nold` }]);
  const result = await upsertComment({ fetchImpl: api.fetchImpl, env: {}, token: 't', repo: 'acme/app', number: 42, body: `${MARKER}\nnew` });
  assert.equal(result, 'updated');
  assert.equal(api.calls[1].method, 'PATCH');
  assert.equal(api.calls[1].path, '/repos/acme/app/issues/comments/7');
});

test('fail-on-breaking returns 1 after posting; errors return 2', async () => {
  const api = fakeApi();
  assert.equal(await main({ ...baseEnv, INPUT_FAIL_ON_BREAKING: 'true' }, { fetchImpl: api.fetchImpl, log: () => {} }), 1);
  assert.equal(api.calls.length, 2);
  const lines = [];
  assert.equal(await main({ ...baseEnv, INPUT_TOKEN: '' }, { fetchImpl: api.fetchImpl, log: (m) => lines.push(m) }), 2);
  assert.match(lines[0], /no token/);
});

test('action.yml declares the inputs the script reads', () => {
  const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  for (const k of ['old:', 'new:', 'project:', 'token:', 'fail-on-breaking:', 'dry-run:', 'INPUT_FAIL_ON_BREAKING', 'INPUT_DRY_RUN', 'using: composite']) assert.ok(yml.includes(k), k);
});
