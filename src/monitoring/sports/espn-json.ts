/**
 * The one place a bounded-empty ESPN read is told apart from a failed one.
 *
 * Every other ESPN caller in this repo hand-rolls `fetch` and collapses both
 * outcomes into `[]` (espn-base.ts) or `null` (espn-ufc-scoreboard.ts). For a
 * feed that is acceptable: a missed cycle re-reads six hours later. For anything
 * that WRITES off the read it is not, because "this athlete has no games" and
 * "ESPN dropped this request" are the same value and only one of them is safe to
 * act on.
 *
 * The split, lifted verbatim from draft-snapshot.ts where it was module-private:
 *
 *  - **404 is a bad ROW.** Bounded and known — a forfeited pick, a retired
 *    athlete id. Return null; the caller skips it and counts it.
 *  - **A timeout, 429 or 5xx is a bad PAGE.** Throw. ESPN rate-limits by
 *    dropping a CONTIGUOUS BLOCK of requests, so a rate limit read as "no data"
 *    doesn't lose a random sample, it loses a run — and the caller must abort
 *    the whole pass and keep whatever it already had.
 *
 * The timeout is new, and it applies to the draft loader too. There was no
 * timeout on any HTTP call anywhere in this repo (only MCP connect had one), so
 * a hung socket stalled the calling loop indefinitely. A loop that walks the
 * whole ACTIVE thread corpus one athlete at a time is where that finally
 * matters. An AbortSignal timeout surfaces as a throw, which lands on the
 * bad-PAGE side — the cautious direction.
 */

/** A read that failed, as opposed to a resource that is genuinely absent. */
export class TransientEspnError extends Error {}

const DEFAULT_TIMEOUT_MS = 15_000;

function timeoutMs(): number {
  const raw = process.env.ESPN_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * GET a JSON document from ESPN.
 *
 * @returns the parsed body, or `null` for a 404.
 * @throws {TransientEspnError} on any other non-OK status, a timeout, or a
 *   transport error — every case where the absence of data is OUR failure
 *   rather than ESPN's answer.
 */
export async function fetchEspnJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    // A timeout and a DNS failure are both "we did not get an answer".
    throw new TransientEspnError(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new TransientEspnError(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (err) {
    // A 200 whose body is not JSON is ESPN serving an error page. Not an answer.
    throw new TransientEspnError(`malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
