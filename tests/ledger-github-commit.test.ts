/**
 * The Contents API helper converges by comparison, retries only what waiting
 * can fix, and never lets the token out of the request headers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildForecastFile,
  commitForecastFile,
  githubDepsFromEnv,
  LedgerCommitConflictError,
  LedgerCommitError,
  LedgerCommitNotConfiguredError,
  type GithubCommitDeps,
} from '../src/ledger/github-commit.js';
import { assertPublishable } from '../src/ledger/publishable.js';
import { canonicalize, sha256Hex } from '../src/ledger/row-hash.js';
import { publishedRow } from './helpers/ledger-published-row.js';

const row = publishedRow();
assertPublishable(row);
const file = buildForecastFile(row);

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function deps(fetchImpl: GithubCommitDeps['fetch']): GithubCommitDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return { fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, token: 'ghp_SECRET_TOKEN', owner: 'kpjmd', repo: 'paratros-ledger', branch: 'main', sleeps };
}

const PUT_OK = { content: { sha: 'blob1', path: file.path }, commit: { sha: 'c0ffee1234567', html_url: 'https://github.com/kpjmd/paratros-ledger/commit/c0ffee1234567' } };

describe('buildForecastFile (spec: Provenance)', () => {
  it('writes forecasts/<entry_id>/v<version>.json whose hash_input re-derives row_hash', () => {
    expect(file.path).toBe('forecasts/PT-2026-001/v1.json');
    expect(file.message).toBe(`ledger: PT-2026-001 v1 ${row.row_hash.slice(0, 8)}`);
    const parsed = JSON.parse(file.body);
    expect(parsed.row_hash).toBe(row.row_hash);
    expect(sha256Hex(canonicalize(parsed.hash_input))).toBe(row.row_hash);
    expect(parsed.hash_input.published_at).toBe('2026-10-06T18:04:05.123Z');
    expect(JSON.stringify(parsed)).not.toContain(row.confirmed_by);
    expect(file.body.endsWith('\n')).toBe(true);
  });
});

describe('commitForecastFile', () => {
  it('GETs first, then PUTs when the file is absent; the token travels only in the header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const d = deps(async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'GET') return res(404, { message: 'Not Found' });
      return res(201, PUT_OK);
    });
    const out = await commitForecastFile(d, file, row.row_hash);
    expect(out).toEqual({ status: 'committed', sha: 'c0ffee1234567', html_url: PUT_OK.commit.html_url, path: file.path });
    expect(calls.map((c) => c.init?.method)).toEqual(['GET', 'PUT']);
    expect(calls[0].url).toContain('/repos/kpjmd/paratros-ledger/contents/forecasts/PT-2026-001/v1.json?ref=main');
    const put = JSON.parse(calls[1].init?.body as string);
    expect(put.branch).toBe('main');
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(file.body);
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_SECRET_TOKEN');
    expect(JSON.stringify(put)).not.toContain('ghp_SECRET_TOKEN');
  });

  it('an existing file with the SAME row_hash is already_committed, read from the commit list; no PUT', async () => {
    const methods: string[] = [];
    const d = deps(async (url, init) => {
      methods.push(init?.method ?? 'GET');
      if (url.includes('/commits?')) return res(200, [{ sha: 'older1', html_url: 'https://github.com/kpjmd/paratros-ledger/commit/older1' }]);
      return res(200, { content: Buffer.from(file.body).toString('base64').replace(/(.{60})/g, '$1\n'), sha: 'blob1' });
    });
    const out = await commitForecastFile(d, file, row.row_hash);
    expect(out.status).toBe('already_committed');
    expect(out.sha).toBe('older1');
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('an existing file with a DIFFERENT row_hash is a conflict and nothing is written', async () => {
    const other = JSON.stringify({ row_hash: 'b'.repeat(64) });
    const methods: string[] = [];
    const d = deps(async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return res(200, { content: Buffer.from(other).toString('base64') });
    });
    await expect(commitForecastFile(d, file, row.row_hash)).rejects.toThrow(LedgerCommitConflictError);
    expect(methods).toEqual(['GET']);
  });

  it('retries 5xx and network failures with backoff, then surfaces the failure without the token', async () => {
    let n = 0;
    const d = deps(async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return res(503, { message: 'Service Unavailable' });
    });
    await expect(commitForecastFile(d, file, row.row_hash)).rejects.toThrow(LedgerCommitError);
    expect(n).toBe(4);
    expect(d.sleeps).toHaveLength(3);
    try {
      await commitForecastFile(d, file, row.row_hash);
    } catch (err) {
      expect(String(err)).not.toContain('ghp_SECRET_TOKEN');
    }
  });

  it('honours Retry-After on 429 and treats a 403 rate limit as retryable', async () => {
    let n = 0;
    const d = deps(async (_url, init) => {
      n++;
      if (n === 1) return res(429, { message: 'rate limited' }, { 'retry-after': '2' });
      if (n === 2) return res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
      if (init?.method === 'GET') return res(404, {});
      return res(201, PUT_OK);
    });
    const out = await commitForecastFile(d, file, row.row_hash);
    expect(out.status).toBe('committed');
    expect(d.sleeps[0]).toBe(2000);
  });

  it('never retries a 401/404-on-PUT/422-other: a plain 4xx fails at once', async () => {
    let n = 0;
    const d = deps(async () => {
      n++;
      return res(401, { message: 'Bad credentials' });
    });
    await expect(commitForecastFile(d, file, row.row_hash)).rejects.toThrow(/HTTP 401: Bad credentials/);
    expect(n).toBe(1);
    expect(d.sleeps).toHaveLength(0);
  });

  it('a PUT that loses a race (422) re-reads and converges on already_committed', async () => {
    let gets = 0;
    const d = deps(async (url, init) => {
      if (init?.method === 'PUT') return res(422, { message: '"sha" wasn\'t supplied.' });
      if (url.includes('/commits?')) return res(200, [{ sha: 'race1', html_url: 'https://github.com/kpjmd/paratros-ledger/commit/race1' }]);
      gets++;
      if (gets === 1) return res(404, {});
      return res(200, { content: Buffer.from(file.body).toString('base64') });
    });
    const out = await commitForecastFile(d, file, row.row_hash);
    expect(out).toMatchObject({ status: 'already_committed', sha: 'race1' });
  });
});

describe('githubDepsFromEnv', () => {
  it('names the missing variables and parses owner/repo', () => {
    expect(() => githubDepsFromEnv({})).toThrow(LedgerCommitNotConfiguredError);
    expect(() => githubDepsFromEnv({})).toThrow(/LEDGER_GITHUB_TOKEN, LEDGER_GITHUB_REPO/);
    const d = githubDepsFromEnv({ LEDGER_GITHUB_TOKEN: 't', LEDGER_GITHUB_REPO: 'kpjmd/paratros-ledger' }, vi.fn() as never);
    expect(d).toMatchObject({ owner: 'kpjmd', repo: 'paratros-ledger', branch: 'main' });
  });
});
