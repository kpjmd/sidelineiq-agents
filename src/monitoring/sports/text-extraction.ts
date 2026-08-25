// ── Shared free-text → injury-event extraction helpers ──────────────
// Used by any source that parses unstructured text (news article titles/
// descriptions, insider tweets) rather than a structured feed like ESPN's
// athlete.displayName. Precision over recall: skip on ambiguity rather than
// guess, since a wrong athlete/team match is worse than a missed event.

// Stems take an explicit \w* suffix. A bare stem followed by \b can never
// match — \binjur\b requires a non-word character after "injur", so it fails on
// "injury", "injured" and "injuries", i.e. on every word it was written to
// catch. The same held for fractur/concuss/sidelin/ruptur. Verified against the
// live ESPN soccer feed: "Man United being 'careful' with Mason Mount after
// injury scare" matched nothing before this fix.
export const INJURY_KEYWORD_RE =
  /\b(injur\w*|hurt|torn|tear\w*|sprain\w*|fractur\w*|concuss\w*|sidelin\w*|ruptur\w*|out\s+for|ACL|MCL|hamstring|knee|ankle|shoulder|achilles|surger\w*|strain\w*)\b/i;

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

/**
 * What extractAthleteName needs in order to tell a person from a club.
 *
 * Two sets, because they answer different questions and a token can be in one
 * without being in the other. `blocklist` is "this can never be a FIRST name"
 * and is absolute. `teamTokens` is only "this word appears somewhere in a
 * team's name", which on its own proves nothing — "Dallas", "Buffalo" and
 * "Jordan" are team tokens and also real first names — so it is consulted only
 * for the pair rule in extractAthleteName.
 */
export interface NameFilter {
  blocklist: Set<string>;
  teamTokens: Set<string>;
}

/**
 * Build both sets for one sport.
 *
 * The three inputs are NOT interchangeable, and the split is the whole point:
 *
 * - `teamNames` — nicknames ('Browns', 'Trail Blazers'). Blocked as first names
 *   AND tokenized into `teamTokens`. Multi-word entries go into `blocklist`
 *   verbatim, exactly as before, where they are inert: a two-word string can
 *   never match a single captured token. Tokenizing them is what fixed
 *   "Portland Trail".
 * - `locations` — the city/place half of a team's name ('Portland', 'Cleveland',
 *   'Green', 'Bay'). Tokenized into `teamTokens` ONLY, and deliberately **never**
 *   blocklisted: 'Dallas' and 'Orlando' are places and also real athletes' first
 *   names, so blocking them outright would drop Dallas Goedert and Orlando
 *   Robinson. They earn a skip only in combination — see the pair rule below.
 * - `extraBlocklist` — the sport's own first-name blocks: the league label, and
 *   for PREMIER_LEAGUE a hand-tokenized club list that PL_TEAM_NAMES cannot
 *   supply (relegated clubs, plus the European sides that fill transfer
 *   coverage).
 */
export function buildNameFilter(spec: {
  teamNames: readonly string[];
  locations?: readonly string[];
  extraBlocklist?: readonly string[];
}): NameFilter {
  const { teamNames, locations = [], extraBlocklist = [] } = spec;
  const tokenize = (names: readonly string[]) =>
    names.flatMap((n) => n.split(/\s+/)).filter(Boolean);
  return {
    blocklist: new Set([...COMMON_BLOCKLIST_WORDS, ...teamNames, ...extraBlocklist]),
    teamTokens: new Set([
      ...tokenize(teamNames),
      ...tokenize(locations),
      ...tokenize(extraBlocklist),
    ]),
  };
}

/**
 * A position or role abbreviation standing where a surname would: "Seattle WR
 * Jake Bobo", "#Raiders RB Ashton Jeanty". NAME_RE's second group accepts any
 * capitalized run, so these parse as surnames. No real surname is two or three
 * capitals with no lowercase — the stylized names that come close ("DK
 * Metcalf") are FIRST names, and NAME_RE's first group already rejects those.
 */
const ABBREVIATION_RE = /^[A-Z]{2,3}$/;

export function extractAthleteName(
  title: string,
  description: string,
  filter: NameFilter,
): string | null {
  for (const text of [title, description]) {
    if (!text) continue;
    const matches = [...text.matchAll(NAME_RE)];
    for (const match of matches) {
      const first = match[1];
      if (filter.blocklist.has(first)) continue;
      // Strip trailing possessive 's (e.g. "Kelly's" → "Kelly")
      const last = match[2].replace(/'s$/, '');
      if (last.length < 2) continue;
      // Both halves are team-name tokens, so the PAIR is a club and not a
      // person: "Portland Trail", "Cleveland Browns", "Green Bay". Testing the
      // pair rather than `first` alone is what keeps a real athlete whose first
      // name is a city ("Dallas Goedert") extractable — a flat city blocklist
      // would drop him.
      if (filter.teamTokens.has(first) && filter.teamTokens.has(last)) continue;
      if (ABBREVIATION_RE.test(last)) continue;
      return `${first} ${last}`;
    }
  }
  return null;
}

/**
 * An ESPN news `categories[]` entry, narrowed to what athlete resolution reads.
 *
 * THE FIELD IS `description`, NOT `displayName`. Verified live against the NFL,
 * soccer/eng.1 and mma/ufc news feeds on 2026-08-15 — all three return
 * `{type:'athlete', description:'Conor McGregor', athleteId:3022677,
 * athlete:{id, description, links}}`. `displayName` does not exist anywhere in
 * a news category; it is the *roster* endpoint's field name. Reading it yields
 * undefined on every article, which is why espn-ufc.ts (tag-only, no text
 * fallback) emitted zero events for its entire life, and why the comment in
 * espn-premier-league-news.ts claimed soccer articles don't tag athletes. They
 * do. `displayName` is still read as a fallback so a shape change back — or a
 * hand-written test fixture — keeps working.
 */
export interface ESPNAthleteCategory {
  type?: string;
  description?: string;
  /** ESPN's athlete id, carried on the category itself. Verified present on
   *  every athlete tag of the live NFL, soccer/eng.1 and mma/ufc news feeds
   *  (2026-08-16). `athlete.id` carries the same value. */
  athleteId?: number | string;
  athlete?: { id?: number | string; description?: string; displayName?: string };
}

/** A tagged athlete's name plus, when ESPN supplies one, their athlete id. */
export interface TaggedAthleteRef {
  name: string;
  espn_athlete_id?: string;
}

function categoryAthleteName(c: ESPNAthleteCategory): string | null {
  if (c.type && c.type !== 'athlete') return null;
  const name = c.athlete?.description ?? c.athlete?.displayName ?? (c.athlete ? c.description : null);
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function categoryAthleteId(c: ESPNAthleteCategory): string | undefined {
  const raw = c.athleteId ?? c.athlete?.id;
  if (raw === undefined || raw === null) return undefined;
  const id = String(raw).trim();
  return id ? id : undefined;
}

/** Index of `needle` as a whole word in `haystack`, or -1. */
function wordIndex(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\b${escaped}\\b`, 'i').exec(haystack);
  return m ? m.index : -1;
}

/**
 * The one athlete an article is *about*, from ESPN's own tags — or null when
 * the tags don't identify a single subject.
 *
 * Taking `categories[0]` is wrong on the articles that matter. ESPN tags every
 * fighter it mentions, so a UFC results round-up or a "fights we want to see"
 * column carries 14-28 athlete tags, and the first is rarely the injured one.
 * The headline is the disambiguator: an article's subject is named in it, and
 * named first. So among the tagged athletes, prefer those the headline
 * mentions, earliest mention wins ("Conor McGregor suffers knee injury in loss
 * to Max Holloway" → McGregor, not Holloway).
 *
 * Skip-on-ambiguity, per this file's precision-over-recall contract: no tagged
 * athlete in the headline and more than one tag means we cannot tell, so the
 * caller falls back to text extraction or drops the event.
 */
export function resolveTaggedAthleteRef(
  categories: ESPNAthleteCategory[] | undefined,
  headline: string,
): TaggedAthleteRef | null {
  // Keyed by name, so two ESPN records for one person (the feed carries ghost
  // duplicates under misspelled names — "Islam Makhackev" alongside Makhachev)
  // stay separate entries and are disambiguated by the headline like anyone
  // else. Where the SAME name appears twice, the first id wins; picking between
  // two ids for one name is exactly the guess this function refuses to make.
  const ids = new Map<string, string | undefined>();
  const names: string[] = [];
  for (const c of categories ?? []) {
    const name = categoryAthleteName(c);
    if (name && !names.includes(name)) {
      names.push(name);
      ids.set(name, categoryAthleteId(c));
    }
  }
  const ref = (name: string | null): TaggedAthleteRef | null => {
    if (!name) return null;
    const id = ids.get(name);
    return id ? { name, espn_athlete_id: id } : { name };
  };

  if (names.length === 0) return null;
  if (names.length === 1) return ref(names[0]);

  let best: string | null = null;
  let bestIndex = Infinity;
  let tied = false;
  for (const name of names) {
    const surname = name.split(/\s+/).pop() ?? name;
    const full = wordIndex(headline, name);
    const partial = wordIndex(headline, surname);
    const candidates = [full, partial].filter((i) => i >= 0);
    if (candidates.length === 0) continue;
    const index = Math.min(...candidates);
    if (index < bestIndex) {
      bestIndex = index;
      best = name;
      tied = false;
    } else if (index === bestIndex && name !== best) {
      // Two tagged athletes matched at the same offset — most likely a shared
      // surname. Guessing between them is the mistake this function exists to
      // avoid.
      tied = true;
    }
  }
  return tied ? null : ref(best);
}

/** Name-only form. Callers that have nowhere to put an id use this. */
export function resolveTaggedAthlete(
  categories: ESPNAthleteCategory[] | undefined,
  headline: string,
): string | null {
  return resolveTaggedAthleteRef(categories, headline)?.name ?? null;
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
