// Date Resolution Loop — runs INSIDE the Injury Thread Manager, BEFORE OTM.
//
// ESPN / News API reliably give the *report* date but rarely the injury-onset or
// surgery date. OTM's conflict flags depend on an accurate onset anchor. This
// module resolves that date in two passes:
//
//   Pass 1  — read the source text only (no web search). If confidence lands at
//             'probable' or 'confirmed', return immediately (the common, cheap path).
//   Pass 2  — only when Pass 1 is weak: re-run WITH Anthropic's native web_search
//             server tool to surface the specific date, then re-emit.
//
// The function is pure with respect to persistence: it returns the resolved dates
// and their provenance; the caller (poller) writes them to the thread via
// web_thread_update_dates. This keeps the loop unit-testable without a DB.

import Anthropic from '@anthropic-ai/sdk';
import type { RawInjuryEvent } from '../../types.js';
import type { ResolvedPlayerInfo, ExtractedInjuryMetadata } from './fact-validator.js';

const MODEL = 'claude-sonnet-4-6';

// Native server-side web search (dynamic filtering; no beta header, no separate
// code_execution tool). Capped to keep per-event cost/latency bounded.
const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209' as const,
  name: 'web_search',
  max_uses: 3,
};

const EMIT_TOOL = {
  name: 'emit_date_resolution',
  description:
    'Emit the resolved injury and surgery dates after reading the source (and, if used, the web search results).',
  input_schema: {
    type: 'object' as const,
    properties: {
      injury_date: {
        type: 'string',
        description:
          'ISO 8601 date (YYYY-MM-DD) when the injury or surgery occurred, resolved per the DATE ANCHORING rules. Empty string if undeterminable.',
      },
      injury_date_confidence: {
        type: 'string',
        enum: ['unknown', 'possible', 'probable', 'confirmed'],
      },
      surgery_date: {
        type: 'string',
        description: 'ISO 8601 date of surgery if distinct and determinable, else empty string.',
      },
      surgery_confirmed: {
        type: 'boolean',
        description:
          'True if a source confirms surgery occurred (independent of whether the surgery DATE is known).',
      },
      reasoning: {
        type: 'string',
        description: 'Brief source-cited explanation of the resolution.',
      },
    },
    required: ['injury_date_confidence'],
  },
};

export type DateConfidence = 'unknown' | 'possible' | 'probable' | 'confirmed';

export interface DateResolutionSource {
  url?: string;
  title?: string;
  stage: 'api' | 'web_search' | 'md_manual';
}

export interface DateResolutionInput {
  event: RawInjuryEvent;
  player: ResolvedPlayerInfo;
  metadata: ExtractedInjuryMetadata;
  reportedAt: Date;
  today: string; // YYYY-MM-DD
}

export interface DateResolutionResult {
  injury_date: string | null;
  injury_date_confidence: DateConfidence;
  surgery_date: string | null;
  surgery_confirmed: boolean;
  sources: DateResolutionSource[];
  used_web_search: boolean;
}

// Minimal structural type so tests can inject a fake without pulling the full
// Anthropic surface. Matches the repo's singleton-client convention (agent.ts).
interface AnthropicLike {
  messages: { create: (params: Record<string, unknown>) => Promise<AnthropicMessage> };
}

interface AnthropicBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  [key: string]: unknown;
}

interface AnthropicMessage {
  content: AnthropicBlock[];
  stop_reason?: string | null;
}

let client: AnthropicLike | null = null;

function getClient(): AnthropicLike {
  if (!client) {
    client = new Anthropic() as unknown as AnthropicLike;
  }
  return client;
}

// Test seam: inject a fake client (or null to reset to a real one).
export function _setClientForTesting(fake: AnthropicLike | null): void {
  client = fake;
}

// ── Prompt construction ──────────────────────────────────────────────
// The DATE ANCHORING block is lifted verbatim from agent.ts so resolution logic
// is identical to OTM's. Confidence tiers are added below it.
function buildSystemPrompt(): string {
  return `You resolve WHEN a professional athlete's injury or surgery occurred. Accuracy is critical — these dates drive evidence-based return-to-play projections and conflict-flag generation. Output ONLY via the emit_date_resolution tool.

DATE ANCHORING — CRITICAL:
- "Reported at" is when the SOURCE ARTICLE was published. "Current date" is today. Neither is automatically when the injury/surgery occurred — but "Reported at" IS the anchor for resolving relative date language in the source.
- Resolve relative date references in the source against "Reported at":
    - "today", "this morning", "earlier today" → the calendar date of "Reported at"
    - "yesterday" → one day before "Reported at"
    - A weekday name ("Wednesday", "Monday", etc.) → the most recent occurrence of that weekday on or before "Reported at". Example: if "Reported at" is Wed 2026-05-06 and the source says "the team announced Wednesday", the anchor date is 2026-05-06; if the source says "announced Monday", it is 2026-05-04.
    - "last week", "earlier this week", "recently" → ambiguous; do not set a specific injury_date.
- When a source says the team "announced [surgery/injury] [day]", resolve that day to a calendar date. The announcement date is the operative anchor even if the procedure itself occurred 1-2 days earlier — that variance is negligible against a multi-week RTP window.
- Extract or infer the actual injury/surgery date from absolute references too (e.g., "underwent surgery in January", "injured three weeks ago", "recovering since October").

CONFIDENCE TIERS (set injury_date_confidence):
- confirmed = an explicit calendar date stated by the team or a Tier-1 credentialed reporter (Shams, Woj, Rapoport, Pelissero, Schefter equivalent).
- probable = a relative reference ("Wednesday", "yesterday", "today") resolvable against the report date, OR "underwent surgery [month]" with an unambiguous year.
- possible = only a vague window ("a few weeks ago", "earlier this season").
- unknown = no usable date anchor at all.

DISTINCTIONS:
- The injury-occurred date and the surgery-performed date are different — resolve each separately.
- Surgery CONFIRMATION is distinct from the surgery DATE — a surgery can be confirmed without a known date. Set surgery_confirmed accordingly.
- Player statements may underreport severity — weight official team reports and credentialed reporters higher.
- Never guess or fabricate a date to raise confidence. If no rule resolves a date, leave injury_date empty and set confidence to 'unknown' or 'possible'.`;
}

function buildUserMessage(input: DateResolutionInput, withSearch: boolean): string {
  const { event, player, metadata, reportedAt, today } = input;
  const base = `Resolve the injury/surgery date.
Athlete: ${player.full_name}
Team: ${player.current_team_name ?? event.team}
Sport: ${event.sport}
Injury (raw): ${event.injury_description}
Body part: ${metadata.primary_body_part ?? 'unspecified'}${metadata.injury_type_hint ? ` (${metadata.injury_type_hint})` : ''}
Source: ${event.source_url}
Source name: ${event.source_name ?? 'unknown'}
Reported at: ${reportedAt.toISOString()}
Current date: ${today}`;

  if (!withSearch) {
    return `${base}

Resolve the date from the source text above, then emit via emit_date_resolution.`;
  }

  return `${base}

The source text alone was insufficient to resolve the date with confidence. Use web_search to find the specific date this injury or surgery occurred — search the athlete name plus the injury and team, targeting recent, credentialed reporting. Then emit via emit_date_resolution with the best-supported date and confidence tier.`;
}

// ── Response parsing ─────────────────────────────────────────────────
function extractEmit(blocks: AnthropicBlock[]): Record<string, unknown> | null {
  // The forced/auto emit_date_resolution tool_use block.
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.name === 'emit_date_resolution' && block.input) {
      return block.input;
    }
  }
  return null;
}

function extractSearchSources(blocks: AnthropicBlock[]): DateResolutionSource[] {
  const sources: DateResolutionSource[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = Array.isArray(block.content) ? block.content : [];
    for (const r of results as Array<Record<string, unknown>>) {
      if (r?.type !== 'web_search_result') continue;
      const url = typeof r.url === 'string' ? r.url : undefined;
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      sources.push({
        url,
        title: typeof r.title === 'string' ? r.title : undefined,
        stage: 'web_search',
      });
    }
  }
  return sources;
}

function toResult(
  emit: Record<string, unknown> | null,
  sources: DateResolutionSource[],
  usedWebSearch: boolean,
): DateResolutionResult {
  const injuryDateRaw = typeof emit?.injury_date === 'string' ? emit.injury_date.trim() : '';
  const surgeryDateRaw = typeof emit?.surgery_date === 'string' ? emit.surgery_date.trim() : '';
  const confidence = (emit?.injury_date_confidence as DateConfidence) ?? 'unknown';
  return {
    injury_date: injuryDateRaw || null,
    injury_date_confidence: ['unknown', 'possible', 'probable', 'confirmed'].includes(confidence)
      ? confidence
      : 'unknown',
    surgery_date: surgeryDateRaw || null,
    surgery_confirmed: emit?.surgery_confirmed === true,
    sources,
    used_web_search: usedWebSearch,
  };
}

/**
 * Resolve the injury/surgery date for an athlete injury event.
 *
 * Pass 1 reads the source only. If confidence is probable/confirmed it returns
 * without paying for a web search. Otherwise Pass 2 runs the native web_search
 * server tool and re-emits, returning whatever confidence results (the caller
 * flags needs_date_review when it is still 'unknown').
 *
 * Never throws for a "no date found" outcome — that is a valid 'unknown' result.
 */
export async function resolveInjuryDate(
  input: DateResolutionInput,
): Promise<DateResolutionResult> {
  const anthropic = getClient();
  const system = buildSystemPrompt();
  const apiSource: DateResolutionSource[] = input.event.source_url
    ? [{ url: input.event.source_url, stage: 'api' }]
    : [];

  // ── Pass 1: source text only, forced emit ──────────────────────────
  const pass1 = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    tools: [EMIT_TOOL],
    tool_choice: { type: 'tool', name: 'emit_date_resolution' },
    messages: [{ role: 'user', content: buildUserMessage(input, false) }],
  });

  const pass1Emit = extractEmit(pass1.content ?? []);
  const pass1Result = toResult(pass1Emit, apiSource, false);

  if (
    pass1Result.injury_date_confidence === 'probable' ||
    pass1Result.injury_date_confidence === 'confirmed'
  ) {
    return pass1Result; // fast path — no search cost
  }

  // ── Pass 2: with web_search. tool_choice must be 'auto' (the server
  // runs web_search first), so drive pause_turn continuations to a cap. ──
  const pass2Params = {
    model: MODEL,
    max_tokens: 4096,
    system,
    tools: [WEB_SEARCH_TOOL, EMIT_TOOL],
    tool_choice: { type: 'auto' as const },
  };
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: buildUserMessage(input, true) },
  ];

  const allBlocks: AnthropicBlock[] = [];
  let response = await anthropic.messages.create({ ...pass2Params, messages });
  allBlocks.push(...(response.content ?? []));

  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < 3) {
    messages.push({ role: 'assistant', content: response.content });
    response = await anthropic.messages.create({ ...pass2Params, messages });
    allBlocks.push(...(response.content ?? []));
    continuations += 1;
  }

  const pass2Emit = extractEmit(allBlocks);
  const sources = [...apiSource, ...extractSearchSources(allBlocks)];
  // Fall back to Pass 1's emit if Pass 2 never emitted (e.g. exhausted continuations).
  return toResult(pass2Emit ?? pass1Emit, sources, true);
}
