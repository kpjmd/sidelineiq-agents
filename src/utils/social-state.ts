/**
 * Reading `web_social_state` rows back out of the web MCP server.
 *
 * `web_get_social_state` does NOT return the stored string. It returns an
 * ENVELOPE — `{"key": "...", "value": "<the stored string>"}` — as its MCP text,
 * with `value: null` when the key has never been written. The stored string is
 * one JSON.parse deeper than it looks.
 *
 * This module exists because two callers hand-rolled that read and only one got
 * it right. `mention-monitor-loop.ts` unwrapped `.value`; `defer-queue.ts`
 * parsed the envelope and then looked for its own fields directly ON the
 * envelope, where they never are. That silently returned an empty queue on
 * every load from the day it shipped: corroboration never fired, TTL expiry
 * never fired, and each new deferral overwrote the previous one because the
 * save path appends to whatever the load returned. `defer_q=0` reported the
 * queue as empty rather than broken.
 *
 * It survived because the tests fed the BARE state as MCP text instead of the
 * envelope, so the fixtures shared the code's blind spot — the same failure the
 * record-your-fixtures rule exists to prevent. See
 * tests/fixtures/social-state-responses.json, recorded from the live server.
 */

/** What a read of one social-state key produced. */
export type SocialStateRead =
  /** The key exists and held this string. */
  | { status: 'value'; value: string }
  /** The key has never been written. Genuinely empty, not a failure. */
  | { status: 'absent' }
  /** The store could not be read, or answered in a shape we do not know.
   *  Callers must NOT treat this as empty — see the note on each call site. */
  | { status: 'unreadable'; reason: string };

interface MCPTextResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Unwrap a `web_get_social_state` response down to the stored string.
 *
 * Fails to `unreadable` rather than to `absent` on anything unrecognized. The
 * two are not interchangeable: "nothing stored" is a normal state that callers
 * build on, while "we could not read it" must stop them from writing over data
 * they never saw. Collapsing the second into the first is the bug this module
 * was written to fix.
 */
export function readSocialState(raw: unknown): SocialStateRead {
  if (!raw || typeof raw !== 'object') {
    return { status: 'unreadable', reason: 'no response' };
  }
  const wrapped = raw as MCPTextResponse;
  if (wrapped.isError) {
    // Tool-level failures resolve as a VALUE, not a throw, so a try/catch
    // around callTool does not see them.
    return { status: 'unreadable', reason: 'tool returned isError' };
  }
  const text = wrapped.content?.[0]?.text;
  if (!text) return { status: 'unreadable', reason: 'empty response text' };

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { status: 'unreadable', reason: 'response text is not JSON' };
  }
  if (!envelope || typeof envelope !== 'object') {
    return { status: 'unreadable', reason: 'response is not an object' };
  }

  const value = (envelope as { value?: unknown }).value;
  if (value === null || value === undefined) return { status: 'absent' };
  if (typeof value !== 'string') {
    return { status: 'unreadable', reason: `value is ${typeof value}, expected string` };
  }
  return { status: 'value', value };
}

/**
 * The stored string, or null. The shape mention-monitor-loop.ts wants, where
 * "absent" and "unreadable" lead to the same behaviour (start from no cursor)
 * and nothing is overwritten on the strength of the answer.
 *
 * Do NOT use this where a caller writes back what it read — use readSocialState
 * and refuse to write on `unreadable`.
 */
export function readSocialStateValue(raw: unknown): string | null {
  const read = readSocialState(raw);
  return read.status === 'value' ? read.value : null;
}
