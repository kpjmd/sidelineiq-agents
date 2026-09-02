/**
 * The published gap line.
 *
 * `content-formatter.ts` builds the actual Farcaster cast and X thread, so this
 * is not a queue-only concern: approving one of these posts publishes whatever
 * this prints. Three builders each computed `|team_timeline_weeks - max_weeks|`,
 * which is the elapsed time since injury plus the real divergence — and none of
 * them matched the midpoint rule that fired the flag, so a post could be
 * flagged with one number and published with another. Micah Parsons was flagged
 * at |39 - 45.5| = 6.5 and rendered as "+0".
 *
 * Which fail against pre-fix code:
 *   - Every test in "prints the anchored distance" FAILS pre-fix.
 *   - "no anchor" FAILS pre-fix — the old code printed a confident delta beside
 *     an "OTM read: …, start unconfirmed" line that admitted it did not know
 *     when the injury happened.
 *   - The source-grep FAILS pre-fix, and is what stops a fourth copy appearing.
 *   - "no team disclosure" is a fail-closed boundary passing in both directions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatConflictGapLine, formatForFarcaster } from '../src/utils/content-formatter.js';
import type { InjuryPostContent } from '../src/types.js';

const NOW = new Date('2026-09-02T00:00:00Z');

const content = (over: Partial<InjuryPostContent> = {}): InjuryPostContent =>
  ({
    athlete_name: 'Nick Bosa',
    sport: 'NFL',
    team: 'San Francisco 49ers',
    injury_type: 'ACL tear, right knee',
    injury_severity: 'SEVERE',
    content_type: 'CONFLICT_FLAG',
    headline: 'Bosa listed questionable',
    clinical_summary: 'Approximately 49 weeks removed from a confirmed right knee ACL rupture.',
    return_to_play: {
      min_weeks: 39,
      max_weeks: 52,
      probability_week_2: 0,
      probability_week_4: 0,
      probability_week_8: 0.05,
      confidence: 0.88,
    },
    confidence: 0.85,
    conflict_reason: 'Team timeline diverges from the literature window.',
    ...over,
  }) as InjuryPostContent;

describe('formatConflictGapLine — prints the anchored distance', () => {
  it('says a carryover sits inside the window rather than inventing a delta', () => {
    // The Bosa row: pre-fix this printed "Delta: 51+ weeks — conflict
    // threshold met" for a return comfortably inside 39-52.
    const line = formatConflictGapLine(
      content({ team_timeline_weeks: 1, injury_date: '2025-09-21' }),
      { now: NOW },
    );
    expect(line).toContain('inside the OTM window');
    expect(line).not.toMatch(/\d+w (short of|beyond)/);
  });

  it('names the distance outside the window, the implied total and the anchor', () => {
    const line = formatConflictGapLine(
      content({ team_timeline_weeks: 33, injury_date: '2026-01-11' }),
      { now: NOW },
    );
    expect(line).toContain('14w beyond the OTM window');
    expect(line).toContain('team ~66w total from 2026-01-11');
    expect(line).toContain('conflict threshold met');
  });

  it('omits the threshold claim when the distance is within tolerance', () => {
    const line = formatConflictGapLine(
      // 54 weeks claimed on a fresh injury against a 39-52 window: two weeks
      // past the ceiling, which is the threshold, not past it.
      content({ team_timeline_weeks: 54, injury_date: '2026-09-02' }),
      { now: NOW },
    );
    expect(line).toContain('beyond the OTM window');
    expect(line).not.toContain('conflict threshold met');
  });

  it('drops the anchor date but keeps the total in minimal width', () => {
    // minimal is buildConflictFarcasterCast's budget, hard-truncated at 320.
    const line = formatConflictGapLine(
      content({ team_timeline_weeks: 33, injury_date: '2026-01-11' }),
      { minimal: true, now: NOW },
    );
    expect(line).toContain('team ~66w total');
    expect(line).not.toContain('from 2026-01-11');
  });
});

describe('formatConflictGapLine — no anchor, no number', () => {
  it('says the gap is not computable instead of printing one', () => {
    const line = formatConflictGapLine(content({ team_timeline_weeks: 1 }), { now: NOW });
    expect(line).toContain('not computable');
    expect(line).toContain('injury date unresolved');
    expect(line).not.toMatch(/\d+w/);
  });

  it('distinguishes an undisclosed timeline from a missing anchor', () => {
    // Fail-closed boundary: these mean different things to a reader.
    const line = formatConflictGapLine(content({ injury_date: '2025-09-21' }), { now: NOW });
    expect(line).toContain('exceeds 2-week conflict threshold');
  });
});

describe('the published cast', () => {
  it('carries no un-anchored delta for a carryover injury', () => {
    const cast = formatForFarcaster(
      content({ team_timeline_weeks: 1, injury_date: '2025-09-21' }),
    ).join('\n');
    expect(cast).toContain('THE GAP');
    // The pre-fix cast said "Delta: 51+ weeks — conflict threshold met".
    expect(cast).not.toContain('51+');
    expect(cast).not.toContain('conflict threshold met');
  });

  it('labels the team disclosure with the clock it is on', () => {
    const cast = formatForFarcaster(
      content({ team_timeline_weeks: 1, injury_date: '2025-09-21' }),
    ).join('\n');
    expect(cast).toContain('Team timeline: 1 weeks from report');
  });
});

describe('one formula only', () => {
  it('no builder subtracts a team timeline from an RTP bound', () => {
    // The three pre-fix expressions, all `Math.abs(team - rtp.max_weeks)`.
    const src = readFileSync(
      fileURLToPath(new URL('../src/utils/content-formatter.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).not.toMatch(/team_timeline_weeks\s*-\s*rtp\./);
    expect(src).not.toMatch(/teamWeeks\s*-\s*rtp\./);
  });
});
