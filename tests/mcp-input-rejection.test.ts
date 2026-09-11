import { describe, it, expect } from 'vitest';
import { inputRejectionMessage } from '../src/utils/mcp-client-manager.js';
import recorded from './fixtures/mcp-error-responses.json' with { type: 'json' };

/**
 * A schema rejection is a VALUE (`isError: true`), not a throw, and several
 * callers never check isError. While the server stripped unknown keys that cost
 * one field; once it rejects them it costs the whole write, silently.
 * callTool logs `[MCP] INPUT REJECTED` for every caller at once — this pins the
 * detector against RECORDED production payloads, not hand-built ones.
 */
describe('inputRejectionMessage', () => {
  it('recognises the server’s own input-validation failure', () => {
    const msg = inputRejectionMessage(recorded.rejected);
    expect(msg).toContain('Input validation error');
    expect(msg).toContain('web_list_posts');
  });

  it('does not fire on a handler-level error (a missing post is not a bad call)', () => {
    expect(recorded.toolError.isError).toBe(true);
    expect(inputRejectionMessage(recorded.toolError)).toBeNull();
  });

  it('does not fire on success or on garbage', () => {
    expect(inputRejectionMessage({ content: [{ type: 'text', text: '{"ok":true}' }] })).toBeNull();
    expect(inputRejectionMessage(null)).toBeNull();
    expect(inputRejectionMessage({ isError: true })).toBeNull();
  });
});
