/**
 * The ledger routes sit behind the Bearer guard, and the reply agent has no
 * social tool left in it. Source-level checks in the style of
 * route-auth-guard.test.ts, because index.ts boots on import.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('ledger admin routes', () => {
  const routes = read('../src/ledger/admin-routes.ts');
  const index = read('../src/index.ts');

  it('every ledger route is under /admin/ledger/', () => {
    const paths = [...routes.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[2]);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(paths.every((p) => p.startsWith('/admin/ledger/'))).toBe(true);
  });

  it('index.ts registers them AFTER app.use(prefix, requireAdminSecret)', () => {
    const gate = index.indexOf('app.use(prefix, requireAdminSecret)');
    const reg = index.indexOf('registerLedgerAdminRoutes(app)');
    expect(gate).toBeGreaterThan(0);
    expect(reg).toBeGreaterThan(gate);
  });

  it('the publish route accepts no text: the body carries only dry_run and force_standalone', () => {
    expect(routes).toMatch(/dry_run/);
    expect(routes).toMatch(/force_standalone/);
    expect(routes).not.toMatch(/req\.body\.(text|approved_text|proposed_text)/);
  });
});

describe('the reply agent proposes and never posts (D6)', () => {
  const agent = read('../src/agents/social/reply-agent.ts');
  it('has no social publish tool and files web_propose_reply', () => {
    expect(agent).not.toMatch(/twitter_publish_|farcaster_publish_/);
    expect(agent).not.toMatch(/callTool\('(twitter|farcaster)'/);
    expect(agent).toContain("callTool('web', 'web_propose_reply'");
    expect(agent).toContain("'PROPOSED'");
    expect(agent).not.toContain("'REPLIED'");
  });
});
