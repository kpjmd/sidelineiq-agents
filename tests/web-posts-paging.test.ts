import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { listAllPosts, parseListPostsResponse } from '../src/utils/web-posts.js';

const mockCallTool = vi.mocked(callTool);

const NOW = Date.parse('2026-08-17T12:00:00Z');
const HOUR = 60 * 60 * 1000;

interface Row {
  post_id: string;
  created_at?: string;
}

function row(id: string, ageHours = 1): Row {
  return { post_id: id, created_at: new Date(NOW - ageHours * HOUR).toISOString() };
}

/** The MCP text envelope the web server actually returns. */
function page(posts: Row[], opts: { total?: number; hasMore?: boolean; nextOffset?: number | null } = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          posts,
          total: opts.total ?? posts.length,
          has_more: opts.hasMore ?? false,
          next_offset: opts.nextOffset ?? null,
        }),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseListPostsResponse', () => {
  it('unwraps the envelope around {posts}', () => {
    expect(parseListPostsResponse<Row>(page([row('a'), row('b')]))).toHaveLength(2);
  });

  it('unwraps an envelope around a bare array', () => {
    const raw = { content: [{ type: 'text', text: JSON.stringify([row('a')]) }] };
    expect(parseListPostsResponse<Row>(raw)).toHaveLength(1);
  });

  it('accepts an already-unwrapped array', () => {
    expect(parseListPostsResponse<Row>([row('a')])).toHaveLength(1);
  });

  it('returns [] on an error envelope, unparseable text, or nothing', () => {
    expect(parseListPostsResponse({ isError: true, content: [{ text: 'boom' }] })).toEqual([]);
    expect(parseListPostsResponse({ content: [{ text: 'not json' }] })).toEqual([]);
    expect(parseListPostsResponse(null)).toEqual([]);
  });
});

describe('listAllPosts', () => {
  it('walks every page until the server runs out', async () => {
    mockCallTool
      .mockResolvedValueOnce(page([row('a')], { total: 3, hasMore: true, nextOffset: 50 }))
      .mockResolvedValueOnce(page([row('b')], { total: 3, hasMore: true, nextOffset: 100 }))
      .mockResolvedValueOnce(page([row('c')], { total: 3 }));

    const result = await listAllPosts<Row>();

    expect(result.posts.map((p) => p.post_id)).toEqual(['a', 'b', 'c']);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('requests the server max page size and advances the offset', async () => {
    mockCallTool
      .mockResolvedValueOnce(page([row('a')], { total: 2, hasMore: true, nextOffset: 50 }))
      .mockResolvedValueOnce(page([row('b')], { total: 2 }));

    await listAllPosts<Row>({ status: 'PUBLISHED' });

    expect(mockCallTool).toHaveBeenNthCalledWith(1, 'web', 'web_list_posts', {
      status: 'PUBLISHED',
      limit: 50,
      offset: 0,
    });
    expect(mockCallTool).toHaveBeenNthCalledWith(2, 'web', 'web_list_posts', {
      status: 'PUBLISHED',
      limit: 50,
      offset: 50,
    });
  });

  it('stops at the window edge without fetching the next page', async () => {
    mockCallTool.mockResolvedValue(
      page([row('recent', 1), row('ancient', 100)], { total: 500, hasMore: true, nextOffset: 50 }),
    );

    const result = await listAllPosts<Row>({}, { stopWhenOlderThan: NOW - 24 * HOUR });

    expect(result.posts.map((p) => p.post_id)).toEqual(['recent']);
    expect(result.truncated).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('keeps rows with no created_at rather than treating them as out of window', async () => {
    mockCallTool.mockResolvedValue(page([{ post_id: 'undated' }]));

    const result = await listAllPosts<Row>({}, { stopWhenOlderThan: NOW - 24 * HOUR });

    expect(result.posts.map((p) => p.post_id)).toEqual(['undated']);
  });

  it('reports truncated when the page cap ends the scan', async () => {
    mockCallTool.mockResolvedValue(page([row('a')], { total: 500, hasMore: true, nextOffset: 50 }));

    const result = await listAllPosts<Row>({}, { maxPages: 2 });

    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(true);
    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  it('terminates instead of spinning when the offset stops advancing', async () => {
    // A server bug here would otherwise loop forever inside a five-minute cron.
    mockCallTool.mockResolvedValue(page([row('a')], { total: 500, hasMore: true, nextOffset: 0 }));

    const result = await listAllPosts<Row>();

    expect(result.truncated).toBe(true);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('throws on a mid-scan failure instead of returning a short list', async () => {
    // Returning what it had so far would look identical to "nothing is missing".
    mockCallTool
      .mockResolvedValueOnce(page([row('a')], { total: 2, hasMore: true, nextOffset: 50 }))
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'connection refused' }] });

    await expect(listAllPosts<Row>()).rejects.toThrow(/offset 50/);
  });

  it('throws when the first page is unreadable', async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });

    await expect(listAllPosts<Row>()).rejects.toThrow(/unreadable page/);
  });
});
