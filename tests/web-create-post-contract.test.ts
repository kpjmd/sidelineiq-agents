import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatForWeb } from '../src/utils/content-formatter.js';
import { reconstructPostContent } from '../src/utils/post-content.js';
import schemaFixture from './fixtures/web-create-injury-post-schema.json' with { type: 'json' };
import rowFixture from './fixtures/injury-post-rows-optional-coverage.json' with { type: 'json' };

/**
 * The contract this file pins: every key we SEND to web_create_injury_post must
 * be a key that tool ACCEPTS.
 *
 * It was not. formatForWeb emitted a flat `confidence`; the tool's zod object
 * never declared it; `z.object` strips unknown keys and returns success. The
 * model's post-level confidence was therefore discarded on 183 of 472 live
 * PUBLISHED rows — every one of them on the auto-publish path, where there is no
 * human in the loop and the number is the only record of how close to the
 * threshold the post was. It survived in a log line and nowhere else, the same
 * failure family as platform_results living in memory only.
 *
 * Nothing raised. Nothing logged. The agent-side suite could not see it either,
 * because every test mocks callTool and asserts on the object we PASS — which is
 * exactly the object the server was throwing half of away. Only a recording of
 * what the server actually accepts can close that gap, which is why the fixture
 * here is a real tools/list response and must never be hand-authored.
 */

interface ToolFixture {
  tool: { name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean } };
}
interface RowFixture {
  rows: Array<Record<string, unknown>>;
}

const accepted = new Set(
  Object.keys((schemaFixture as unknown as ToolFixture).tool.inputSchema.properties),
);

/**
 * Empty, and it should stay empty. `status` sat here from 2026-09-10 to
 * 2026-09-11 as the one key we sent that the tool stripped — "deliberately",
 * because the review path relied on the row landing PUBLISHED and a second
 * call flipping it. That reliance was the bug: had the flip ever failed, a post
 * routed to physician review was live, and eligible for ApprovalSync's re-cast
 * to social. The server now declares `status` and `md_review_reason` and files
 * the review row in the same statement.
 *
 * Any unaccepted key is the md_review_confidence bug happening again.
 */
const KNOWN_UNACCEPTED = new Set<string>();

/** Every optional column formatForWeb branches on. */
const OPTIONAL_KEYS = [
  'source_url',
  'conflict_reason',
  'team_timeline_weeks',
  'parent_post_id',
  'injury_date',
] as const;

/**
 * Build the emitted-key set from RECORDED rows rather than a hand-made content
 * object. A hand-made one omits every optional, which would make the subset
 * assertion below pass while never exercising the branches that add keys.
 *
 * reconstructPostContent deliberately does not carry `source_url` (it rebuilds
 * content for re-publishing to Farcaster/X, which do not need it), so it is
 * re-attached here from the SAME recorded row — the live agent path does set it,
 * and that branch has to be covered.
 */
function emittedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const row of (rowFixture as unknown as RowFixture).rows) {
    const { content } = reconstructPostContent(row);
    expect(content, `fixture row ${String(row.id)} failed to reconstruct`).not.toBeNull();
    const withSource = {
      ...content!,
      ...(typeof row.source_url === 'string' && row.source_url
        ? { source_url: row.source_url }
        : {}),
    };
    for (const status of ['PUBLISHED', 'PENDING_REVIEW'] as const) {
      // The review path passes its reason; without it md_review_reason is
      // never emitted and the subset check could not see it.
      const reason = status === 'PENDING_REVIEW' ? 'confidence 0.62 below threshold 0.7' : undefined;
      for (const k of Object.keys(formatForWeb(withSource, status, reason))) keys.add(k);
    }
  }
  return keys;
}

describe('formatForWeb against the recorded web_create_injury_post schema', () => {
  it('sends nothing the tool would silently strip', () => {
    const stripped = [...emittedKeys()].filter(
      (k) => !accepted.has(k) && !KNOWN_UNACCEPTED.has(k),
    );
    // Pre-fix this is ['confidence'] — the entire bug, in one list.
    expect(stripped).toEqual([]);
  });

  it('sends md_review_confidence, which the tool now accepts', () => {
    // Guards the fixture, not the code: re-recording tools/list against an mcp
    // instance that has not deployed the schema change yet would otherwise make
    // the subset check above go green by shrinking what we send.
    expect(accepted.has('md_review_confidence')).toBe(true);
    expect(emittedKeys().has('md_review_confidence')).toBe(true);
  });

  it('carries the model post-level confidence into that key', () => {
    const { content } = reconstructPostContent(
      (rowFixture as unknown as RowFixture).rows[0],
    );
    const out = formatForWeb({ ...content!, confidence: 0.72 }, 'PUBLISHED');
    expect(out.md_review_confidence).toBe(0.72);
    // The two confidences are different judgements and must not collapse.
    expect((out.return_to_play_estimate as { confidence: number }).confidence).not.toBe(
      out.md_review_confidence,
    );
    expect(out).not.toHaveProperty('confidence');
  });

  it('keeps the exception list honest', () => {
    // A key that the schema now accepts must leave the exception list rather
    // than quietly widening the allowlist forever. (This is the test that fired
    // when `status` was declared.)
    expect([...KNOWN_UNACCEPTED].filter((k) => accepted.has(k))).toEqual([]);
  });

  it('sends the review question in keys the tool accepts', () => {
    // Guards the fixture as much as the code: re-recording tools/list against
    // an mcp that predates the change would drop these from `accepted`, and the
    // subset check above would then fail on them — the intended direction.
    for (const k of ['status', 'md_review_reason', 'md_review_required']) {
      expect(accepted.has(k), `${k} accepted`).toBe(true);
      expect(emittedKeys().has(k), `${k} emitted`).toBe(true);
    }
  });

  it('declares only the two statuses a create may produce', () => {
    const status = (schemaFixture as unknown as {
      tool: { inputSchema: { properties: { status: { enum: string[] } } } };
    }).tool.inputSchema.properties.status;
    expect(status.enum).toEqual(['PUBLISHED', 'PENDING_REVIEW']);
  });

  it('exercises every optional branch, so the subset check is not vacuous', () => {
    expect([...emittedKeys()]).toEqual(expect.arrayContaining([...OPTIONAL_KEYS]));
  });
});

/**
 * The four /seed payloads in index.ts call web_create_injury_post DIRECTLY,
 * bypassing formatForWeb. They carried the same wrong key — so the bug had
 * already occurred twice, and a contract test that only covered formatForWeb
 * would have left the second copy in the tree.
 */
describe('the direct /seed payloads honour the same contract', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');

  it('has four direct callers, and none of them sends a bare confidence', () => {
    const callers = source.match(/web_create_injury_post['"],\s*\{/g) ?? [];
    expect(callers).toHaveLength(4);

    // A flat `confidence:` at payload indent, i.e. not the nested RTP one.
    const flat = source.match(/^ {6}confidence: 0\.\d+,\n {6}status: /gm) ?? [];
    expect(flat).toEqual([]);
  });

  it('sends md_review_confidence instead, four times', () => {
    const renamed = source.match(/^ {6}md_review_confidence: 0\.\d+,$/gm) ?? [];
    expect(renamed).toHaveLength(4);
  });
});
