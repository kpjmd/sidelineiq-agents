import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

vi.mock('../src/config/x-insiders.js', () => ({
  X_INSIDER_ALLOWLIST: {
    NFL: [
      { userId: '111', handle: 'InsiderOne', displayName: 'Insider One' },
      { userId: '222', handle: 'InsiderTwo', displayName: 'Insider Two' },
    ],
    NBA: [],
  },
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { XInsiderNFLSource } from '../src/monitoring/sports/x-insider-nfl.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

function timelineEnvelope(tweets: unknown[]) {
  return { content: [{ type: 'text', text: JSON.stringify({ data: tweets }) }] };
}

describe('XInsiderNFLSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
    delete process.env.X_INSIDER_SOURCE_ENABLED;
    delete process.env.X_INSIDER_MAX_RESULTS_PER_USER;
    delete process.env.X_INSIDER_POLL_EVERY_N_CYCLES;
  });

  it('maps an injury-keyword tweet to a RawInjuryEvent with source_name traceable to the insider', async () => {
    mockCallTool.mockImplementation(async (_server, _tool, params) => {
      if (params.id === '111') {
        return timelineEnvelope([
          {
            id: 'tweet-1',
            text: 'Sources: Patrick Mahomes suffers high ankle sprain vs Bills',
            created_at: new Date().toISOString(),
            author_id: '111',
          },
        ]);
      }
      return timelineEnvelope([]);
    });

    const source = new XInsiderNFLSource();
    const events = await source.fetchLatestEvents();

    expect(events).toHaveLength(1);
    expect(events[0].athlete_name).toBe('Patrick Mahomes');
    expect(events[0].source_name).toBe('X:InsiderOne');
    expect(events[0].source_url).toBe('https://x.com/InsiderOne/status/tweet-1');
  });

  it('filters out tweets with no injury keyword', async () => {
    mockCallTool.mockResolvedValue(
      timelineEnvelope([
        { id: 't1', text: 'Patrick Mahomes threw for 300 yards tonight', created_at: new Date().toISOString(), author_id: '111' },
      ])
    );

    const source = new XInsiderNFLSource();
    const events = await source.fetchLatestEvents();
    expect(events).toHaveLength(0);
  });

  it('drops a tweet whose author_id does not match the allowlisted userId, even if returned', async () => {
    mockCallTool.mockResolvedValue(
      timelineEnvelope([
        {
          id: 't1',
          text: 'Patrick Mahomes out with torn ACL',
          created_at: new Date().toISOString(),
          author_id: '999', // mismatched — spoofing/echo scenario
        },
      ])
    );

    const source = new XInsiderNFLSource();
    const events = await source.fetchLatestEvents();
    expect(events).toHaveLength(0);
  });

  it('never throws when callTool rejects — returns [] for that insider', async () => {
    mockCallTool.mockRejectedValue(new Error('network error'));

    const source = new XInsiderNFLSource();
    await expect(source.fetchLatestEvents()).resolves.toEqual([]);
  });

  it('retries on 429 then gives up cleanly without throwing', async () => {
    vi.useFakeTimers();
    try {
      mockCallTool.mockImplementation(async (_server, _tool, params) => {
        if (params.id === '111') throw new Error('429 Too Many Requests');
        return timelineEnvelope([]);
      });

      const source = new XInsiderNFLSource();
      const eventsPromise = source.fetchLatestEvents();
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(events).toEqual([]);
      // 3 attempts for insider 111, 1 attempt for insider 222 (no rate limit)
      const calledForInsiderOne = mockCallTool.mock.calls.filter((c) => (c[2] as { id: string }).id === '111');
      expect(calledForInsiderOne.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it('skips entirely when x_api MCP server is unavailable', async () => {
    mockIsServerAvailable.mockReturnValue(false);
    const source = new XInsiderNFLSource();
    const events = await source.fetchLatestEvents();
    expect(events).toEqual([]);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('skips entirely when X_INSIDER_SOURCE_ENABLED=false', async () => {
    process.env.X_INSIDER_SOURCE_ENABLED = 'false';
    const source = new XInsiderNFLSource();
    const events = await source.fetchLatestEvents();
    expect(events).toEqual([]);
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
