/**
 * Per-cycle token counts for the poll loop's Anthropic calls.
 *
 * `usage` on a response is the only proof prompt caching is working: a prefix
 * that stops matching keeps succeeding and just costs more, with no error. One
 * line per sport per cycle rather than one per call, because the classifier runs
 * about 1,000 times a day.
 *
 * Keyed by sport because each sport polls on its own timer, so two cycles can
 * overlap. Totals are counts only and never affect a publishing decision.
 */
export type LlmRoute = 'classifier' | 'otm' | 'resolver';

/** The fields we read off `response.usage`. Test mocks often omit it entirely. */
export interface LlmUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface LlmUsageTotals {
  calls: number;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

const totals = new Map<string, Map<LlmRoute, LlmUsageTotals>>();

export function recordLlmUsage(
  sport: string,
  route: LlmRoute,
  usage: LlmUsageLike | null | undefined,
): void {
  let bySport = totals.get(sport);
  if (!bySport) {
    bySport = new Map();
    totals.set(sport, bySport);
  }
  let t = bySport.get(route);
  if (!t) {
    t = { calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 };
    bySport.set(route, t);
  }
  t.calls += 1;
  t.input += usage?.input_tokens ?? 0;
  t.cache_write += usage?.cache_creation_input_tokens ?? 0;
  t.cache_read += usage?.cache_read_input_tokens ?? 0;
  t.output += usage?.output_tokens ?? 0;
}

/** Returns one `[Usage]` line per route that ran for this sport, and resets it. */
export function drainLlmUsageLines(sport: string): string[] {
  const bySport = totals.get(sport);
  if (!bySport) return [];
  totals.delete(sport);
  return [...bySport.entries()].map(
    ([route, t]) =>
      `[Usage] ${sport} route=${route} calls=${t.calls} input=${t.input} cache_write=${t.cache_write} cache_read=${t.cache_read} output=${t.output}`,
  );
}
