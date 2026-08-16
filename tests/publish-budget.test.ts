import { describe, it, expect } from 'vitest';
import {
  publishBudgetExhausted,
  type PublishBudgetState,
  type PublishBudgetLimits,
} from '../src/monitoring/poller.js';

const LIMITS: PublishBudgetLimits = {
  maxAgentCallsPerCycle: 8,
  maxPublishesPerCycle: 3,
  maxReviewsPerCycle: 3,
};

function state(overrides: Partial<PublishBudgetState> = {}): PublishBudgetState {
  return {
    agentCalls: 0,
    cyclePublishes: 0,
    cycleReviews: 0,
    dayPublishRemaining: 10,
    dayReviewRemaining: 10,
    ...overrides,
  };
}

describe('publishBudgetExhausted', () => {
  it('allows work when nothing is spent', () => {
    expect(publishBudgetExhausted(state(), LIMITS)).toBeNull();
  });

  it('allows the last slot under each cap', () => {
    expect(publishBudgetExhausted(state({ agentCalls: 7 }), LIMITS)).toBeNull();
    expect(publishBudgetExhausted(state({ cyclePublishes: 2 }), LIMITS)).toBeNull();
    expect(publishBudgetExhausted(state({ dayPublishRemaining: 1 }), LIMITS)).toBeNull();
  });

  it('blocks when the agent call cap is reached', () => {
    expect(publishBudgetExhausted(state({ agentCalls: 8 }), LIMITS)).toBe('agent_call_cap:8/8');
  });

  it('fails open on an unknown day count', () => {
    expect(
      publishBudgetExhausted(
        state({ dayPublishRemaining: Infinity, dayReviewRemaining: Infinity }),
        LIMITS
      )
    ).toBeNull();
  });

  it('blocks only when BOTH lanes are spent', () => {
    expect(
      publishBudgetExhausted(state({ cyclePublishes: 3, cycleReviews: 3 }), LIMITS)
    ).toContain('output_cap:');

    expect(
      publishBudgetExhausted(
        state({ dayPublishRemaining: 0, dayReviewRemaining: 0 }),
        LIMITS
      )
    ).toContain('output_cap:');
  });

  it('reports the state of both lanes when it blocks', () => {
    const reason = publishBudgetExhausted(
      state({ cyclePublishes: 3, cycleReviews: 3, dayPublishRemaining: 4, dayReviewRemaining: 2 }),
      LIMITS
    );

    expect(reason).toContain('publishes=3/3');
    expect(reason).toContain('reviews=3/3');
    expect(reason).toContain('day_publish_left=4');
    expect(reason).toContain('day_review_left=2');
  });
});

/**
 * The August 2026 outage: publishing and MD review shared one counter, so with
 * MAX_PUBLISHES_PER_CYCLE=1 the first event routed to review spent the cycle's
 * only slot and the pipeline went five days without attempting a single cast.
 */
describe('publishBudgetExhausted — review must not starve publishing', () => {
  const TIGHT: PublishBudgetLimits = {
    maxAgentCallsPerCycle: 8,
    maxPublishesPerCycle: 1,
    maxReviewsPerCycle: 1,
  };

  it('still allows a publish after the review lane is full', () => {
    // This is the exact production configuration that broke: one slot per
    // cycle, and a review routing had consumed it.
    expect(
      publishBudgetExhausted(state({ cycleReviews: 1, dayReviewRemaining: 0 }), TIGHT)
    ).toBeNull();
  });

  it('still allows a review after the publish lane is full', () => {
    expect(
      publishBudgetExhausted(state({ cyclePublishes: 1, dayPublishRemaining: 0 }), TIGHT)
    ).toBeNull();
  });

  it('blocks once the publish lane is full and the review lane is too', () => {
    expect(
      publishBudgetExhausted(state({ cyclePublishes: 1, cycleReviews: 1 }), TIGHT)
    ).toContain('output_cap:');
  });

  it('treats an exhausted day allowance as closing that lane', () => {
    // Publish lane closed by the rolling 24h count, review lane closed by the
    // cycle cap — nothing left either way.
    expect(
      publishBudgetExhausted(state({ dayPublishRemaining: 0, cycleReviews: 1 }), TIGHT)
    ).toContain('output_cap:');
  });

  it('a zero publish limit does not block reviews', () => {
    expect(
      publishBudgetExhausted(state(), {
        maxAgentCallsPerCycle: 8,
        maxPublishesPerCycle: 0,
        maxReviewsPerCycle: 3,
      })
    ).toBeNull();
  });

  it('zero on both lanes blocks everything', () => {
    expect(
      publishBudgetExhausted(state(), {
        maxAgentCallsPerCycle: 8,
        maxPublishesPerCycle: 0,
        maxReviewsPerCycle: 0,
      })
    ).toContain('output_cap:');
  });
});
