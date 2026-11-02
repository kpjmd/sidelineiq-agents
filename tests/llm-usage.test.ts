import { describe, it, expect, beforeEach } from 'vitest';
import { drainLlmUsageLines, recordLlmUsage } from '../src/utils/llm-usage.js';

describe('llm usage totals', () => {
  beforeEach(() => {
    drainLlmUsageLines('NFL');
    drainLlmUsageLines('NBA');
  });

  it('sums each route and separates cached from uncached tokens', () => {
    recordLlmUsage('NFL', 'classifier', {
      input_tokens: 100,
      cache_creation_input_tokens: 1900,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    });
    recordLlmUsage('NFL', 'classifier', {
      input_tokens: 110,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1900,
      output_tokens: 60,
    });
    recordLlmUsage('NFL', 'otm', { input_tokens: 500, output_tokens: 900 });

    expect(drainLlmUsageLines('NFL')).toEqual([
      '[Usage] NFL route=classifier calls=2 input=210 cache_write=1900 cache_read=1900 output=110',
      '[Usage] NFL route=otm calls=1 input=500 cache_write=0 cache_read=0 output=900',
    ]);
  });

  it('resets on drain, so a cycle never reports the previous one', () => {
    recordLlmUsage('NFL', 'otm', { input_tokens: 1 });
    drainLlmUsageLines('NFL');
    expect(drainLlmUsageLines('NFL')).toEqual([]);
  });

  it('keeps overlapping sports apart', () => {
    recordLlmUsage('NFL', 'classifier', { input_tokens: 1 });
    recordLlmUsage('NBA', 'classifier', { input_tokens: 2 });
    expect(drainLlmUsageLines('NBA')).toEqual([
      '[Usage] NBA route=classifier calls=1 input=2 cache_write=0 cache_read=0 output=0',
    ]);
    expect(drainLlmUsageLines('NFL')).toHaveLength(1);
  });

  it('counts a call whose response carried no usage', () => {
    recordLlmUsage('NFL', 'resolver_pass1', undefined);
    expect(drainLlmUsageLines('NFL')).toEqual([
      '[Usage] NFL route=resolver_pass1 calls=1 input=0 cache_write=0 cache_read=0 output=0',
    ]);
  });

  it('sums searches on the search pass, and shows zero when none ran', () => {
    recordLlmUsage('NFL', 'resolver_search', {
      input_tokens: 30000,
      output_tokens: 800,
      server_tool_use: { web_search_requests: 3 },
    });
    recordLlmUsage('NFL', 'resolver_search', {
      input_tokens: 5000,
      output_tokens: 100,
      server_tool_use: { web_search_requests: 1 },
    });
    recordLlmUsage('NBA', 'resolver_search', { input_tokens: 2000, server_tool_use: null });

    expect(drainLlmUsageLines('NFL')).toEqual([
      '[Usage] NFL route=resolver_search calls=2 input=35000 cache_write=0 cache_read=0 output=900 searches=4',
    ]);
    expect(drainLlmUsageLines('NBA')).toEqual([
      '[Usage] NBA route=resolver_search calls=1 input=2000 cache_write=0 cache_read=0 output=0 searches=0',
    ]);
  });
});
