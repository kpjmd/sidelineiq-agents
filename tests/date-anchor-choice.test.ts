/**
 * chooseDateAnchor — the one rule for which injury date everything measures from.
 *
 * Every test here FAILS against pre-fix code: the function did not exist. The
 * rule itself is unchanged (it was inlined in the poller), so what these pin is
 * that it is now in ONE place. It used to be applied AFTER processInjuryEvent
 * returned, which meant conflict detection inside the agent scored against a
 * different anchor than the one the post was formatted with.
 *
 * The source-grep tests are the load-bearing ones: they fail if a future edit
 * re-inlines the ternary anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseDateAnchor } from '../src/agents/injury-intelligence/date-anchoring.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

describe('chooseDateAnchor', () => {
  it.each(['probable', 'confirmed'] as const)(
    'a %s thread date beats the model, which saw only the short description',
    (confidence) => {
      expect(
        chooseDateAnchor(
          { injury_date: '2025-11-02', injury_date_confidence: confidence },
          '2026-08-19',
        ),
      ).toBe('2025-11-02');
    },
  );

  it.each(['possible', 'unknown'] as const)(
    'a %s thread date loses to the model',
    (confidence) => {
      expect(
        chooseDateAnchor(
          { injury_date: '2025-11-02', injury_date_confidence: confidence },
          '2026-08-19',
        ),
      ).toBe('2026-08-19');
    },
  );

  it('falls back to a low-confidence thread date when the model produced none', () => {
    expect(
      chooseDateAnchor({ injury_date: '2025-11-02', injury_date_confidence: 'possible' }, undefined),
    ).toBe('2025-11-02');
  });

  it('returns null when neither source has a date', () => {
    expect(chooseDateAnchor(undefined, undefined)).toBeNull();
    expect(chooseDateAnchor({ injury_date: null }, undefined)).toBeNull();
  });

  it('a confident thread with no date does not win', () => {
    expect(
      chooseDateAnchor({ injury_date: null, injury_date_confidence: 'confirmed' }, '2026-08-19'),
    ).toBe('2026-08-19');
  });
});

describe('chooseDateAnchor is the only copy of the rule', () => {
  it('both the poller and the agent import it', () => {
    expect(read('../src/monitoring/poller.ts')).toContain('chooseDateAnchor');
    expect(read('../src/agents/injury-intelligence/agent.ts')).toContain('chooseDateAnchor');
  });

  it.each(['../src/monitoring/poller.ts', '../src/agents/injury-intelligence/agent.ts'])(
    'no confidence ternary is re-inlined in %s',
    (path) => {
      // The pre-fix shape. If this string comes back, two anchors exist again.
      expect(read(path)).not.toContain("injury_date_confidence === 'probable'");
    },
  );
});
