/**
 * `web_get_social_state` returns an envelope, not the stored string.
 *
 * The real response text is `{"key": "...", "value": "<stored string>"}`, with
 * `value: null` when the key was never written. `defer-queue.ts` parsed that
 * text and then looked for `.entries` directly on it — where they never are —
 * so every load returned an empty queue. Corroboration never fired, TTL expiry
 * never fired, and because the save path appends to whatever load returned,
 * each deferral overwrote the one before it: the live NFL queue held exactly
 * one entry after six cycles that deferred 121 events.
 *
 * `defer_q=0` reported that as "queue empty" rather than "queue broken", which
 * is precisely what the `available` flag was introduced to prevent.
 *
 * Fixtures here are RECORDED from the live server
 * (tests/fixtures/social-state-responses.json). The old test helper in
 * defer-queue.test.ts hand-authored the bare state instead, so every test in
 * that file passed against the bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { readSocialState, readSocialStateValue } from '../src/utils/social-state.js';
import { evictExpired, handleDeferDecision } from '../src/monitoring/defer-queue.js';
import {
  _setConfigForTesting,
  _setTiersForTesting,
} from '../src/agents/injury-intelligence/significance.js';
import type { ClassificationResult } from '../src/types.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const LIVE: {
  populated: { content: Array<{ type: string; text: string }> };
  absent: { content: Array<{ type: string; text: string }> };
} = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/social-state-responses.json', import.meta.url)),
    'utf-8',
  ),
);

const DEFER_CONFIG = {
  ttl_hours: 6,
  promotion_cap: 3,
  corroboration_bonus_per_source: 5,
  corroboration_bonus_max: 20,
};

const TEST_CONFIG = {
  version: 1 as const,
  thresholds: {
    default: { process: 55, defer: 35 },
    BREAKING_T1: { process: 45, defer: 30 },
    TRACKING: { process: 70, defer: 35, require_tier_1_or_2: true },
    DEEP_DIVE: { process: 40, defer: 25 },
    CONFLICT_FLAG: { always_process: true },
  },
  sport_seasons: {},
  default_threshold_delta: 0,
  defer: DEFER_CONFIG,
};

/** Rebuild the live envelope around a queue we control, keeping the real shape. */
function envelope(value: string | null, key = 'defer_queue_v1:NFL') {
  return { content: [{ type: 'text', text: JSON.stringify({ key, value }) }] };
}

function entry(fingerprint: string, hoursToExpiry: number) {
  const now = Date.now();
  return {
    fingerprint,
    deferred_at: new Date(now - 3_600_000).toISOString(),
    expires_at: new Date(now + hoursToExpiry * 3_600_000).toISOString(),
    sport: 'NFL',
    athlete_name: 'Jake Bobo',
    classification: {
      content_type: 'BREAKING',
      athlete_tier: 3,
      athlete_tier_source: 'default',
      subscores: {
        athlete_prominence: 40,
        information_specificity: 30,
        event_recency_novelty: 15,
        content_type_prior: 75,
      },
      sport: 'NFL',
    },
    source_count: 1,
    promotion_count: 0,
  };
}

function classified(): ClassificationResult {
  return {
    is_injury_event: true,
    confidence: 0.9,
    sport: 'NFL',
    athlete_name: 'Jake Bobo',
    team: 'Seahawks',
    injury_description: 'placed on injured reserve',
    content_type: 'BREAKING',
    is_new: true,
    raw_event: {
      athlete_name: 'Jake Bobo',
      sport: 'NFL',
      team: 'Seahawks',
      injury_description: 'placed on injured reserve',
      source_name: 'ESPN',
      source_url: 'https://example.test/a',
      reported_at: new Date().toISOString(),
    },
    significance: {
      triage_decision: 'DEFER',
      composite_score: 40,
      athlete_tier: 3,
      athlete_tier_source: 'default',
      subscores: {
        athlete_prominence: 40,
        information_specificity: 30,
        event_recency_novelty: 15,
        content_type_prior: 75,
      },
      rationale: 'DEFER score=40',
    },
  } as ClassificationResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  _setConfigForTesting(TEST_CONFIG as Parameters<typeof _setConfigForTesting>[0]);
  _setTiersForTesting(null);
  mockIsServerAvailable.mockReturnValue(true);
});

describe('readSocialState — against recorded live responses', () => {
  it('unwraps the value from a populated key', () => {
    const read = readSocialState(LIVE.populated);
    expect(read.status).toBe('value');
    // The stored string is one JSON.parse deeper than the response text.
    const state = JSON.parse((read as { value: string }).value);
    expect(Array.isArray(state.entries)).toBe(true);
    expect(state.version).toBe(1);
  });

  it('reports an unwritten key as absent, not as a failure', () => {
    expect(readSocialState(LIVE.absent).status).toBe('absent');
    expect(readSocialStateValue(LIVE.absent)).toBeNull();
  });

  it('reports a tool-level error as unreadable, never as absent', () => {
    // isError resolves as a VALUE, not a throw — a try/catch never sees it.
    const read = readSocialState({ isError: true, content: [{ type: 'text', text: '{}' }] });
    expect(read.status).toBe('unreadable');
  });

  it('reports an unrecognized shape as unreadable, never as absent', () => {
    expect(readSocialState({ content: [{ type: 'text', text: 'not json' }] }).status).toBe(
      'unreadable',
    );
    expect(readSocialState({ content: [{ type: 'text', text: '{"value":42}' }] }).status).toBe(
      'unreadable',
    );
    expect(readSocialState(null).status).toBe('unreadable');
  });
});

describe('the defer queue actually loads what was stored', () => {
  it('sees the entries in a recorded live payload', async () => {
    // Against the pre-fix read this is 0 — the whole bug in one assertion.
    const stored = JSON.parse(LIVE.populated.content[0].text).value as string;
    const count = JSON.parse(stored).entries.length;
    expect(count).toBeGreaterThan(0);

    mockCallTool.mockResolvedValue(LIVE.populated);
    const result = await evictExpired('NFL');
    expect(result.available).toBe(true);
    expect(result.evicted + result.size).toBe(count);
  });

  it('does not overwrite the stored queue when adding a new entry', async () => {
    // The overwrite: load returned [], so save wrote [] + 1 and the live NFL
    // queue never held more than a single entry.
    mockCallTool.mockImplementation(async (_s, tool) => {
      if (tool === 'web_get_social_state') return envelope(JSON.stringify({ version: 1, entries: [entry('already:here', 5)] }));
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    await handleDeferDecision('NFL', 'brand:new', classified(), DEFER_CONFIG);

    const save = mockCallTool.mock.calls.find(([, tool]) => tool === 'web_set_social_state');
    expect(save).toBeDefined();
    const written = JSON.parse((save![2] as { value: string }).value);
    expect(written.entries.map((e: { fingerprint: string }) => e.fingerprint)).toEqual([
      'already:here',
      'brand:new',
    ]);
  });

  it('treats an absent key as a genuinely empty queue', async () => {
    mockCallTool.mockResolvedValue(LIVE.absent);
    const result = await evictExpired('NFL');
    expect(result.available).toBe(true);
    expect(result.size).toBe(0);
  });
});

describe('an unreadable store must not read as an empty one', () => {
  it('reports available:false so the summary shows defer_q=-1', async () => {
    mockCallTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    const result = await evictExpired('NFL');
    expect(result.available).toBe(false);
  });

  it('reports available:false for a stored blob with no entries array', async () => {
    // The exact pre-fix symptom, now refused instead of silently accepted.
    mockCallTool.mockResolvedValue(envelope(JSON.stringify({ key: 'x', value: 'y' })));
    const result = await evictExpired('NFL');
    expect(result.available).toBe(false);
  });

  it('never writes a queue it could not read', async () => {
    // saveQueue persists `entries` in full, so appending to a wrongly-empty
    // list destroys whatever was stored.
    mockCallTool.mockImplementation(async (_s, tool) => {
      if (tool === 'web_get_social_state') return { isError: true, content: [{ type: 'text', text: 'down' }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await handleDeferDecision('NFL', 'fp:x', classified(), DEFER_CONFIG);

    expect(result).toBe('deferred');
    expect(mockCallTool.mock.calls.some(([, tool]) => tool === 'web_set_social_state')).toBe(false);
  });
});
