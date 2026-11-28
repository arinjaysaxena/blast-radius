import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKER, commentBody, main, pullNumber, readInputs, upsertComment } from '../src/action/index.js';
import type { FetchLike } from '../src/action/index.js';
import { tmpDir, writeTree } from './helpers.js';
import { NEW_DTS, OLD_DTS, mapResolver, pkgDir, project } from './cli-fixtures.js';

interface Call {
  method: string;
  path: string;
  body: { body: string } | null;
}

/** In-memory stand-in for the GitHub issue comments API. */
function fakeApi(existing: { id: number; body: string }[] = [], status = 200): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ method: init.method, path: url.replace('https://api.github.com', ''), body: init.body ? (JSON.parse(init.body) as { body: string }) : null });
    const json = init.method === 'GET' ? existing : {};
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(json) });
  };
  return { calls, fetchImpl };
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const dir = tmpDir('br-ev-');
  writeTree(dir, { 'event.json': JSON.stringify({ pull_request: { number: 42 } }) });
  return { INPUT_OLD: 'old', INPUT_NEW: 'new', INPUT_PROJECT: project(), INPUT_TOKEN: 'tok', GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_PATH: `${dir}/event.json`, ...extra };
}

const resolver = () => mapResolver({ old: pkgDir('lib', '1.0.0', OLD_DTS), new: pkgDir('lib', '2.0.0', NEW_DTS) });

describe('readInputs', () => {
  it('parses flags, defaults the project and falls back to GITHUB_TOKEN', () => {
    const i = readInputs({ INPUT_OLD: 'a', INPUT_NEW: 'b', INPUT_FAIL_ON_BREAKING: 'TRUE', INPUT_DRY_RUN: 'false', GITHUB_TOKEN: 'gt' });
    expect([i.project, i.failOnBreaking, i.dryRun, i.token]).toEqual(['.', true, false, 'gt']);
  });

  it('requires old and new', () => {
    expect(() => readInputs({ INPUT_OLD: 'a' })).toThrow(/required/);
  });
});

describe('commentBody', () => {
  it('prefixes the marker and truncates huge reports', () => {
    expect(commentBody('hello')).toBe(`${MARKER}\nhello\n`);
    const big = commentBody('x'.repeat(70_000));
    expect(big.length).toBeLessThan(61_000);
    expect(big).toMatch(/Report truncated/);
  });
});

describe('pullNumber', () => {
  it('reads pull_request.number or the top-level number', () => {
    const dir = tmpDir('br-ev-');
    writeTree(dir, { 'a.json': '{"number":7}', 'b.json': '{"issue":{}}' });
    expect(pullNumber({ GITHUB_EVENT_PATH: `${dir}/a.json` })).toBe(7);
    expect(() => pullNumber({ GITHUB_EVENT_PATH: `${dir}/b.json` })).toThrow(/not a pull request/);
    expect(() => pullNumber({})).toThrow(/GITHUB_EVENT_PATH is not set/);
  });
});

describe('upsertComment', () => {
  it('updates the existing marked comment in place', async () => {
    const api = fakeApi([{ id: 7, body: `${MARKER}\nold` }]);
    const result = await upsertComment({ fetchImpl: api.fetchImpl, env: {}, token: 't', repo: 'acme/app', number: 42, body: `${MARKER}\nnew` });
    expect(result).toBe('updated');
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/acme/app/issues/42/comments?per_page=100&page=1',
      'PATCH /repos/acme/app/issues/comments/7',
    ]);
  });

  it('pages through comments before creating a new one', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' }));
    const api = fakeApi(full);
    await upsertComment({ fetchImpl: api.fetchImpl, env: {}, token: 't', repo: 'a/b', number: 1, body: MARKER });
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(10);
    expect(api.calls.at(-1)?.method).toBe('POST');
  });

  it('surfaces API failures with the status code', async () => {
    const api = fakeApi([], 403);
    await expect(upsertComment({ fetchImpl: api.fetchImpl, env: {}, token: 't', repo: 'a/b', number: 1, body: MARKER })).rejects.toThrow(/failed \(403\)/);
  });
});

describe('action main', () => {
  it('dry run prints the comment and posts nothing', async () => {
    const api = fakeApi();
    const lines: string[] = [];
    const code = await main(env({ INPUT_DRY_RUN: 'true' }), { fetchImpl: api.fetchImpl, resolver: resolver(), log: (m) => lines.push(m) });
    expect(code).toBe(0);
    expect(api.calls).toEqual([]);
    expect(lines[0]).toContain(MARKER);
    expect(lines[0]).toContain('gone');
  });

  it('creates a comment when none carries the marker', async () => {
    const api = fakeApi([{ id: 1, body: 'unrelated' }]);
    const lines: string[] = [];
    expect(await main(env(), { fetchImpl: api.fetchImpl, resolver: resolver(), log: (m) => lines.push(m) })).toBe(0);
    expect(api.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(api.calls[1]?.path).toBe('/repos/acme/app/issues/42/comments');
    expect(api.calls[1]?.body?.body.startsWith(MARKER)).toBe(true);
    expect(lines).toEqual(['comment created']);
  });

  it('honours GITHUB_API_URL for GitHub Enterprise', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await main(env({ GITHUB_API_URL: 'https://ghe.example/api/v3' }), { fetchImpl, resolver: resolver(), log: () => undefined });
    expect(urls[0]).toMatch(/^https:\/\/ghe\.example\/api\/v3\/repos\/acme\/app\/issues\/42\/comments/);
  });

  it('returns 1 after posting when fail-on-breaking finds breakage; 2 on errors', async () => {
    const api = fakeApi();
    expect(await main(env({ INPUT_FAIL_ON_BREAKING: 'true' }), { fetchImpl: api.fetchImpl, resolver: resolver(), log: () => undefined })).toBe(1);
    expect(api.calls).toHaveLength(2);
    const lines: string[] = [];
    expect(await main(env({ INPUT_TOKEN: '' }), { fetchImpl: api.fetchImpl, resolver: resolver(), log: (m) => lines.push(m) })).toBe(2);
    expect(lines.at(-1)).toMatch(/no token/);
    expect(await main(env({ INPUT_NEW: 'missing@1.0.0' }), { fetchImpl: api.fetchImpl, resolver: resolver(), log: (m) => lines.push(m) })).toBe(2);
  });

  it('action.yml declares every input the code reads and runs the built entry', () => {
    const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    for (const k of ['old:', 'new:', 'project:', 'token:', 'fail-on-breaking:', 'dry-run:', 'INPUT_FAIL_ON_BREAKING', 'INPUT_DRY_RUN', 'using: composite', 'dist/action.js']) {
      expect(yml).toContain(k);
    }
  });
});
