# SidelineIQ Agents — Claude Code Guide

## What This Repository Is

This is the agent backend for SidelineIQ — an autonomous AI sports
injury intelligence platform. It contains the Injury Intelligence Agent
that monitors sports injury news, generates clinical breakdowns, and
publishes content across platforms via MCP servers.

SidelineIQ is an independent platform from OrthoIQ. They share a
founder (board-certified orthopedic surgeon) but are separate codebases,
separate Railway deployments, and separate brands.

## Platform Overview

SidelineIQ monitors injury news across NFL, NBA, Premier League, and
UFC/MMA. For each injury event it:
1. Classifies the injury type and severity
2. Retrieves relevant PubMed research
3. Generates a clinical breakdown with return-to-play probability
4. Publishes simultaneously to Farcaster, X/Twitter, and the web
   database via MCP servers

## Tech Stack

- Runtime: Node.js 18+
- Framework: Express.js
- Language: TypeScript (ES modules)
- AI: Anthropic Claude API (claude-sonnet-4-20250514 for agent calls,
  claude-haiku for classification tasks)
- Database: Neon Serverless PostgreSQL
- Database pattern: Tagged template literals ONLY — no ORM
- Deployment: Railway
- MCP Client: @modelcontextprotocol/sdk

## Repository Structure

src/
├── index.ts                    # Express server entry point
├── types.ts                    # Shared types and interfaces
├── agents/
│   └── injury-intelligence/
│       ├── agent.ts            # Core Injury Intelligence Agent
│       ├── classifier.ts       # Injury type/severity classifier
│       └── rtp-estimator.ts    # Return-to-play probability engine
├── research/
│   └── research-agent.ts      # PubMed research (transplanted from
│                               # orthoiq-agents, adapted for sports)
├── monitoring/
│   ├── poller.ts               # Sports data polling loop (see POLL_INTERVAL_MS)
│   ├── deduplicator.ts         # Prevents duplicate injury coverage
│   └── sports/
│       ├── nfl.ts              # NFL data source handlers
│       ├── nba.ts              # NBA data source handlers
│       ├── premier-league.ts   # Premier League handlers
│       ├── ufc.ts              # UFC/MMA news handler
│       └── espn-ufc-scoreboard.ts # Shared MMA scoreboard fetch
│                                   # (tiers + fighter roster)
└── utils/
    ├── mcp-client-manager.ts   # Connects to sidelineiq-mcp-servers
    ├── content-formatter.ts    # Formats content per platform
    ├── publishing-pipeline.ts  # Orchestrates full publish flow
    └── skill-loader.ts         # Loads SKILL.md + reference files at runtime

skills/
├── SKILL.md                    # Core OTM taxonomy and RTP framework (physician-reviewed)
└── references/
    ├── rtp-probability-tables.md
    ├── nfl-injuries.md
    ├── nba-injuries.md
    ├── premier-league-injuries.md
    ├── ufc-injuries.md
    └── content-templates.md

## Critical Conventions

### Never Do These
- Never use an ORM
- Never use plain JavaScript — this repo uses TypeScript with ES modules
- Never call Farcaster, Twitter, or database directly —
  always go through MCP servers via mcp-client-manager
- Never publish without running deduplication check first
- Never publish clinical content with confidence below
  MD_REVIEW_CONFIDENCE_THRESHOLD without routing to review queue

### Always Do These
- Sports data polling cadence is `POLL_INTERVAL_MS`, not a fixed interval.
  Production runs **6 hours** (21600000) deliberately — to prevent spam posting
  and to keep polling costs down. The code default is 15 minutes; do not treat
  that as the real cadence, and remember it when reading anything time-based
  (a "next cycle" retry is six hours away, not fifteen minutes).
- All injury posts go through publishing-pipeline.js —
  never publish ad hoc
- All errors logged with sport, athlete, and timestamp context
- Deduplication check before every publish
- MD review routing when confidence < threshold OR severity is SEVERE

### Content Types
- BREAKING — injury just reported, publish immediately
- TRACKING — recovery update on existing injury
- DEEP_DIVE — educational deep dive on injury type, scheduled
- CONFLICT_FLAG — conflicting reports from multiple sources on the same injury

## Launch

**Launched: April 20, 2026**

- Autonomous polling live (NFL + NBA; launched at 15-minute intervals, since
  moved to 6 hours — see `POLL_INTERVAL_MS` above)
- Inaugural post: Moses Moody patellar tendon rupture DEEP_DIVE
  published to Farcaster + X/Twitter + web
- NewsAPI wired as secondary NFL data source (NFL-only at launch)
- MD review queue active

### Sports Coverage (Launch Order)
1. NFL ✅ active (ESPN + NewsAPI + X insiders)
2. NBA ✅ active (ESPN only)
3. PREMIER_LEAGUE ✅ polling on (ESPN news; the structured
   soccer/eng.1/injuries feed is empty upstream)
4. UFC — entity backing built; `POLL_UFC` still off pending the
   ship-gate run (`src/scripts/ufc-entity-dryrun.ts`)

### Rostered vs Individual Sports
Three predicates in `roster-sync.ts` say what used to be one
`sport !== 'UFC'` test. They are not interchangeable:
- `hasRosterProvider(sport)` — will an athlete ever resolve to a
  player row, and therefore can an injury_entity form. TRUE for all
  four sports now: UFC fighters come from an `AthleteListProvider`
  reading ESPN's MMA scoreboard rather than from teams.
- `isTeamSport(sport)` — do athletes belong to a team at all. FALSE
  for UFC. Every team-comparison check keys on this; a fighter
  having no team is the sport's structure, not a gap in our data.
- `registersAthletesOnSight(sport)` — may a player row be minted
  from one article's ESPN athlete tag. TRUE only for UFC, whose
  card window is inherently incomplete. Requires the ESPN id —
  never a bare name, which would invent players from misspellings.

### The Update Signal

`RawInjuryEvent.is_update` is a TRI-STATE and the third value matters:
`undefined` means **the source cannot answer the question** — a larger set than
"has no status field". `resolveUpdateSignal()` in poller.ts falls back to the
classifier's `is_new` exactly there. Without the fallback a sport is silenced
for the whole 21-day entity window after its first post about an injury.

Two source classes leave it `undefined`, for different reasons:
- **Every news source** — no status field at all.
- **ESPN's structured injuries feed, for every row that is not a day-to-day
  designation.** This one used to emit a confident `false`, and that was a
  category error: ESPN's `status` is a STATE, not a DELTA. There is no change
  indicator anywhere in the payload. A transition TO "Out" — the most
  newsworthy transition in the sport — read as "not an update", and a source
  `false` is final, so it also blocked the fallback built for this case. Across
  two NFL cycles in Aug 2026 every one of the six events that reached PROCESS
  died at `entity_match_skip update_signal=source`, and nothing ever reached
  OTM.

So `inferIsUpdate` returns `true` ONLY for the day-to-day family
(`day-to-day|questionable|probable|doubtful`), whose designations genuinely are
a live availability question, and `undefined` for everything else — including
`Active` and `Out`. **`false` is now unreachable from this feed**, which is the
honest answer: no ESPN injuries status supports the claim "this report is not a
change".

`Active` gets the same treatment as `Out`, and the intuition that they should
differ is the same category error one layer down: they sit at opposite ends of
the AVAILABILITY axis, while `is_update` asks about the NOVELTY axis, on which
ESPN publishes nothing. `Active` is also the status that carries a comment about
a TEAMMATE and the one an athlete re-anchor may re-point, so its identity is not
even settled when dedup runs.

**The change is MONOTONE** — it can only turn a former `false` into `undefined`,
never a `true` into anything else, so every downstream effect only ADDS
pass-throughs. Verified over the live feed: 539 NFL + 7 NBA rows relaxed, zero
`true` lost. `src/scripts/update-signal-dryrun.ts` re-checks it; the numbers
that must be zero are `true → ¬true` and `→ false`.

`Injured Reserve` never reaches this function — `SKIP_STATUS_RE` drops those
rows earlier in `parse()`. Do not count them when reasoning about the feed's
status distribution; the naive census says 591 rows assert `false`, the real
number is 530.

`ESPN_UPDATE_SIGNAL_MODE=legacy` restores the old boolean without a deploy.

One second-order effect: `is_update` also selects `updateKind`
(`TRACKING` vs `CORRECTION`) in deduplicator.ts, and only `TRACKING` is
Return-Watch-worthy — so newly-passed-through events also propose Return Watch
candidates. Watch `[ReturnWatch]` volume after a change here.

### The Tagged Athlete Is Not Always the Injured One
ESPN's injuries feed is one row per athlete, so its tag is normally
authoritative — with one exception that matters: a row for a **healthy**
athlete (`status: "Active"`, `details: null`) exists to carry a comment
about a TEAMMATE. Allgeier's row is where Jeremiyah Love's high ankle
sprain was reported. News sources are weaker still: `extractAthleteName`
takes the first capitalized bigram in the headline.

So classifier-vs-source name drift is not evidence the classifier is
wrong. `attemptAthleteReanchor` (athlete-reanchor.ts) re-points the event
onto the classifier's athlete when ALL of these hold, and forces MD
review exactly as before when any fails:
- the roster resolves a **different**, non-ambiguous player, and
- the name came from the SOURCE TEXT (the roster is keyed on the source's
  spelling — the classifier wrote "Jeremiah Love", the roster holds
  "Jeremiyah Love", and `web_resolve_player` is exact-normalized-name), and
- the classifier's surname actually appears in the source text, and
- the event is an article OR a feed row whose tagged athlete is healthy.

It runs BEFORE the significance gate and fact validation, because
everything downstream reads an identity off the event: the player row,
the team check, the dedup fingerprint and the entity. When it applies it
also drops `espn_athlete_id` (the id resolves ahead of the name and would
silently revert the re-anchor) and re-scores significance on the new
athlete's tier.

`ATHLETE_REANCHOR_MODE` is `off | shadow | on`, default **shadow** —
shadow decides and logs but changes nothing at all, including the cases
that look obviously safe.

### The athlete tier chain

`lookupAthleteTier` (significance.ts) asks four sources in a fixed order and stops
at the first answer. The order is pinned by tests:

1. **`athlete-tiers.json`** — a human's assertion about a named athlete. An
   OVERRIDE, not a floor despite what the file's own notes say: it is consulted
   first and returns unconditionally, so an entry set below what an athlete rates
   actively suppresses them. Tier 4 DROPS BREAKING outright.
2. **`salary`** — what the market pays him today. NFL/NBA only.
3. **`draft`** — where the league itself took him, within a recency window. NFL.
4. **`club` / `card`** — PREMIER_LEAGUE and UFC, which have no contract data.

**2, 3 and 4 are all promote-only.** Each mapping function returns `1 | 2 | null`
and the narrow return type IS the invariant — a later edit that tries to return 4
is a compile error rather than a silent policy change that stops publishing every
depth player's injuries. `validateSalaryBands`, `validateDraftTiers` and
`validateDerivedTiers` each DROP a config entry naming tier 3 or 4 rather than
honouring it, degrading to the flat tier-3 default, which is the previous
behaviour and therefore the safe direction.

**None of `salary`, `draft`, `club` or `card` may be added to poller.ts's
concussion pre-drop, which gates on `source === 'lookup'` only.** Do not
"complete" the union. All are promote-only, so an event carrying one of those
sources can never be `concussionBlocked` in the first place
(`isConcussionTierBlocked` is `tier > 2 && …`) — naming them would be inert
today. It stays out because writing it encodes the claim that a machine
inference from an index is strong enough to end an event's life before the model
ever sees it, and that claim is false.

**Why draft exists.** Salary is undefined for the population that needs it most.
Rookie-scale money is structurally below the $8M NFL tier-2 band no matter how
highly an athlete was drafted — Malik Nabers (2024 #6), Michael Penix Jr. (#8),
Christian Gonzalez (2023 #17, `contract.salary` $2.81M) all sat at the flat
default. And **`tier_blocked` is a TRACKING×tier rule, not a tier rule**: 122 of
152 scored DROPs across two dead cycles were `bar=tier_blocked`, and every one
carried `ct_prior=30` (= TRACKING). `TRACKING.require_tier_1_or_2` hard-drops
tier 3 with no threshold consulted, and the block is season-invariant, so Sept 1
does not change it. BREAKING at tier 3 is NOT blocked. That reads as a tier
problem in the logs and cost real time to diagnose.

**Draft never confers tier 1.** Tier 1 swaps the BREAKING bar to `BREAKING_T1`'s
45, the loosest in the config, so a false tier 1 is the expensive error. A #1
overall pick is what a team HOPES; that belongs in `athlete-tiers.json`, by hand.
`tier_1_max_overall` is expressible and ships absent, pinned by a test.

**The window is `max_seasons_since_draft`, and it is nearly free BECAUSE salary
gets first refusal.** Of the 32 NFL first-rounders drafted in 2019, 23 are still
rostered and 16 of those are already covered by salary or curation — so cutting
at 3 seasons discards mostly athletes the market has already answered for and
retains only the ones no other provider can see, who are by construction the
busts. The band keys on `overall`, not `round`: `overall` is immune to
compensatory picks, forfeited picks and the 31-pick 2023 first round.

**Two ESPN traps in the loader.** Draft records carry the athlete's COLLEGE-era
name while pro rosters add generational suffixes, so 11 of 319 R1/R2 picks only
match on the loose key ("Anthony Richardson" → "Anthony Richardson Sr.") — and 11
roster loose-keys are ambiguous, so the uniqueness guard is load-bearing. And a
class year that has not happened returns HTTP **200 with an empty `items` array**,
not a 404, so "not held yet" and "read failed" look nothing alike: skip the year,
never abort. Do NOT key on the draft record's own `id` (`107910`); the shared
ESPN athlete id is only inside that record's `athlete.$ref`.

Per-ref failures split two ways and the split matters: a **404 is a bad ROW**
(skip, count), a **timeout/429/5xx is a bad PAGE** (abort, keep the incumbent).
ESPN rate-limits by dropping a contiguous block of refs, and a rate limit read as
"these picks have no athlete" would install a snapshot missing an arbitrary run
and silently demote exactly the athletes this promotes.

`refreshTierSnapshotsIfStale` is the one entry point and refreshes all three
snapshots with in-flight coalescing. `invalidateTierSnapshots` deliberately does
**not** invalidate the draft snapshot: roster sync changes salaries and clubs,
not draft results, and wiring it in would spend ~180 HTTP calls every 6h on data
that changes once a year. Pinned by a test.

Re-verify any change here with `src/scripts/draft-tier-dryrun.ts`. The numbers
that must be zero are refs lost to non-404 failures, curated tier-4 entries
inside the window, promote-only violations, and forbidden gate flips.

### The report date is not the injury date

ESPN's injuries endpoint is a **status table, not a news wire**. Each row's `date`
is a last-refresh timestamp, re-stamped whenever the athlete's availability
changes — and it becomes `RawInjuryEvent.reported_at`, which both DATE ANCHORING
prompts describe as "when the SOURCE ARTICLE was published". Of the 21 in-window
rows carrying an `injury_details` block, 20 use elapsed-time language and **none**
describe a fresh injury with no elapsed frame.

Mykel Williams' ACL reconstruction of 2025-11-02 was dated 2026-08-19 that way and
projected a 2027-05-15 return for an athlete being discussed for Week 1.

Three things carry the fix, and all three are load-bearing:
- `DATE_ANCHORING_SHARED` (`date-anchoring.ts`) is imported by BOTH
  `date-resolution.ts` and `agent.ts`. They used to be copy-pasted and had already
  drifted in three bullets. Never re-type it. It now says an ANNOUNCEMENT is not an
  OCCURRENCE, and that an unresolvable carryover must emit NO date rather than
  falling back on the report date.
- `injury_description_long` and `roster_designation` on `RawInjuryEvent`.
  `buildDescription` prefers `shortComment` and DROPS `longComment` on 790 of 800
  rows — and 13 of the 21 in-window detail rows state their historical anchor ONLY
  in longComment. Without carrying it, no prompt wording can help. They are
  SIBLING fields: `injury_description` must stay byte-identical, because it keys
  body-part extraction, the classifier, significance, dedup and entity matching.
- `detectCarryoverSignals` (`carryover.ts`). `roster_designation` PUP-P/PUP-R/
  NFI-A/NFI-R is a league-rule fact (26/26 live rows were genuine carryovers) but
  LOW recall — of 6 in-window surgical rows all 6 were carryovers and it caught 1.
  Recall comes from prose patterns over the narrative.

**`details.returnDate` is deliberately never copied onto `RawInjuryEvent`.** It is
ESPN's lapsed ESTIMATED return: 64 of 111 live rows carry one dated BEFORE the row
itself, median lag −2 days, and Williams' is −6 — indistinguishable from the pack.
Keying on it would flag more than half the feed. Making it unreachable is stronger
than a comment. Two other traps the live diff caught: ESPN's longComment closes
with career biography ("an undrafted free agent in April 2024") and future dates,
so a month reference only counts when injury words sit next to it; and a fresh
event ("had surgery Friday", "placed on injured reserve") vetoes a prose-only
inference. Re-verify with `src/scripts/carryover-dryrun.ts` — the number that must
be zero is rows whose `injury_description` changed.

`injury_date_unresolved` forces MD review only on the PAIR: gating carryover
evidence AND `injury_date_confidence` of `unknown`/`possible`. Either alone is
normal traffic. It is in `MD_REVIEW_ANNOTATE_ONLY_CODES`, so it can be downgraded
without a deploy.

### RTP weeks are TOTAL from injury_date

`min_weeks`/`max_weeks` are the literature range measured from the injury/surgery
date. They do NOT shrink as the athlete rehabs: an ACL reconstruction is ~39-52
whether surgery was last week or nine months ago. Remaining time is DERIVED for
display by `formatRtpWindow` and never stored.

This was ambiguous in three places at once and the model resolved it its own way:
`agent.ts` told it REMAINING in two spots and TOTAL in a third, the tool schema
said nothing at all (the PR #30 undescribed-field failure again), and
`buildOtmProjection` added the weeks to `injury_date` as if TOTAL. Keep all four in
agreement — the schema descriptions are the authority.

`formatRtpWindow` always names the anchor, because a bare "39–52 weeks" beside a
story about an athlete nine months post-op reads as "39 MORE weeks". It has three
widths; `minimal` exists for `buildConflictFarcasterCast`, which assembles a whole
post and hard-truncates it at 320.

Two `injury_date`s exist and used to disagree: OTM emits its own, and the resolver
produces one. The poller reconciles them into a single `dateAnchor` before the
projection is frozen and the post is formatted, preferring the resolver at
probable/confirmed. Without that, the elapsed time a reader sees and
`projected_return_date` are measured from different dates.

### A corrected date re-anchors its projection

`projected_return_date` is frozen at thread open as `injury_date` + the midpoint of
the OTM week window. When an MD corrects `injury_date`, `updateThreadDates`
(mcp `client.ts`) recomputes it from the STORED weeks and writes an
`otm_projection_reanchored` row to `audit_log`. One place, covering both the
frontend MD edit and the poller.

OTM is deliberately NOT re-run: the WEEKS are a clinical judgement about the injury
and do not change when the calendar anchor is corrected — only the arithmetic does,
and re-running would rewrite published content behind the MD's back. Pass an
explicit `otm_projection` to override. It fails closed on a missing or non-numeric
week bound (note `Number(null)` is 0, which IS finite — check the type, not the
coercion).

### OrthoIQ Reference Rule
Append OrthoIQ referral link ONLY on DEEP_DIVE content type,
on the final post/cast only. Never on BREAKING or TRACKING.

### MD Review Routing
Route to review queue when:
- confidence score < MD_REVIEW_CONFIDENCE_THRESHOLD (code default 0.75;
  **production runs 0.70**, set in Railway — check the env var, not the default)
- injury_severity === 'SEVERE'

These two are independent, and the second is the one people forget: a SEVERE
post routes to review at confidence 0.99, so no threshold change can un-gate it.
`content_type === 'DEEP_DIVE'` also always routes, short-circuiting before
confidence is even read (`needsMDReview` in publishing-pipeline.ts).

The confidence itself is model-emitted via `emit_injury_post`, and there are
**two** confidence fields — post-level `confidence` (what this gate reads,
stored as `md_review_confidence`) and `return_to_play.confidence` (stored as
`rtp_confidence`). They measure different things: how sure we are of the
reported facts, versus how good the literature behind the timeline is. Keep
their tool-schema descriptions distinct — when the RTP one had no description
at all, the model emitted the same number into both.
Posts pending review are stored in database with status PENDING_REVIEW.
They do NOT publish to Farcaster or Twitter until approved.

### forceMDReviewReason outranks all of that

The poller's `forceMDReviewReason` makes review unconditional — no confidence
score and no threshold change can un-gate a post once it is set. Sites:
`x_insider` (poller.ts, env-gated), `athlete_name_drift`, `fact_soft_fail:*`
(the 8 soft codes), `laterality_thread_mismatch`, `content_type_drift`,
`post_team_mismatch`, `post_team_unverifiable`, `injury_date_unresolved`. Between Aug 16-18 2026 **every**
routed post went through this path, never through the confidence gate.

Two levers, both fail-closed by default (`injury_date_unresolved` is governed by
the first — see "The report date is not the injury date"):
- `MD_REVIEW_ANNOTATE_ONLY_CODES` — comma-separated soft codes downgraded to an
  annotation (logged + written to the validation audit row, post still
  publishes). Empty by default; every code forces review as before.
- `ATHLETE_REANCHOR_MODE` — see "The Tagged Athlete Is Not Always the Injured One".

The forced reason no longer REPLACES what `needsMDReview` would have said; both
are recorded (`athlete_name_drift; severity is SEVERE`). The short-circuit meant
a reviewer could not see a forced post was also SEVERE.

### An entity can outlive the post that justified it

Entities are minted BEFORE any post exists (`resolveThreadAndDates`, pre-OTM),
and both FKs back to `injury_posts` are `ON DELETE SET NULL`. The MD's Reject
button deletes the post — so rejecting one used to leave the thread ACTIVE,
post-less, and still inside the 21-day `web_find_matching_entity` window, where
it absorbed every later report about that athlete as a duplicate. Greenard's
false "back / surgery" thread collected 7 post-less CORRECTION rows that way.

`web_thread_close` now takes `outcome: 'VOID'` (mcp migration 020) and the
frontend reject route voids the thread when the rejected post is its only link
to published content. VOID writes **no** `accuracy_record` — scoring a
projection that was never valid pollutes the accuracy number the platform is
judged on — and it is excluded from matching, from the accuracy view, and from
every `listThreads` call the dashboard makes.

### Body parts that are also English words

`back`, `head`, `hand` and `neck` need a positive anatomical signal in the
adjacent word before `extractBodyParts` will believe them: a qualifier before
("lower back"), an injury noun after ("back surgery"), or an injury verb two
back ("injured his back"). Matching them bare cost real damage twice — "won't
be **back** at practice" created the Greenard back-surgery thread, and "**Head**
coach said…" put `head` in SPINAL_PARTS next to a stated side, raising
`laterality_inconsistent` and forcing review on an ankle injury.

Parts are returned in TEXT ORDER, not `BODY_PARTS` declaration order —
`parts[0]` is the primary body part and it keys entity matching.

Prefer the source's own fielded data: `RawInjuryEvent.injury_details`
(ESPN's `{type, location, detail, side}`) beats re-scraping the prose that
`buildDescription` assembled FROM those fields. `side: "Not Specified"` means
the source declined to say, so the text still gets its turn.

## Did It Reach an Audience?

A `PUBLISHED` row is NOT evidence that anything was cast or tweeted. The web
post is created first, the social calls come after, and every one of them is
caught and swallowed — `publishInjuryPost` returns `status: 'published'` even
when both social platforms failed. `platform_results` lives in memory and the
logs only; nothing persists it. That is how publishing stayed dead for five
days in August 2026 while approvals kept reporting success.

The only durable signal is a `PUBLISHED` post with neither a `farcaster_hash`
nor a `twitter_id`. Three ways to read it:
- `GET /admin/social-health?window_hours=N` — on demand, admin-gated. It THROWS
  on a failed query rather than reporting a clean bill of health, and answers
  `ok:false` when `truncated` is true: a partial window is an unknown bill of
  health, not a clean one. `scanned` says how many rows it actually read.
- `[Audit] N PUBLISHED post(s) in the last 24h reached no social platform` —
  emitted from the ApprovalSync cycle, at most hourly. Every content type.
- Three distinct pipeline log lines, which mean different things and have
  different fixes: `SOCIAL PUBLISH FAILED` (reached nobody),
  `SOCIAL HASH UNPARSEABLE` (it IS live, only the DB link is lost), and
  `Failed to write social hashes` (writeback rejected).

### Never read posts with an unpaged `web_list_posts`

`web_list_posts` defaults to `limit: 20` (max 50) over `created_at DESC`. Every
caller that passed `{}` was answering a 7- or 30-day question from twenty rows —
`/admin/social-health` returned identical counts for `window_hours=336` and
`720`. Use `listAllPosts` in `src/utils/web-posts.ts`, which filters server-side,
pages at 50, and stops at the window edge. Athlete-filtered one-shot calls pass
an explicit `limit: 50`.

### ApprovalSync scope

`APPROVAL_SYNC_NOT_BEFORE` holds a backlog back; its duplicate guard is
in-memory, so without a cutoff the first deploy after an outage fires the whole
backlog at the live accounts at once. `APPROVAL_SYNC_CONTENT_TYPES` (default
`DEEP_DIVE`) says which types it may re-cast — it was DEEP_DIVE-only, and the
Aug 2026 outage orphaned 6 BREAKING and 3 CONFLICT_FLAG posts and no DEEP_DIVE,
so the net could not have caught the failure it was built for.

Age budgets are enforced per type independently of the cutoff — BREAKING 6h,
TRACKING 48h, CONFLICT_FLAG 7d, DEEP_DIVE 7d — and only the newest post per
thread is eligible. The division of labour: **this loop recovers a publish that
failed minutes-to-hours ago; anything older is an editorial decision and belongs
to `src/scripts/republish-social-orphans.ts` under human review, not a cron.**

`publishApprovedPost` handles every content type — never assume DEEP_DIVE when
reconstructing a row. Use `reconstructPostContent` (`src/utils/post-content.ts`),
which fails closed on an unrecognized or missing `content_type` rather than
defaulting: `content_type` picks the formatter, and the OrthoIQ CTA is emitted
only by the DEEP_DIVE builders, so guessing wrong puts a referral link on
breaking injury news.

### The RTP columns are named asymmetrically

`injury_posts` stores the RTP window as `return_to_play_min_weeks` /
`return_to_play_max_weeks` but the probabilities as `rtp_probability_week_2/4/8`,
plus `rtp_confidence` and `md_review_confidence`. There is no `confidence`,
`return_to_play_confidence`, or `return_to_play_probability_week_*` column.
Both earlier copies of the reconstruction read the second set, so every post
rebuilt from a stored row cast `Wk 2: 0% | Wk 4: 0% | Wk 8: 0%`.

It survived because the two halves fail differently: the `*_min_weeks` names
ARE right, so the `missing_rtp` gate kept working, and `?? 0` produced a zero
indistinguishable from a true `0.000` — a complete tendon rupture really does
have a 0% chance of RTP at week 2. Reconstruction now fails closed
(`missing_rtp_probabilities`) rather than defaulting, for the content types
whose formatters print percentages.

`web_get_post` / `web_list_posts` are plain `SELECT *` with no aliasing, so the
row you get back is the raw column names. Build test fixtures by recording a
real payload (`tests/fixtures/injury-post-row.json`), never by hand — the
previous suite passed only because its fixtures used the same wrong names the
code did.

### x.com is deliberately absent from data/source-tiers.json

Do not "fix" it by adding the hostname. `sourceTier()` keys on the URL host, so
adding `x.com` would promote **every** x.com URL — including ones that never
passed the insider allowlist (the mention monitor, user-submitted corrections).
Parsing the handle back out of the URL is worse: `src/config/x-insiders.ts`
exists because handle-spoofing of verified-looking accounts is the documented
attack, and identity there is the numeric `userId` ONLY.

Tier X events by **provenance** instead — `resolveEventSourceTier()` in
`fact-validator.ts` keys on `source_name` starting with `X:`, which our own
fetcher sets only after the userId allowlist check has passed. Same signal and
same test that `shouldForceMDReviewForXSource` (poller.ts) already uses.

The tier file (`updated_at: 2026-05-31`) predates the X insider feature
(shipped 2026-07-18), so for a month every X event scored `unknown` and
therefore low-tier. That had two effects, and the second was the worse one:
- `source_tier_low` fired on 100% of X events, routing them all to MD review.
  It silently overrode `X_INSIDER_FORCE_MD_REVIEW=false` — a soft fact-validator
  failure becomes `forceMDReviewReason`, which bypasses `needsMDReview` outright.
- The `team_mismatch` gate hard-DROPPED them. T1/T2 sources get a soft
  `team_mismatch_unconfirmed` with the reported team preserved; T3/unknown get a
  hard drop plus a roster correction. So a trade-plus-injury scoop — the thing
  these accounts break most often — disappeared with no review at all.

### Which content types actually print percentages

Config-dependent, and easy to get wrong. `TWITTER_CHAR_LIMIT > 500` (production
is 25000) selects the long-form builders:
- DEEP_DIVE prints them on **both** platforms (`buildDeepDiveThread`,
  `buildLongFormDeepDive`).
- CONFLICT_FLAG prints them on **neither** in production —
  `buildConflictFarcasterCast` and `buildLongFormConflict` both omit them. Only
  `buildConflictTwitterThread`, the ≤500-char free-account path, prints them.

CONFLICT_FLAG is still covered by the fail-closed guard precisely because that
is one env var away from being live again.

## MCP Server Connections

This repo connects to sidelineiq-mcp-servers via HTTP:
- FARCASTER_MCP_URL — Farcaster publishing
- TWITTER_MCP_URL — Twitter publishing
- WEB_MCP_URL — Database reads/writes and MD review flagging

If an MCP server is unavailable, log a warning and continue
with available servers. Never crash the polling loop.

## Sports Injury Intelligence Skill

The Injury Intelligence Agent operates under the Sports Injury
Intelligence Skill defined in `skills/SKILL.md`. This file is
physician-founder reviewed and represents proprietary clinical IP.

**Every injury processing run must:**
1. Load `skills/SKILL.md` before any classification or RTP logic
2. Load `skills/references/rtp-probability-tables.md` for RTP ranges
3. Load the relevant sport reference file for sport-specific context
4. Never generate RTP estimates without completing the three-axis
   classification defined in SKILL.md Section 1
5. Never generate RTP estimates for CONCUSSION or SYSTEMIC events
6. Always state whether injury grade is CONFIRMED or INFERRED
7. Apply MD review escalation criteria from SKILL.md Section 4.5
   before publishing any flagged content

The SKILL.md file takes precedence over any other instruction when
processing injury events. Do not modify SKILL.md during code sessions
— changes require physician founder review.

## Research Agent

The Research Agent queries PubMed for evidence-based context on
injury types. It was adapted from orthoiq-agents.
Key difference: outputs are formatted for public sports content,
not clinical consultation briefs. Keep reading level accessible.

## Environment Variables

See .env.example. Railway manages production secrets.
Never commit .env files.

## Relationship to Other Repos

- `sidelineiq-mcp-servers` — Provides MCP tools this agent uses.
  Deploy that repo first.
- `sidelineiq` — Frontend (Next.js/Vercel). Reads from same
  Neon database.
- `orthoiq-agents` — Separate platform. Do not import from it.

## Deployment

Single Railway service.
Polling loop starts automatically on server start.
Express server handles any webhook or manual trigger endpoints.
