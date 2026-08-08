import { describe, it, expect } from 'vitest';
import {
  publishBudgetExhausted,
  type PublishBudgetState,
  type PublishBudgetLimits,
} from '../src/monitoring/poller.js';

const LIMITS: PublishBudgetLimits = { maxAgentCallsPerCycle: 8, maxPublishesPerCycle: 3 };

function state(overrides: Partial<PublishBudgetState> = {}): PublishBudgetState {
  return { agentCalls: 0, cyclePublishes: 0, dayRemaining: 10, ...overrides };
}

describe('publishBudgetExhausted', () => {
  it('allows work when nothing is spent', () => {
    expect(publishBudgetExhausted(state(), LIMITS)).toBeNull();
  });

  it('allows the last slot under each cap', () => {
    expect(publishBudgetExhausted(state({ agentCalls: 7 }), LIMITS)).toBeNull();
    expect(publishBudgetExhausted(state({ cyclePublishes: 2 }), LIMITS)).toBeNull();
    expect(publishBudgetExhausted(state({ dayRemaining: 1 }), LIMITS)).toBeNull();
  });

  it('blocks on the agent-call cap before any Sonnet spend', () => {
    expect(publishBudgetExhausted(state({ agentCalls: 8 }), LIMITS)).toBe('agent_call_cap:8/8');
  });

  it('blocks on the per-cycle publish cap', () => {
    expect(publishBudgetExhausted(state({ cyclePublishes: 3 }), LIMITS)).toBe(
      'cycle_publish_cap:3/3',
    );
  });

  it('blocks on the rolling daily cap', () => {
    expect(publishBudgetExhausted(state({ dayRemaining: 0 }), LIMITS)).toBe('day_publish_cap');
  });

  // The day count comes from an MCP call that can fail; Infinity is the
  // fail-open sentinel. The per-cycle caps must still bound the damage.
  it('fails open on the day cap when the count is unknown', () => {
    expect(publishBudgetExhausted(state({ dayRemaining: Infinity }), LIMITS)).toBeNull();
    expect(
      publishBudgetExhausted(state({ dayRemaining: Infinity, cyclePublishes: 3 }), LIMITS),
    ).toBe('cycle_publish_cap:3/3');
  });

  it('reports the agent-call cap first — it is the most expensive to overrun', () => {
    expect(
      publishBudgetExhausted(state({ agentCalls: 8, cyclePublishes: 3, dayRemaining: 0 }), LIMITS),
    ).toBe('agent_call_cap:8/8');
  });

  it('a zero limit blocks everything', () => {
    expect(
      publishBudgetExhausted(state(), { maxAgentCallsPerCycle: 8, maxPublishesPerCycle: 0 }),
    ).toBe('cycle_publish_cap:0/0');
  });
});
