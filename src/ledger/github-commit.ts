/**
 * Commit a published forecast row to the public ledger repository through the
 * GitHub Contents API (spec "Provenance": "Every forecast row is committed to
 * the repository at publish time; the commit timestamp and row_hash are the
 * proof of when the number went out"; D4: a dedicated public repo, never this
 * service's own, which would redeploy on every publish).
 *
 * Why GET before PUT: a publish that crashed after committing but before the
 * provenance write is re-run with the same forecast id, and the file is already
 * there. The Contents API answers that PUT with 422 ("sha wasn't supplied"), and
 * a blind retry would need the blob sha — which is exactly how an edit happens.
 * Rows are immutable, so an edit is never right. The helper reads the existing
 * file first: same row_hash → the commit already happened, return it
 * (`already_committed`); different row_hash → `LedgerCommitConflictError`, and
 * the caller posts nothing. Convergence by comparison, not by overwrite.
 *
 * Retry policy: 5xx, 429, a 403 that is a rate limit, and network failures are
 * retried with Retry-After or exponential backoff, four attempts; every other
 * 4xx fails at once — a 401/404/422 does not get better by waiting. The token
 * is set in headers inside `request` and nowhere else; errors carry the status
 * and GitHub's `message` field, never the request.
 *
 * Nothing here reads a shared index file. The repository tree is the index.
 */
import { ledgerHashInput, LEDGER_HASH_VERSION, shortHash } from './row-hash.js';
import type { PublishedLedgerRow } from './publishable.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubCommitDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  maxAttempts?: number;
  apiBase?: string;
}

export interface CommitOutcome {
  status: 'committed' | 'already_committed';
  sha: string;
  html_url: string;
  path: string;
}

export class LedgerCommitError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LedgerCommitError';
    this.status = status;
  }
}

export class LedgerCommitConflictError extends Error {
  constructor(path: string, fileHash: string | null, dbHash: string) {
    super(
      `ledger file ${path} already exists with a different row_hash (file=${fileHash ? shortHash(fileHash) : 'none'} db=${shortHash(dbHash)})`,
    );
    this.name = 'LedgerCommitConflictError';
  }
}

export class LedgerCommitNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`ledger commit is not configured: ${missing.join(', ')} unset`);
    this.name = 'LedgerCommitNotConfiguredError';
  }
}

/** Build deps from the environment. Throws, naming the variables, when the token or repo is absent. */
export function githubDepsFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch as FetchLike): GithubCommitDeps {
  const missing: string[] = [];
  const token = env.LEDGER_GITHUB_TOKEN;
  const repoSpec = env.LEDGER_GITHUB_REPO;
  if (!token) missing.push('LEDGER_GITHUB_TOKEN');
  if (!repoSpec) missing.push('LEDGER_GITHUB_REPO');
  if (missing.length > 0) throw new LedgerCommitNotConfiguredError(missing);
  const [owner, repo] = (repoSpec as string).split('/');
  if (!owner || !repo) throw new LedgerCommitNotConfiguredError(['LEDGER_GITHUB_REPO (expected owner/repo)']);
  return {
    fetch: fetchImpl,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    token: token as string,
    owner,
    repo,
    branch: env.LEDGER_GITHUB_BRANCH || 'main',
  };
}

export function forecastFilePath(entryId: string, version: number): string {
  return `forecasts/${entryId}/v${version}.json`;
}

export interface ForecastFile {
  path: string;
  message: string;
  /** Pretty-printed JSON; the reproducible part is hash_input, canonicalised at verify time. */
  body: string;
}

/**
 * What goes into the repository. `hash_input` is exactly the normalised object
 * that was hashed, so anyone can recompute sha256(canonicalize(hash_input))
 * and compare it with `row_hash`, the card and the posts. Internal ids (the
 * confirmer's UUID, player/entity links) stay out; `confirmed_at` is the one
 * provenance fact a reader needs beside the commit's own timestamp.
 */
export function buildForecastFile(row: PublishedLedgerRow): ForecastFile {
  const hashInput = ledgerHashInput(row);
  const body =
    JSON.stringify(
      {
        _schema: `paratros-ledger-forecast/${LEDGER_HASH_VERSION}: row_hash = sha256(canonicalize(hash_input)); canonicalize = keys sorted recursively, no whitespace (sidelineiq-agents src/ledger/row-hash.ts)`,
        hash_version: LEDGER_HASH_VERSION,
        row_hash: row.row_hash,
        hash_input: hashInput,
        confirmed_at: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
        commit_of: `${row.entry_id} v${row.version}`,
      },
      null,
      2,
    ) + '\n';
  return {
    path: forecastFilePath(row.entry_id, row.version),
    message: `ledger: ${row.entry_id} v${row.version} ${shortHash(row.row_hash)}`,
    body,
  };
}

interface GhResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

function isRateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
}

function retryDelayMs(res: Response | null, attempt: number): number {
  const ra = res?.headers.get('retry-after');
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

async function request(deps: GithubCommitDeps, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<GhResponse> {
  const url = `${deps.apiBase ?? 'https://api.github.com'}${path}`;
  const maxAttempts = deps.maxAttempts ?? 4;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${deps.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'paratros-ledger-publish',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = `network: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < maxAttempts - 1) await deps.sleep(retryDelayMs(null, attempt));
      continue;
    }
    const retryable = res.status >= 500 || isRateLimited(res);
    if (retryable) {
      lastError = `HTTP ${res.status}`;
      if (attempt < maxAttempts - 1) await deps.sleep(retryDelayMs(res, attempt));
      continue;
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  }
  throw new LedgerCommitError(`GitHub ${method} ${path} failed after ${maxAttempts} attempts (${lastError})`);
}

function ghMessage(json: unknown): string {
  const m = (json as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : 'no message';
}

function decodeContent(json: unknown): string | null {
  const content = (json as { content?: unknown } | null)?.content;
  if (typeof content !== 'string') return null;
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

/**
 * Commit `file` unless an identical row is already there. See the module
 * comment for the convergence rule.
 */
export async function commitForecastFile(deps: GithubCommitDeps, file: ForecastFile, expectedRowHash: string): Promise<CommitOutcome> {
  const repoPath = `/repos/${deps.owner}/${deps.repo}/contents/${file.path}`;
  for (let round = 0; round < 2; round++) {
    const existing = await request(deps, 'GET', `${repoPath}?ref=${encodeURIComponent(deps.branch)}`);
    if (existing.status === 200) {
      let fileHash: string | null = null;
      const text = decodeContent(existing.json);
      if (text !== null) {
        try {
          const parsed = JSON.parse(text) as { row_hash?: unknown };
          fileHash = typeof parsed.row_hash === 'string' ? parsed.row_hash : null;
        } catch {
          fileHash = null;
        }
      }
      if (fileHash !== expectedRowHash) throw new LedgerCommitConflictError(file.path, fileHash, expectedRowHash);
      const commits = await request(
        deps,
        'GET',
        `/repos/${deps.owner}/${deps.repo}/commits?path=${encodeURIComponent(file.path)}&sha=${encodeURIComponent(deps.branch)}&per_page=1`,
      );
      const first = Array.isArray(commits.json) ? (commits.json[0] as { sha?: string; html_url?: string } | undefined) : undefined;
      if (commits.status !== 200 || !first?.sha || !first.html_url) {
        throw new LedgerCommitError(`file ${file.path} exists but its commit could not be read (HTTP ${commits.status}: ${ghMessage(commits.json)})`, commits.status);
      }
      return { status: 'already_committed', sha: first.sha, html_url: first.html_url, path: file.path };
    }
    if (existing.status !== 404) {
      throw new LedgerCommitError(`GitHub GET ${file.path} returned HTTP ${existing.status}: ${ghMessage(existing.json)}`, existing.status);
    }

    const put = await request(deps, 'PUT', repoPath, {
      message: file.message,
      content: Buffer.from(file.body, 'utf8').toString('base64'),
      branch: deps.branch,
    });
    if (put.status === 201 || put.status === 200) {
      const commit = (put.json as { commit?: { sha?: string; html_url?: string } } | null)?.commit;
      if (!commit?.sha || !commit.html_url) throw new LedgerCommitError(`GitHub PUT ${file.path} succeeded without a commit in the response`, put.status);
      return { status: 'committed', sha: commit.sha, html_url: commit.html_url, path: file.path };
    }
    // 409/422: someone (a concurrent run of this same publish) created the file
    // between our GET and PUT. Loop once and compare what is there.
    if (put.status === 409 || put.status === 422) continue;
    throw new LedgerCommitError(`GitHub PUT ${file.path} returned HTTP ${put.status}: ${ghMessage(put.json)}`, put.status);
  }
  throw new LedgerCommitError(`GitHub PUT ${file.path} did not converge after a concurrent write`);
}
