// ── Shared free-text → injury-event extraction helpers ──────────────
// Used by any source that parses unstructured text (news article titles/
// descriptions, insider tweets) rather than a structured feed like ESPN's
// athlete.displayName. Precision over recall: skip on ambiguity rather than
// guess, since a wrong athlete/team match is worse than a missed event.

export const INJURY_KEYWORD_RE =
  /\b(injur|hurt|torn|sprain|fractur|concuss|sidelin|out\s+for|ACL|MCL|hamstring|knee|ankle|shoulder|achilles|surgery|strain)\b/i;

// Regex: two capitalized words ("FirstName LastName"). Requires first name
// to have 3+ chars starting with uppercase then lowercase.
//
// Known miss rate: this will NOT match all-caps stylized names ("DK Metcalf",
// "DJ Moore", "TJ Watt") or apostrophe-prefix names ("Za'Darius Smith").
// Those athletes still arrive via ESPN's structured athlete.displayName feed.
// Skip-on-failure is the correct behavior — precision over recall.
export const NAME_RE = /\b([A-Z][a-z]{2,})\s+([A-Z][a-zA-Z'.-]+)\b/g;

// Words that look like a first name but aren't — day names, league labels,
// and common headline words shared across sports. Sport-specific team names
// and league labels (e.g. 'NFL', 'National') are added by each caller.
export const COMMON_BLOCKLIST_WORDS = [
  'National', 'Monday', 'Sunday', 'Thursday', 'Saturday', 'Tuesday', 'Wednesday', 'Friday',
  'Fantasy', 'Super', 'Injury', 'Report', 'Breaking', 'Update', 'Watch', 'Week',
  'Sources', 'League', 'Season', 'Coach', 'Pro', 'Wild', 'Hall',
  'The', 'This', 'That', 'These', 'Those', 'Former', 'After', 'Every', 'Their',
  'His', 'Her', 'New', 'First', 'Last', 'Best', 'Top', 'Big', 'Round',
  'College', 'Football', 'Sports', 'Game', 'Reveals', 'Here',
];

/** Combines COMMON_BLOCKLIST_WORDS with sport-specific extras (team names, league label). */
export function buildBlocklist(extra: string[]): Set<string> {
  return new Set([...COMMON_BLOCKLIST_WORDS, ...extra]);
}

export function extractAthleteName(
  title: string,
  description: string,
  blocklist: Set<string>
): string | null {
  for (const text of [title, description]) {
    if (!text) continue;
    const matches = [...text.matchAll(NAME_RE)];
    for (const match of matches) {
      const first = match[1];
      if (blocklist.has(first)) continue;
      // Strip trailing possessive 's (e.g. "Kelly's" → "Kelly")
      const last = match[2].replace(/'s$/, '');
      if (last.length < 2) continue;
      return `${first} ${last}`;
    }
  }
  return null;
}

export function extractTeam(text: string, teamNames: string[]): string {
  for (const team of teamNames) {
    if (new RegExp(`\\b${team}\\b`).test(text)) return team;
  }
  return 'Unknown';
}

export function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getMaxEventAgeMs(): number {
  const days = parseInt(process.env.MAX_EVENT_AGE_DAYS ?? '', 10);
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  return d * 24 * 60 * 60 * 1000;
}
