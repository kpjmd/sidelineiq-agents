import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards which HTTP routes sit behind requireAdminSecret.
 *
 * index.ts calls start() at import time, so the app cannot be booted in a unit
 * test without standing up the polling loops. This reads the source instead and
 * checks the invariant that actually matters: every route is either gated by
 * prefix or on a short, deliberate public allowlist.
 *
 * The point is the DEFAULT. /poll/:sport ran the full pipeline
 * (pollSport -> publishInjuryPost) unauthenticated, so anyone with the Railway
 * URL could force live brand casts and drain the daily publish budget;
 * /seed/test-posts wrote PUBLISHED rows with real athlete names straight onto
 * the public site. Each was added ungated by omission, not by decision. If you
 * are here because this test failed, the fix is almost always to move the route
 * under a gated prefix — not to extend PUBLIC_ROUTES.
 */

const source = readFileSync(
  fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  'utf8',
);

/** Routes that are deliberately reachable without a secret. */
const PUBLIC_ROUTES = new Set([
  '/health', // Railway healthcheckPath — see railway.json
]);

function gatedPrefixes(): string[] {
  const prefixes: string[] = [];

  // Loop form: for (const prefix of ['/admin', '/poll', ...]) { app.use(prefix, requireAdminSecret); }
  const loop = source.match(
    /for \(const prefix of \[([^\]]+)\]\)\s*\{\s*app\.use\(prefix, requireAdminSecret\);/,
  );
  if (loop) prefixes.push(...[...loop[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  // Individual form: app.use('/admin', requireAdminSecret);
  // Accepted so that refactoring the gating style fails this test on its merits
  // rather than on its syntax.
  prefixes.push(
    ...[...source.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*requireAdminSecret\s*\)/g)].map(
      (m) => m[1],
    ),
  );

  return [...new Set(prefixes)];
}

function declaredRoutes(): string[] {
  return [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
    (m) => m[2],
  );
}

describe('HTTP route authentication', () => {
  const prefixes = gatedPrefixes();
  const routes = declaredRoutes();

  it('finds gated prefixes and routes at all', () => {
    // If this fails, the gating was removed or renamed — every assertion below
    // would otherwise pass vacuously.
    expect(prefixes.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(5);
  });

  it('gates every route that is not explicitly public', () => {
    const ungated = routes.filter(
      (r) => !PUBLIC_ROUTES.has(r) && !prefixes.some((p) => r === p || r.startsWith(`${p}/`)),
    );
    expect(ungated).toEqual([]);
  });

  it.each([
    ['/poll/:sport', 'runs the full pipeline and can publish live'],
    ['/test/publish', 'publishes live under the brand from an empty body'],
    ['/test/deep-dive', 'spends Sonnet tokens on an attacker-controlled body'],
    ['/seed/test-posts', 'writes PUBLISHED rows onto the public site'],
  ])('keeps %s gated (%s)', (route) => {
    expect(routes).toContain(route);
    expect(prefixes.some((p) => route.startsWith(`${p}/`))).toBe(true);
  });

  it('gates each prefix with the real middleware, not a stub', () => {
    // requireAdminSecret must still fail closed when the secret is unset,
    // otherwise gating the prefixes buys nothing.
    expect(source).toMatch(/if \(!expected\) \{[\s\S]*?res\.status\(503\)/);
    expect(source).toMatch(/timingSafeEqual/);
  });

  it('keeps the public allowlist minimal', () => {
    // A growing allowlist is how this regresses quietly.
    expect(PUBLIC_ROUTES.size).toBeLessThanOrEqual(2);
  });
});
