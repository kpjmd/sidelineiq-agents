import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveInjuryDate,
  _setClientForTesting,
  type DateResolutionInput,
} from '../src/agents/injury-intelligence/date-resolution.js';
import type { RawInjuryEvent } from '../src/types.js';
import type { ResolvedPlayerInfo, ExtractedInjuryMetadata } from '../src/agents/injury-intelligence/fact-validator.js';

// ── Fixtures ──────────────────────────────────────────────────────────
const PLAYER: ResolvedPlayerInfo = {
  player_id: '11111111-1111-1111-1111-111111111111',
  full_name: 'Test Athlete',
  current_team_id: '22222222-2222-2222-2222-222222222222',
  current_team_name: 'Test Team',
  current_team_abbreviation: 'TT',
  prominence_tier: 1,
  confidence: 'exact',
  match_count: 1,
};

const METADATA: ExtractedInjuryMetadata = {
  body_parts: ['knee'],
  primary_body_part: 'knee',
  laterality: 'RIGHT',
  injury_type_hint: 'ACL tear',
};

function makeInput(overrides: Partial<RawInjuryEvent> = {}): DateResolutionInput {
  const reportedAt = new Date('2026-05-06T14:00:00Z'); // a Wednesday
  const event: RawInjuryEvent = {
    athlete_name: 'Test Athlete',
    sport: 'NBA',
    team: 'Test Team',
    injury_description: 'right knee injury',
    source_url: 'https://example.com/article',
    reported_at: reportedAt,
    source_name: 'ESPN',
    ...overrides,
  };
  return { event, player: PLAYER, metadata: METADATA, reportedAt, today: '2026-05-08' };
}

// Build a fake Anthropic message with a forced emit_date_resolution tool_use.
function emitMessage(input: Record<string, unknown>, extraBlocks: unknown[] = []) {
  return {
    stop_reason: 'tool_use',
    content: [...extraBlocks, { type: 'tool_use', name: 'emit_date_resolution', input }],
  };
}

let createMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createMock = vi.fn();
  _setClientForTesting({ messages: { create: createMock } });
});

afterEach(() => {
  _setClientForTesting(null);
  vi.restoreAllMocks();
});

describe('resolveInjuryDate', () => {
  it('(a) explicit date → confirmed, no web search', async () => {
    createMock.mockResolvedValueOnce(
      emitMessage({
        injury_date: '2026-05-04',
        injury_date_confidence: 'confirmed',
        surgery_confirmed: false,
      }),
    );

    const result = await resolveInjuryDate(makeInput());

    expect(result.injury_date).toBe('2026-05-04');
    expect(result.injury_date_confidence).toBe('confirmed');
    expect(result.used_web_search).toBe(false);
    // Fast path: exactly one model call, no search tool.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([{ url: 'https://example.com/article', stage: 'api' }]);
  });

  it('(b) relative "Wednesday" reference → probable, no web search', async () => {
    createMock.mockResolvedValueOnce(
      emitMessage({
        injury_date: '2026-05-06',
        injury_date_confidence: 'probable',
        surgery_confirmed: true,
        surgery_date: '2026-05-06',
      }),
    );

    const result = await resolveInjuryDate(
      makeInput({ injury_description: 'the team announced Wednesday he tore his ACL' }),
    );

    expect(result.injury_date).toBe('2026-05-06');
    expect(result.injury_date_confidence).toBe('probable');
    expect(result.surgery_confirmed).toBe(true);
    expect(result.used_web_search).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(1);
    // Pass 1 must be a forced tool_choice on emit_date_resolution.
    expect(createMock.mock.calls[0][0].tool_choice).toEqual({
      type: 'tool',
      name: 'emit_date_resolution',
    });
  });

  it('(c) vague window → Pass 1 unknown, Pass 2 web search resolves it', async () => {
    // Pass 1: weak.
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '', injury_date_confidence: 'possible' }),
    );
    // Pass 2: search results + a resolved emit.
    createMock.mockResolvedValueOnce(
      emitMessage(
        { injury_date: '2026-04-20', injury_date_confidence: 'probable', surgery_confirmed: true },
        [
          {
            type: 'web_search_tool_result',
            content: [
              { type: 'web_search_result', url: 'https://news.example/x', title: 'Surgery report' },
              { type: 'web_search_result', url: 'https://news.example/x', title: 'dup' }, // dedup
            ],
          },
        ],
      ),
    );

    const result = await resolveInjuryDate(makeInput());

    expect(result.injury_date).toBe('2026-04-20');
    expect(result.injury_date_confidence).toBe('probable');
    expect(result.used_web_search).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
    // Pass 2 declares the native web_search tool.
    const pass2Tools = createMock.mock.calls[1][0].tools as Array<{ type?: string; name?: string }>;
    expect(pass2Tools.some((t) => t.type === 'web_search_20260209')).toBe(true);
    expect(createMock.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
    // Sources include the API source plus the deduped web citation.
    expect(result.sources).toEqual([
      { url: 'https://example.com/article', stage: 'api' },
      { url: 'https://news.example/x', title: 'Surgery report', stage: 'web_search' },
    ]);
  });

  it('(d) nothing found after search → unknown, used_web_search true', async () => {
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '', injury_date_confidence: 'unknown' }),
    );
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '', injury_date_confidence: 'unknown' }),
    );

    const result = await resolveInjuryDate(makeInput());

    expect(result.injury_date).toBeNull();
    expect(result.injury_date_confidence).toBe('unknown');
    expect(result.used_web_search).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('drives pause_turn continuations in Pass 2 up to the cap', async () => {
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '', injury_date_confidence: 'unknown' }),
    );
    // Two pause_turn rounds, then a final emit.
    createMock.mockResolvedValueOnce({
      stop_reason: 'pause_turn',
      content: [{ type: 'server_tool_use', name: 'web_search', input: {} }],
    });
    createMock.mockResolvedValueOnce({
      stop_reason: 'pause_turn',
      content: [{ type: 'web_search_tool_result', content: [] }],
    });
    createMock.mockResolvedValueOnce(
      emitMessage({ injury_date: '2026-04-01', injury_date_confidence: 'probable' }),
    );

    const result = await resolveInjuryDate(makeInput());

    expect(result.injury_date).toBe('2026-04-01');
    expect(result.injury_date_confidence).toBe('probable');
    // 1 (pass1) + 3 (pass2 initial + 2 continuations) = 4 calls.
    expect(createMock).toHaveBeenCalledTimes(4);
  });
});
