import { describe, it, expect } from 'vitest';
import { AGENT_TOOL } from '../src/agents/injury-intelligence/agent.js';
import { getMDReviewThreshold } from '../src/utils/publishing-pipeline.js';

/**
 * emit_injury_post asks for two different confidence numbers, and for months it
 * described only one of them. `return_to_play.confidence` was a bare
 * `{ type: 'number' }` with no description at all, and across 439 stored posts
 * it collapsed onto a single modal value (0.62, 20% of rows) — an unanchored
 * field converging on one number. In every August row the two confidences were
 * byte-identical, which is what a model does when it cannot tell two fields
 * apart.
 *
 * The post-level field, meanwhile, named a threshold: "Below 0.75 routes to MD
 * review." That was the only number the model was ever given, it was framed as
 * a penalty rather than a scale, and it disagreed with the enforced value
 * (0.70 in production) — so the mass of the distribution landed in the gap.
 */
const props = AGENT_TOOL.input_schema.properties as Record<string, any>;
const postConfidence = props.confidence;
const rtpConfidence = props.return_to_play.properties.confidence;

describe('emit_injury_post confidence fields', () => {
  it('describes both confidence fields', () => {
    // The RTP one had no description at all.
    expect(rtpConfidence.description).toBeTruthy();
    expect(postConfidence.description).toBeTruthy();
  });

  it('describes them differently', () => {
    // If these ever converge, so will the numbers the model emits.
    expect(rtpConfidence.description).not.toBe(postConfidence.description);
  });

  it('anchors the RTP confidence to the SKILL.md evidence tiers', () => {
    const d = rtpConfidence.description as string;
    for (const tier of ['T1', 'T2', 'T3', 'T4']) expect(d).toContain(tier);
  });

  it('tells the model the two fields are distinct judgements', () => {
    expect(postConfidence.description as string).toMatch(/DIFFERENT judgement|do not copy/i);
  });

  it('does not hard-code a review threshold in the prompt', () => {
    // The old text said "Below 0.75 routes to MD review" while the enforced
    // value was 0.70. Four sources already disagreed about this number
    // (agent.ts, .env.example, CLAUDE.md, TODO.md); the schema should not be a
    // fifth. State the consequence, never the number.
    expect(postConfidence.description as string).not.toMatch(/[Bb]elow \d*\.?\d+/);
    expect(postConfidence.description as string).toMatch(/review/i);
  });

  it('still requires both fields', () => {
    expect(AGENT_TOOL.input_schema.required).toContain('confidence');
    expect(AGENT_TOOL.input_schema.properties.return_to_play.required).toContain('confidence');
  });

  it('keeps the enforced threshold a valid probability', () => {
    // Guards the other half of the drift: whatever the env says, the gate must
    // stay in (0, 1] or the MD review routing silently changes meaning.
    const t = getMDReviewThreshold();
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(1);
  });
});
