import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AGENT_TOOL } from '../src/agents/injury-intelligence/agent.js';
import { DATE_ANCHORING_SHARED } from '../src/agents/injury-intelligence/date-anchoring.js';
import { _setClientForTesting, resolveInjuryDate } from '../src/agents/injury-intelligence/date-resolution.js';

const SRC = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

const rtpProps = (AGENT_TOOL.input_schema.properties as Record<string, any>).return_to_play
  .properties as Record<string, { description?: string }>;

describe('RTP week bounds are anchored, and say so', () => {
  it('describes min_weeks and max_weeks distinctly', () => {
    // The PR #30 failure mode: an undescribed numeric field. Both bounds were
    // bare `{ type: 'number' }`, so nothing in the schema said what they were
    // measured FROM — and the model emitted 34-43 TOTAL weeks against a prompt
    // bullet demanding REMAINING.
    for (const k of ['min_weeks', 'max_weeks'] as const) {
      expect(rtpProps[k].description, k).toBeTruthy();
      expect(rtpProps[k].description!.length, k).toBeGreaterThan(80);
      expect(rtpProps[k].description, k).toMatch(/TOTAL time from the injury\/surgery date/);
      // Must say what it is NOT, too — the ambiguity is the whole bug.
      expect(rtpProps[k].description, k).toMatch(/NOT remaining time from today|same anchor/);
      expect(rtpProps[k].description, k).not.toMatch(/^Lower bound of the return-to-play window, in weeks\.$/);
    }
    expect(rtpProps.min_weeks.description).not.toBe(rtpProps.max_weeks.description);
  });

  it('tells the model injury_date is the ORIGINAL date, not the update date', () => {
    const d = (AGENT_TOOL.input_schema.properties as Record<string, any>).injury_date
      .description as string;
    expect(d).toMatch(/ORIGINAL/);
    expect(d).toMatch(/OMIT this field rather than substituting the report date/i);
  });

  it('leaves no REMAINING-from-today instruction anywhere in agent.ts', () => {
    // There were THREE sites and two already contradicted each other: the
    // thread block said REMAINING, one bullet said REMAINING, another said
    // total. buildOtmProjection has always added the weeks to injury_date.
    const src = SRC('src/agents/injury-intelligence/agent.ts');
    expect(src).not.toMatch(/REMAINING recovery time from today/);
    expect(src).not.toMatch(/Present RTP as REMAINING time from today/);
    expect(src).toMatch(/TOTAL recovery time measured FROM the injury\/surgery date/);
  });
});

/**
 * The sibling field on the OTHER clock. Every test here FAILS against pre-fix
 * code, whose entire description was "the parsed midpoint in weeks (e.g.,
 * '2-4 weeks' → 3)" — no anchor named at all, two lines below a comment
 * warning about exactly this failure mode.
 */
describe('team_timeline_weeks names its own clock', () => {
  const d = () =>
    (AGENT_TOOL.input_schema.properties as Record<string, any>).team_timeline_weeks
      .description as string;

  it('says REMAINING, and says what it is not', () => {
    expect(d()).toMatch(/REMAIN/);
    expect(d()).toMatch(/NOT total time since the injury/i);
    expect(d()).toMatch(/DIFFERENT CLOCK/i);
  });

  it('tells the model to omit game-status designations', () => {
    // "Questionable" is an availability label, not a timeline. Bosa's row
    // produced a team_timeline_weeks of 1 from one.
    expect(d()).toMatch(/Questionable/);
    expect(d()).toMatch(/OMIT/);
  });

  it('tells the model to omit season-ending floors', () => {
    expect(d()).toMatch(/season/i);
    expect(d()).toMatch(/PUP|IR/);
  });

  it('is described at the same weight as the bounds it is compared against', () => {
    // The asymmetry WAS the bug: ~80 words on each RTP bound, one clause here.
    expect(d().length).toBeGreaterThan(200);
  });

  it('mirrors the clock instruction in the prompt bullets', () => {
    const src = SRC('src/agents/injury-intelligence/agent.ts');
    expect(src).toMatch(/team_timeline_weeks is on the OPPOSITE clock/);
    // The model wrote its own week-gap arithmetic into conflict_reason; the
    // formatter's line is the authority.
    expect(src).toMatch(/Do NOT state a week-gap number in conflict_reason/);
  });
});

describe('DATE ANCHORING is shared, not copied', () => {
  it('no longer treats an announcement as the anchor for an old injury', () => {
    expect(DATE_ANCHORING_SHARED).not.toMatch(/operative anchor even if/i);
    expect(DATE_ANCHORING_SHARED).toMatch(/An ANNOUNCEMENT is not an OCCURRENCE/);
    expect(DATE_ANCHORING_SHARED).toMatch(/NEVER fall back to the report date/);
    expect(DATE_ANCHORING_SHARED).toMatch(/PUP-P/);
  });

  it('is referenced by both prompt sites rather than re-typed', () => {
    // The two copies had already drifted in three bullets. A shared constant
    // is only a drift lock if neither file re-types the block.
    for (const rel of [
      'src/agents/injury-intelligence/agent.ts',
      'src/agents/injury-intelligence/date-resolution.ts',
    ]) {
      const src = SRC(rel);
      expect(src, rel).toContain('${DATE_ANCHORING_SHARED}');
      expect(src, rel).not.toMatch(/operative anchor even if/i);
    }
  });

  it('reaches the resolver system prompt at runtime', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'emit_date_resolution',
          input: { injury_date: '2025-11-02', injury_date_confidence: 'confirmed' },
        },
      ],
    });
    _setClientForTesting({ messages: { create } } as never);
    await resolveInjuryDate({
      event: {
        athlete_name: 'Mykel Williams',
        sport: 'NFL',
        team: 'San Francisco 49ers',
        injury_description: 'Right Leg Knee - ACL Surgery — out — Status: Out',
        injury_description_long:
          'Like Williams, fellow edge rusher Nick Bosa is also recovering from an ACL tear suffered last year.',
        roster_designation: 'PUP-P',
        source_kind: 'feed',
        source_url: 'https://example.com/injuries',
        reported_at: new Date('2026-08-19T00:14:00Z'),
      },
      player: { full_name: 'Mykel Williams', current_team_name: 'San Francisco 49ers' } as never,
      metadata: { primary_body_part: 'KNEE', injury_type_hint: 'ACL' } as never,
      reportedAt: new Date('2026-08-19T00:14:00Z'),
      today: '2026-08-19',
    });

    const call = create.mock.calls[0][0];
    expect(call.system).toContain(DATE_ANCHORING_SHARED);

    // ...and the evidence the rules need is actually in the user message.
    const userMsg = call.messages[0].content as string;
    expect(userMsg).toContain('Source narrative');
    expect(userMsg).toContain('ACL tear suffered last year');
    expect(userMsg).toContain('Roster designation: PUP-P');
    expect(userMsg).toContain('Source kind: feed');
    expect(userMsg).toContain('CARRYOVER SIGNAL DETECTED');
    expect(userMsg).toContain('Do NOT emit the report date');
  });

  it('omits the carryover block when there is no carryover', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'emit_date_resolution',
          input: { injury_date: '2026-08-18', injury_date_confidence: 'probable' },
        },
      ],
    });
    _setClientForTesting({ messages: { create } } as never);
    await resolveInjuryDate({
      event: {
        athlete_name: 'Test Player',
        sport: 'NFL',
        team: 'Test Team',
        injury_description: 'Left Arm Shoulder Sprain — questionable',
        source_kind: 'feed',
        source_url: 'https://example.com/injuries',
        reported_at: new Date('2026-08-19T00:00:00Z'),
      },
      player: { full_name: 'Test Player', current_team_name: 'Test Team' } as never,
      metadata: { primary_body_part: 'SHOULDER', injury_type_hint: null } as never,
      reportedAt: new Date('2026-08-19T00:00:00Z'),
      today: '2026-08-19',
    });
    const userMsg = create.mock.calls[0][0].messages[0].content as string;
    expect(userMsg).not.toContain('CARRYOVER SIGNAL DETECTED');
    expect(userMsg).not.toContain('Source narrative');
  });

  afterEach(() => _setClientForTesting(null));
});
