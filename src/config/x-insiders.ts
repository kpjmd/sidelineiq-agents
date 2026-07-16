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
    // TODO: replace REPLACE_ME with each account's real numeric user ID
    // (resolve once via the X MCP user-lookup tool, then hardcode).
    { userId: 'REPLACE_ME', handle: 'AdamSchefter', displayName: 'Adam Schefter' },
    { userId: 'REPLACE_ME', handle: 'RapSheet', displayName: 'Ian Rapoport' },
    { userId: 'REPLACE_ME', handle: 'TomPelissero', displayName: 'Tom Pelissero' },
  ],
  NBA: [
    { userId: 'REPLACE_ME', handle: 'wojespn', displayName: 'Adrian Wojnarowski' },
    { userId: 'REPLACE_ME', handle: 'ShamsCharania', displayName: 'Shams Charania' },
  ],
};
