/**
 * Curated allowlist of sports-insider X accounts, keyed by sport.
 *
 * Identity is the numeric `userId` ONLY. Handle-spoofing of verified-looking
 * accounts is the documented attack this allowlist exists to defeat, so
 * lookups must never resolve by @handle at runtime — that would reintroduce
 * the exact vulnerability this file is meant to close.
 *
 * Resolve each handle → numeric ID ONCE via the X MCP user-lookup tool during
 * setup, then hardcode the ID here. Treat edits to this file with the same
 * review scrutiny as any other auth-adjacent config (it's an allowlist, not
 * a casual data update).
 */

export interface XInsider {
  /** Stable X numeric user ID — the only identity check performed. */
  userId: string;
  /** Current @handle — logging/traceability only, never used for lookup or auth. */
  handle: string;
  displayName: string;
}

export const X_INSIDER_ALLOWLIST: Record<'NFL' | 'NBA', XInsider[]> = {
  NFL: [
    // Resolved via the X MCP get_users_by_usernames tool.
    { userId: '51263592', handle: 'AdamSchefter', displayName: 'Adam Schefter' },
    { userId: '16403943', handle: 'RapSheet', displayName: 'Ian Rapoport' },
    { userId: '36089053', handle: 'TomPelissero', displayName: 'Tom Pelissero' },
  ],
  NBA: [
    { userId: '50323173', handle: 'wojespn', displayName: 'Adrian Wojnarowski' },
    { userId: '178580925', handle: 'ShamsCharania', displayName: 'Shams Charania' },
  ],
};
