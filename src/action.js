// GitHub Action entry: build the report and create or update a single PR comment.
import { readFileSync } from 'node:fs';
import { run } from './cli.js';

export const MARKER = '<!-- blast-radius-report -->';
const MAX_BODY = 60000;

const bool = (v) => /^(1|true|yes)$/i.test(String(v ?? ''));

/** Read action inputs from INPUT_* env vars. */
export function readInputs(env) {
  const get = (n) => (env[`INPUT_${n.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();
  const o = {
    old: get('old'), new: get('new'), project: get('project') || '.',
    token: get('token') || env.GITHUB_TOKEN || '',
    failOnBreaking: bool(get('fail-on-breaking')), dryRun: bool(get('dry-run')),
  };
  if (!o.old || !o.new) throw new Error('inputs "old" and "new" are required');
  return o;
}

export function commentBody(markdown) {
  let text = markdown.trimEnd();
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n\n_Report truncated. Run blast-radius locally for the full list._`;
  return `${MARKER}\n${text}\n`;
}

export function pullNumber(env) {
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is not set; run this action on pull_request events');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const n = event.pull_request?.number ?? event.number;
  if (!n) throw new Error('this event is not a pull request');
  return n;
}

async function api(fetchImpl, env, token, method, path, body) {
  const res = await fetchImpl(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'blast-radius' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (${res.status})`);
  return res.json();
}

/** Create the comment, or update the one carrying our marker. Returns 'created' | 'updated'. */
export async function upsertComment({ fetchImpl, env, token, repo, number, body }) {
  const base = `/repos/${repo}/issues`;
  for (let page = 1; page <= 10; page++) {
    const list = await api(fetchImpl, env, token, 'GET', `${base}/${number}/comments?per_page=100&page=${page}`);
    const mine = list.find((c) => c.body?.includes(MARKER));
    if (mine) {
      await api(fetchImpl, env, token, 'PATCH', `${base}/comments/${mine.id}`, { body });
      return 'updated';
    }
    if (list.length < 100) break;
  }
  await api(fetchImpl, env, token, 'POST', `${base}/${number}/comments`, { body });
  return 'created';
}

/** Returns an exit code. `resolver`, `fetchImpl` and `log` are injectable. */
export async function main(env = process.env, { fetchImpl = globalThis.fetch, resolver, log = console.log } = {}) {
  let inputs;
  try {
    inputs = readInputs(env);
    const { report, text } = run({ old: inputs.old, new: inputs.new, project: inputs.project, format: 'md' }, { resolver });
    const body = commentBody(text);
    if (inputs.dryRun) {
      log(body);
    } else {
      if (!inputs.token) throw new Error('no token: pass the "token" input or set GITHUB_TOKEN');
      const result = await upsertComment({ fetchImpl, env, token: inputs.token, repo: env.GITHUB_REPOSITORY, number: pullNumber(env), body });
      log(`comment ${result}`);
    }
    return inputs.failOnBreaking && report.summary.breaking > 0 ? 1 : 0;
  } catch (e) {
    log(`error: ${e.message}`);
    return 2;
  }
}
