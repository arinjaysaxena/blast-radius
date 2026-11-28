// GitHub Action entry: build the report and create or update a single sticky PR comment.
import { readFileSync } from 'node:fs';
import { createResolver, run } from '../cli/run.js';
import type { SpecResolver } from '../cli/run.js';

export const MARKER = '<!-- blast-radius-report -->';
const MAX_BODY = 60_000;
const MAX_COMMENT_PAGES = 10;

type Env = Readonly<Record<string, string | undefined>>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ActionInputs {
  old: string;
  new: string;
  project: string;
  token: string;
  failOnBreaking: boolean;
  dryRun: boolean;
}

const truthy = (v: string): boolean => /^(1|true|yes)$/i.test(v);

/** Read action inputs from `INPUT_*` environment variables. */
export function readInputs(env: Env): ActionInputs {
  const get = (name: string): string => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();
  const inputs: ActionInputs = {
    old: get('old'),
    new: get('new'),
    project: get('project') || '.',
    token: get('token') || env['GITHUB_TOKEN'] || '',
    failOnBreaking: truthy(get('fail-on-breaking')),
    dryRun: truthy(get('dry-run')),
  };
  if (!inputs.old || !inputs.new) throw new Error('inputs "old" and "new" are required');
  return inputs;
}

/** Prefix the report with the sticky-comment marker and cap its size. */
export function commentBody(markdown: string): string {
  let text = markdown.trimEnd();
  if (text.length > MAX_BODY) {
    text = `${text.slice(0, MAX_BODY)}\n\n_Report truncated. Run blast-radius locally for the full list._`;
  }
  return `${MARKER}\n${text}\n`;
}

/** Pull request number from the event payload referenced by `GITHUB_EVENT_PATH`. */
export function pullNumber(env: Env): number {
  const path = env['GITHUB_EVENT_PATH'];
  if (!path) throw new Error('GITHUB_EVENT_PATH is not set; run this action on pull_request events');
  const event = JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: { number?: number }; number?: number };
  const n = event.pull_request?.number ?? event.number;
  if (!n) throw new Error('this event is not a pull request');
  return n;
}

interface ApiContext {
  fetchImpl: FetchLike;
  env: Env;
  token: string;
}

async function api(ctx: ApiContext, method: string, path: string, body?: unknown): Promise<unknown> {
  const base = ctx.env['GITHUB_API_URL'] || 'https://api.github.com';
  const res = await ctx.fetchImpl(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${ctx.token}`,
      'content-type': 'application/json',
      'user-agent': 'blast-radius',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (${res.status})`);
  return res.json();
}

export interface UpsertArgs extends ApiContext {
  repo: string;
  number: number;
  body: string;
}

/** Create the comment, or update the one carrying our marker. */
export async function upsertComment(args: UpsertArgs): Promise<'created' | 'updated'> {
  const base = `/repos/${args.repo}/issues`;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const list = (await api(args, 'GET', `${base}/${args.number}/comments?per_page=100&page=${page}`)) as {
      id: number;
      body?: string | null;
    }[];
    const mine = list.find((c) => c.body?.includes(MARKER));
    if (mine) {
      await api(args, 'PATCH', `${base}/comments/${mine.id}`, { body: args.body });
      return 'updated';
    }
    if (list.length < 100) break;
  }
  await api(args, 'POST', `${base}/${args.number}/comments`, { body: args.body });
  return 'created';
}

export interface ActionDeps {
  fetchImpl?: FetchLike;
  resolver?: SpecResolver;
  log?: (message: string) => void;
}

/** Run the action and return an exit code: 0 ok, 1 breaking changes with `fail-on-breaking`, 2 error. */
export async function main(env: Env = process.env, deps: ActionDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => { console.log(m); });
  try {
    const inputs = readInputs(env);
    const resolver = deps.resolver ?? createResolver({ env });
    const { report, text } = await run(
      { old: inputs.old, new: inputs.new, project: inputs.project, format: 'md' },
      { resolver, warn: (m) => { log(`warning: ${m}`); } },
    );
    const body = commentBody(text);
    if (inputs.dryRun) {
      log(body);
    } else {
      if (!inputs.token) throw new Error('no token: pass the "token" input or set GITHUB_TOKEN');
      const repo = env['GITHUB_REPOSITORY'];
      if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
      const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
      const result = await upsertComment({ fetchImpl, env, token: inputs.token, repo, number: pullNumber(env), body });
      log(`comment ${result}`);
    }
    return inputs.failOnBreaking && report.summary.breaking > 0 ? 1 : 0;
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
