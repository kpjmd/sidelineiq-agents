# SidelineIQ Agents — Claude Code Guide

## What This Repository Is

This is the agent backend for SidelineIQ — an autonomous AI sports
injury intelligence platform. It contains the Injury Intelligence Agent
that monitors sports injury news, generates clinical breakdowns, and
publishes content across platforms via MCP servers.

SidelineIQ is an independent platform from AequOs (formerly OrthoIQ). They share a
founder (board-certified orthopedic surgeon) but are separate codebases,
separate Railway deployments, and separate brands.

## The ParatrOs rename

The public brand is **ParatrOs** (decided 2026-09-14; `paratros.com`). Styling is
"ParatrOs" in text and `paratros` for domain, handle, slug and tag contexts.
Everything an audience reads comes from `src/config/brand.ts`: the name, the
signature (`— ParatrOs | AI-generated analysis. Physician-founded.`), the
`ref=paratros` tag, and the "ParatrOs read" / "the ParatrOs window" labels.

- **"OrthoTriage Master" is retired as a persona.** "OTM" survives only as the
  internal name of the clinical framework in `skills/` and in code. The model
  still echoes it into prose (154 of 498 published posts; 4 of 39 in Sept
  2026), so `rebrandPersona` rewrites headline, clinical_summary and
  conflict_reason at emission and again inside `stripFrameworkLabels`. A prompt
  instruction alone is a request; that function is the guarantee.
- **Internal identifiers are NOT renamed**: repo and package names, the MCP
  client name, log prefixes, and above all the Railway service names — the
  private hostnames (`sidelineiq-mcp-servers.railway.internal`) derive from
  them, so a service rename breaks every MCP connection.
- **The metrics series is continuous across a handle change.** Nothing is keyed
  on a handle: X resolves `/2/users/me` (account id survives a rename) and
  Farcaster uses the numeric FID. `metric_snapshots.detail.username` is
  informational and simply changes value.
- The site URL fallbacks still read `sidelineiq.vercel.app` until paratros.com
  is attached in Vercel; that cutover is its own change.

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
- Anything with a TTL measured against the poll cycle must OUTLIVE it —
  `defer.ttl_hours` was equal to it and silently made the whole defer queue a
  no-op. See "Corroboration means a second PUBLISHER".
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
takes the first capitalized bigram that survives its filters.

Those filters are why it is only *weaker*, not useless, and all three are
load-bearing. `blocklist` blocks a token that can never be a FIRST name — team
nicknames and headline vocabulary. `teamTokens` holds every token of every team
name INCLUDING the city half, and is consulted only when BOTH halves of the
bigram are in it, because the pair is then a club: "Portland Trail", "Cleveland
Browns", "Green Bay". Testing the pair rather than the first token is what keeps
Dallas Goedert and Orlando Robinson extractable — a flat city blocklist would
drop them, and `NFL_TEAM_LOCATIONS`/`NBA_TEAM_LOCATIONS` therefore feed
`teamTokens` ONLY and must never be added to `blocklist`. Third,
an all-caps 2-3 letter surname is a position code, not a person ("Seattle WR
Jake Bobo").

The city half was missing until 2026-08-24 and the team lists were
nickname-only, so an insider tweet that opens with the team — the house style of
every one of them — yielded the city as the athlete. Shams' "Portland Trail
Blazers guard Shaedon Sharpe sustained a torn meniscus" resolved to **"Portland
Trail"**, which resolves to no player, so no entity formed and the event filed a
second MD review item beside the ESPN one. Measured live: 3 of 18 extracted
names across the five insider timelines were not a person, all three the city
gap. PREMIER_LEAGUE had already solved this by hand-tokenizing its club list and
is unaffected. Re-verify with `src/scripts/athlete-extraction-dryrun.ts`; the
number that must be zero is changes that replaced a person-shaped name.

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
without a deploy. It is NOT consulted on the `md_manual` skip path — `possible`
there is the MD's own considered answer, and re-queueing it every cycle is noise.

### A settled date is not re-resolved

`resolveInjuryDate` is two Sonnet calls (four with a web search) and the poller ran it
on EVERY cycle that reached it. There was no "already resolved, leave it alone" check
anywhere, and the call is **nondeterministic**, so the same event resolved to a different
date on different cycles. Patrick Mahomes went `2025-12-14 → 2025-12-15 → 2024-12-15 →
2025-12-15` across three system writes six hours apart; Danny Pinter flipped 08-19 ↔ 08-20
four times; and the system twice reverted a date an MD had hand-corrected (Kamara,
Higgins), once seven minutes after the edit (Parsons).

All three `[ThreadManager]` lines for the Mahomes ladder logged `web_search=false`, so this
is **sampling variance on Pass 1**, not the open web. `temperature: 0` is now set on both
passes and is the SECONDARY lever — measured at temperature 0, Ashton Jeanty still answered
2026-08-23 / 2026-08-24 / 2026-08-23 across three real calls. **No prompt or sampling
setting makes an LLM deterministic; not asking twice is what does.**

`isSettledThreadDate` (`date-anchoring.ts`, NOT the poller — `date-anchor-choice.test.ts`
greps poller.ts for a re-inlined confidence ternary) settles on:
- **`md_manual` at any confidence, including with a null date.** The mcp guard already
  nulls every date field of a system write once md_manual is stored, so this deletes work
  whose result was already discarded — not a policy change.
- **a real `YYYY-MM-DD` date at `probable` or `confirmed`** — the same bar
  `chooseDateAnchor` already uses, from the same `ANCHOR_CONFIDENCES` set so "settled" and
  "wins the anchor" cannot drift apart.

A thread with **no** date is never settled whatever its confidence claims, so first
establishment always resolves and `updateThreadDates`' first `otm_projection_reanchored`
still fires. Live: 74 of 243 ACTIVE threads (30%) are settled; replaying all 31
`otm_projection_reanchored` rows, **19 of 19 system date changes are suppressed and 0
survive**.

`resolveThreadAndDates` reads the thread BEFORE resolving, and only when `dedup.entityId`
was already set. Net cost: −1 to −4 Anthropic calls and −1 write on the settled path, +1
indexed read on the rest. The post-write read-back is still there and is NOT redundant —
the md_manual guard can refuse part of a write.

`resolvedConfidence` on the skip path is the **stored** confidence, not `unknown`. The
JSDoc invariant it protects (a stale `confirmed` masking a resolution that just failed) is
about the resolving path; on the skip path nothing resolved. `unknown` would make
`shouldForceDateReview` route every carryover event on an anchored thread to MD review
every cycle forever, and would write that lie into the audit trail the dry-run replays.

**The trade-off: a first-pass wrong-but-confident date now freezes.** Three things defend
against it, and they are why the skip shipped LAST — `validateResolvedDates` caps an
incoherent emit below `probable`; `assessAnchorDivergence` un-settles a year-wrong thread;
and the MD can correct it, permanently now. The re-roll was never a repair mechanism: 31
reanchor rows across 13 threads converged on nothing.

`DATE_RESOLUTION_RESOLVE_MODE=skip_settled|always` (default `skip_settled`) restores the old
behaviour without a deploy. Observable: `date_settled=` in the poll summary. Re-verify with
`src/scripts/date-resolution-dryrun.ts`.

### The year is the largest single date error, and it fails silently

There was **no year logic anywhere** — one clause in the confidence ladder ("with an
unambiguous year") presupposed the judgement it asked for, and nothing said an NFL/NBA/PL
season straddles the calendar year. With today = 2026-09-09 every December injury resolved
to the December BEFORE the most recent one, and every MD correction was exactly +1 year
(Parsons, Mahomes, Sewell). A year wrong makes elapsed time 52 weeks wrong and can invert
a published CONFLICT_FLAG.

Three things carry the fix:
- **`season-calendar.ts` computes a CALENDAR REFERENCE block** in code — the most recent
  past-or-current occurrence of every month, the season spans with their straddle, NFL week
  numbers (Labor Day + 3 days = Week 1), and the LOCAL calendar date of `reported_at`. It is
  prepended to BOTH resolver passes and the prompt says it is authoritative. Handing the
  model the arithmetic beats asking it to redo the step it demonstrably got wrong. Measured
  after: Mahomes' "Dec. 15 surgery" resolved to 2025-12-15 three times out of three.
  `SPORT_SEASON_SHAPES` is deliberately NOT `significance-config.json`'s `sport_seasons` —
  those are threshold knobs, and binding the prompt to them would let a threshold edit
  rewrite the calendar. A test pins the two together on the month boundaries.
- **The YEAR RESOLUTION bullets in `DATE_ANCHORING_SHARED`.** Appended, so every existing
  bullet stays byte-identical. The CALENDAR REFERENCE reference is phrased CONDITIONALLY
  because `agent.ts` interpolates the same constant and carries no block — OTM got the year
  right in both live divergences, so adding one there would change 100% of post prompts to
  fix a defect not observed, and would destroy the independence the cross-check below needs.
- **`assessAnchorDivergence` (`date-anchoring.ts`)** acts on a signal the poller was already
  logging and ignoring. `year_apart` = 300-430 days apart AND within 30 days on the
  month/day circle. Both bars matter: a genuinely delayed procedure happens ~a year later
  but virtually never at the same time of year. 30 rather than 5 because the two sides are
  not the same quantity — OTM sometimes anchors on the surgery; Parsons (resolver 2024-12-14
  vs OTM 2025-12-29, 380d/15d) is the case that sets it, and ±5 missed him. On a hit the
  poller re-chooses through `chooseDateAnchor` with the confidence demoted rather than
  adding a "prefer OTM" branch, forces review under `date_anchor_year_divergence`, and
  persists the downgrade with **no `injury_date` key** so COALESCE keeps the stored date
  while the thread drops out of the settled set. Without that persistence the wrong
  `confirmed` would freeze forever.

It does NOT pick a winner. A divergence says one of them is wrong, not which; n = 2 on OTM
being right is not a rule.

### A malformed date silently discarded the whole thread write

`toResult` did no validation — it only trimmed — so `injury_date=2026-07` (Greenard) and
`surgery=2025-11` (Mykel Williams) reached the MCP call verbatim. `z.string().date()`
rejects those, the MCP SDK reports a rejected tool call as a normal **value** carrying
`isError`, and neither `callTool` nor the poller's step-3 write looked. The ENTIRE update —
date, confidence, sources, `needs_date_review` — was discarded while the poller logged a
success line. Williams' audit row records `previous_injury_date: null` when an MD
hand-entered 2025-11-02 two hours after the resolver had "resolved" it to exactly that.

`validateResolvedDates` (`date-validation.ts`) runs inside `toResult`, so it covers both
passes and runs BEFORE the Pass-1 fast path reads the confidence. **DROP** for structurally
unusable (malformed, >today+1, older than 6 years — "an absent date is recoverable
downstream; a confidently wrong one is not"); **DOWNGRADE** for merely incoherent (surgery
before injury; injury and surgery ~a year apart on the same calendar day, the Mahomes
signature), because the value may be right and the MD needs the evidence. A tier above
`unknown` with no date is forced to `unknown` — the poller sets `needs_date_review` on
`unknown` alone, so anything else leaves a dateless thread unflagged. `2026-07` is never
salvaged to `2026-07-01`: inventing a day is the confidently-wrong date the anchoring rules
forbid. One behaviour change: a malformed Pass-1 emit now falls through to the web-search
pass.

The write is now loud — `isMCPError` / `extractMCPErrorMessage` are exported from
`publishing-pipeline.ts` (do not write a fifth copy), `[ThreadManager] THREAD DATE WRITE
REJECTED` is logged, `thread_date_write_failed` forces MD review, and poller's `unwrapMCP`
throws on `isError` like `index.ts`'s.

### RTP weeks are TOTAL from injury_date

`min_weeks`/`max_weeks` are the literature range measured from the injury/surgery
date. They do NOT shrink as the athlete rehabs: an ACL reconstruction is ~39-52
whether surgery was last week or nine months ago. Remaining time is DERIVED for
display by `formatRtpWindow` and never stored.

A FIFTH place had to be brought into line later: the team-vs-OTM gap, which
compared these TOTAL bounds against a REMAINING team timeline at six sites. See
"team_timeline_weeks is REMAINING; the RTP window is TOTAL".

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

`otm_projection` is **NOT frozen at thread open**, whatever older comments say: every
post the poller maintains an entity for rewrites it (`COALESCE(new, old)`), of any
status, including posts a physician later rejects. It is a DISPLAY value. Accuracy
is scored against the thread's first PUBLISHED post that carries an estimate — see
"A return is a game, not a status". `projected_return_date` is `injury_date` + the
midpoint of the stored OTM week window. When an MD corrects `injury_date`, `updateThreadDates`
(mcp `client.ts`) recomputes it from the STORED weeks and writes an
`otm_projection_reanchored` row to `audit_log`. One place, covering both the
frontend MD edit and the poller.

OTM is deliberately NOT re-run: the WEEKS are a clinical judgement about the injury
and do not change when the calendar anchor is corrected — only the arithmetic does,
and re-running would rewrite published content behind the MD's back. Pass an
explicit `otm_projection` to override. It fails closed on a missing or non-numeric
week bound (note `Number(null)` is 0, which IS finite — check the type, not the
coercion).

### team_timeline_weeks is REMAINING; the RTP window is TOTAL

`team_timeline_weeks` is what the team said is LEFT, counted from the report
date. `min_weeks`/`max_weeks` are TOTAL from `injury_date`. They are different
clocks, and **six sites subtracted one from the other**, so every gap carried an
error exactly equal to the elapsed time since injury — zero on breaking news,
which is why each site looked right the day it was written, and 49 weeks on Nick
Bosa, whose queued CONFLICT_FLAG showed a "+38 week gap" for a return sitting
comfortably inside its window. The tool schema described the RTP bounds in
eighty words each and this field in one clause that named no anchor at all: the
PR #30 undescribed-numeric-field failure, two lines below the comment warning
about it.

**`computeConflictGap` (`src/utils/conflict-gap.ts`) is the only place the
comparison happens.** Team-implied TOTAL = elapsed + remaining, compared against
`[min_weeks, max_weeks]`. Frontend `lib/conflict-gap.ts` is a byte-identical
copy; `tests/fixtures/conflict-gap-cases.json` exists in both repos and pins
them together, and `CONFLICT_GAP_HELPER_VERSION` must match the fixture in both.
Change one, change both. Do not add a seventh formula.

**The bar is the WINDOW, not its midpoint.** SKILL.md Rule 5 says "faster or
slower than literature minimum"; the old detector compared to `(min+max)/2` with
a 2-week bar, so an athlete inside the literature range but off-centre tripped
it. Detection and the four display sites also disagreed — detection used the
midpoint while every builder printed `|team − max_weeks|` — so Micah Parsons was
flagged at 6.5 and rendered as "+0".

**No anchor, no verdict.** Without `injury_date` the status is `no_anchor`:
detection returns no conflict and every display says the gap is not computable.
16 of the 66 live CONFLICT_FLAG rows had asserted a conflict with no injury date
at all.

**The code decides, not the model.** `detectConflict` could only ever UPGRADE to
CONFLICT_FLAG; a model self-flag carrying a number stood unopposed, which is how
George Kittle reached the queue. An unconfirmed self-flag is now downgraded and
re-gated by `checkContentTypeDrift` — expect `ct_drift` to rise.

**The anchor is `chooseDateAnchor` (`date-anchoring.ts`)**, extracted from the
poller, where it ran AFTER `processInjuryEvent` had already scored the conflict
against a different date. Poller and agent both call it; a test greps for
re-inlined confidence ternaries.

**The field has held three quantities**: real remaining weeks (Bosa: 1), a TOTAL
post-surgery count the model computed itself (Kittle: 33 at 33 weeks elapsed;
Parsons: "Week 5 is ~39 weeks post-op" → 39), and a season length (52).
`team_timeline_anchor_ambiguous` forces review when a value is also plausible as
a total AND the reading changes the verdict; it needs 2 weeks elapsed, so it is
inert on fresh injuries, and it sits in `MD_REVIEW_ANNOTATE_ONLY_CODES`.
`parseTeamTimeline` now returns **null** for season-ending (was 24): a floor is
not an estimate, and Rule 5 cannot be "faster" than one.

Re-verify with `src/scripts/conflict-gap-dryrun.ts`, which scores every
CONFLICT_FLAG row old-vs-new with `as_of = created_at`. The numbers that must be
zero are anchored fresh injuries (elapsed < 2w) whose verdict moves with the
anchor, rows flipping no-conflict → conflict, and conflict verdicts with no
anchor. Bosa flipping to no-conflict is the fix working.

### A return is a game, not a status

`src/monitoring/return-detector.ts` closes a thread RESOLVED when the athlete
plays again. It is what makes `within_range` — the number the platform is
eventually judged on — exist at all: `accuracy_record` is computed at close, and
until this shipped nothing closed anything.

**The signal is a stat line in a completed REGULAR-SEASON game, from ESPN's
athlete gamelog.** An ESPN status transition to `Active` was rejected for the
reason settled twice above: `status` is a STATE, not a DELTA, and an `Active`
row sometimes carries a comment about a teammate. A game is an event, a reader
can verify it, and because the gamelog lists only games with a stat line, an
athlete who dressed and took no snaps is MISSED rather than INVENTED.

**Four properties of that endpoint, all verified live 2026-09-15 and pinned by
`tests/fixtures/espn-gamelogs.json`** (recorded, never hand-written — see the
fixture rule above):
- **Never iterate the flat `events` map.** PRESEASON games sit in it beside
  regular-season ones. Walk `seasonTypes[] → categories[] → events[].eventId`.
- **The regular-season test cannot key on `splitType`.** NFL sets it to `"2"`;
  **NBA names its categories after MONTHS** (`"april"`, splitType `"april"`). A
  `splitType === '2'` filter does not merely under-match for NBA, it returns
  NOTHING — a silent "nobody ever came back" for a whole sport. Only the
  seasonType `displayName` is shared. An unrecognised label is excluded and
  REPORTED.
- **`season` means different things per sport.** NFL `season=2025` is the 2025
  season; **NBA `season=2026` is the 2025-26 season** (the ENDING year). Omitting
  it returns only the current season.
- **`gameDate` is UTC.** `2025-05-01T02:00Z` is an April 30 game. Everything goes
  through `localCalendarDate` — the Pinter 08-19↔08-20 trap.

**Not inside `pollSport`**: that loop carries `PublishBudgetState`, so a
cap-exhausted cycle would skip returns, and it is feed-driven and therefore
blind to threads that have stopped generating events — exactly the population
that has returned.

**`RETURN_DETECT_MODE=off|shadow|on`, default `shadow`.** Shadow decides and
logs and writes nothing, including the cases that look obviously safe.

**The HTTP split is the highest-stakes rule here.** A **404 is a bad ROW** (skip
that athlete, count it); a **timeout/429/5xx is a bad PAGE** (abort the cycle,
leave every thread ACTIVE). ESPN rate-limits by dropping a CONTIGUOUS BLOCK of
requests, so a 429 read as "these athletes played no games" closes a run of
threads with no return — and a close is only reversible by a human calling
`web_thread_reopen`. `fetchEspnJson` (`src/monitoring/sports/espn-json.ts`) owns
the split; `draft-snapshot.ts`'s private copy was lifted into it, and the shared
version adds the repo's first HTTP timeout, which lands on the bad-PAGE side.

**Emit order is the reverse of intuition.** Append the `RESOLUTION` update
FIRST, then close. `maybeProposeReturnWatch` fires off the append path and
`isReturnWatchWorthy` has accepted `'RESOLUTION'` since it was written with **no
producer ever emitting one** — this is the first. Close first and the "first
game back" Desk candidate is never proposed. Watch `[ReturnWatch]` volume after
turning the mode up.

**A too-early return is evidence about the DATE.** A stat line before
`injury_date + RETURN_MIN_FRACTION_OF_MIN_WEEKS × min_weeks` (default 0.5) sets
`needs_date_review` and leaves the thread ACTIVE. Closing it would freeze a wrong
`injury_date` into an accuracy record, and the date is far likelier to be wrong
than the athlete superhuman.

`closed_by` must be the literal `'system'` — any other value stamps the audit
actor as a physician AND exempts the call from the mcp's system-caller guards.
Note `web_thread_correct_laterality` wants the opposite (`actor: 'automation'`
plus a named `corrected_by`); the two adjacent tools genuinely disagree.

`web_list_threads` now takes a `sport` filter and returns `espn_athlete_id`, so
**the detector requires the mcp deployed first**: under `.strict()` an undeclared
`sport` key fails the WHOLE call, and the cycle aborts (writing nothing) rather
than degrading.

Re-verify with `src/scripts/return-detect-dryrun.ts`. The numbers that must be
zero are returns on or before `injury_date`, returns from a non-regular-season
split, closes under an injected 404 **or** 503 (and the split between them),
overwrites of an existing `actual_return_date`, closes on a non-ACTIVE thread,
decisions that differ across two runs, closes without a schedule answer, and closes
under an injected schedule 404 or 503. Section G previews every detector close
re-scored under Amendment 1.

**Amendment 1 (2026-09-16, n=12, nothing published)** changed three things, all
computed in mcp `computeAccuracyRecord` and nowhere else:
- **The scored window is the first PUBLISHED post's**, read at close
  (`pickScoredWindow`), never `otm_projection`. `web_list_threads` returns it as
  `scored_window`. `decideThread`'s too-early bar reads it first (`tooEarlyWindowOf`)
  and falls back to `otm_projection` when no post was published: the bar is a
  date-sanity check, and reading the scored window alone removed it for exactly those
  threads (Alfred Collins, 09-08 → 09-10, closed instead of held). The fallback never
  reaches scoring — `predictUnscoreable` reads `scoredWindowOf` only. Robinson's stored window came from a
  rejected post; Jeanty's published 1-4w had been overwritten by an unpublished 2-8w.
- **0/0 at `rtp_confidence` 0 is not an estimate.** It is the concussion/systemic
  "decline to estimate" signature the prompt prescribes, and those posts publish.
  Do NOT reject it at emit time (`validateRTPEstimate`, the tool schema) — that would
  stop concussion posts. It is excluded at scoring (`carriesEstimate`).
- **Calendar censoring, the interval rule.** The whole first cohort was injured
  before the opener and returned in Week 1 — the SCHEDULE chose the date.
  `loadCalendarCensoring` (`espn-schedule.ts`) asks the returning team's schedule
  whether the return was its first completed regular-season game after injury_date,
  and the close sends `return_censored`. Censored and before the window floor →
  scored as a provable miss; censored at/after the floor → `calendar_censored`.
  An unknown team id or unscheduled season is **HTTP 200 with an empty `events`
  array**, not a 404, so an unanswerable schedule is `schedule_unavailable`: the
  thread stays ACTIVE. The schedule uses the gamelog's season convention and the
  same 404-row / 503-page split. The team is the one on the RETURN game
  (`GamelogGame.team_id`), so a traded athlete is judged on his new calendar.

Replaying the 24 first closes under it: 9 records change, all to
`calendar_censored`, and within_range went from 6/12 to 1/3 — Bosa (in-season
injury, missed games) inside; Kittle and Woodaz censored but back before their
floor, so scored misses. The rule was committed before that number was computed.

The metric definitions are pre-registered in `docs/accuracy-preregistration.md`,
committed before the detector closed anything. Do not change them after
publishing a number derived from them.

### AequOs Reference Rule
The commercial AequOs CTA appears ONLY when `content_type = 'DEEP_DIVE'`
**and** `subject_kind = 'INJURY_TYPE'`, on the final post/cast only, and on the
web page only then. Never on BREAKING, TRACKING or CONFLICT_FLAG, and never on
a DEEP_DIVE about one named athlete: a non-patient's medical situation beside
"get a personalized consultation" reads as advertising under a physician byline.
`carriesReferralCta` (content-formatter.ts) is the one predicate; the frontend's
`showsReferralCta` is its copy.

`subject_kind` (mcp migration 023) is recorded by the PRODUCER, never inferred
from prose: `processDeepDive` (the trending-type scheduler) writes `INJURY_TYPE`,
`processInjuryEvent` writes `ATHLETE` — including the DEEP_DIVE that
`/test/deep-dive` forces onto a single athlete. NULL (every pre-023 row), ATHLETE
and any unknown value carry no CTA; that is the fail-closed direction.
Reconstruction maps an unknown value to null rather than failing, so the post
still publishes. `formatForWeb` omits a null: it is not in the tool's enum, and
strict inputs fail the WHOLE create.

A type-led DEEP_DIVE's post 1 opens on the topic, not `Athlete (Team) — …`, and
its prompt asks for a topic-led headline. **Both documents that used to
contradict this were corrected on 2026-09-15 under physician founder review, the
only process allowed to change them.** SKILL.md §4.6 no longer permits the
referral on BREAKING for common recreational injuries — the injury type was
never what made the adjacency a problem, the named non-patient was — and
`content-templates.md` now carries a `subject_kind: INJURY_TYPE` headline
variant for each surface beside the athlete-led one, instead of showing
`DEEP DIVE: [PLAYER] — [INJURY TYPE]` as the only shape.

Audits read the RAW row, never `carriesReferralCta`, so they cannot agree with a
broken predicate. Re-verify with `src/scripts/cta-adjacency-dryrun.ts`
(`--after-backfill` once existing DEEP_DIVEs are tagged); the numbers that must be
zero are a CTA on any row that is not DEEP_DIVE + INJURY_TYPE, a type-led post 1
framing an athlete, and a type-led DEEP_DIVE with no CTA.

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
at all, the model emitted the same number into both. That applies to BOTH
schemas: `emit_injury_post` in agent.ts and `web_create_injury_post` in
mcp-servers, whose `returnToPlaySchema` had no descriptions at all until
2026-09-10. The rubric WORKED: byte-identical confidences were 100/263 (38.0%)
before PR #30 merged (2026-08-18T01:32:10Z) and 2/61 (3.3%) after. Quote the
post-rubric rate, never the whole-table one — 102/324 is mostly the defect, and
`md-confidence-dryrun.ts` section F once compared new posts against it.
Posts pending review are stored in database with status PENDING_REVIEW.
They do NOT publish to Farcaster or Twitter until approved.

**Both confidences are persisted on EVERY post now, not only reviewed ones.**
`md_review_confidence` used to be written solely by `flagForMdReview`, so it
recorded "the gate fired" rather than "a confidence was emitted" — NULL on 183
of 472 live PUBLISHED rows, every one on the auto-publish path. `formatForWeb`
had always sent the number, under the key `confidence`, which
`web_create_injury_post`'s zod object does not declare: **`z.object` strips
unknown keys and returns success**, so it was discarded silently. The emitted
key must be the COLUMN name. `rtp_confidence` survived only because it rides
NESTED inside `return_to_play_estimate`, which is in the schema.

`status` was stripped the same way, and the review path leaned on it: the row
landed at the DDL default `PUBLISHED` and a SECOND call, `flagForMdReview`,
flipped it and filed the md_reviews row. See "A review-routed post is born
PENDING_REVIEW" — that is no longer how it works, and
`tests/web-create-post-contract.test.ts` now permits NO unaccepted key, checked
against a RECORDED `tools/list` response. The four `/seed` payloads in index.ts
call the tool directly and are covered by the same test.

### A review-routed post is born PENDING_REVIEW

Had that second call ever failed, a post routed to physician review would have
sat `PUBLISHED`: on the homepage, `/api/feed` and the sitemap, invisible to the
MD queue (which is driven ONLY by md_reviews rows) — and in ApprovalSync's
sweep, which treats "PUBLISHED with no social hash" as "approved, social failed"
and whose default allowlist is DEEP_DIVE, the one type that ALWAYS routes to
review. It would have been cast to Farcaster and X inside five minutes with no
MD ever seeing it. Live census 2026-09-11: it had not happened (0 of 233
routings). The fix is argued from consequence, not frequency.

- **mcp `web_create_injury_post` declares `status` (PUBLISHED | PENDING_REVIEW
  only) and `md_review_reason`,** and `createPost` is one data-modifying CTE: the
  post and its md_reviews row commit together, and the result echoes
  `md_review_filed`. A PENDING_REVIEW create WITHOUT a reason is accepted on
  purpose (it is what a pre-change agent sends mid-deploy; it lands non-public).
- **`formatForWeb` sends `status`, `md_review_required` and `md_review_reason`.**
  `md_review_required` was always declared and never sent.
- **The pipeline makes no flag call when `md_review_filed === true`.** Anything
  else falls back to `web_flag_for_md_review` and logs
  `[Pipeline] REVIEW NOT FILED ON CREATE`; a failed fallback logs
  `[Pipeline] MD REVIEW FLAG FAILED`, returns `review_flag_failed`, and counts as
  `review_unfiled=` in the poll summary. **Every old/new mix of the two repos ends
  in the same row state**, so deploy order is a safety property, not a convention.
- **ApprovalSync withholds a `md_review_required` row with no APPROVED review**
  (`withholdUnapproved`, after the newest-per-thread choice, fail-closed on an
  unreadable review table, log `[ApprovalSync] WITHHELD`). PUBLISHED is not proof
  of approval. It keys on `md_review_required`, which survives an mcp that
  strips `status` again. Both approval paths mark md_reviews APPROVED; it
  withheld 0 of 233 live rows when shipped.

Re-verify with `src/scripts/review-routing-audit.ts` (read-only). The numbers
that must be zero: PUBLISHED + required + no APPROVED review (excluding the
repair scripts' retrospective flags), PENDING_REVIEW with no md_reviews row,
PENDING_REVIEW not required, confidences outside [0,1], and — with `--since` —
review-routed rows NOT filed atomically. That last one is a positive proof:
both tables' `created_at` DEFAULT NOW(), which is fixed per statement, so a
review filed by the CTE has EXACTLY the post's timestamp and one filed by a
separate call is ~20ms later. Run it with a `--since` before the agents deploy
and it fails on every row — that is the check working.

`md-confidence-dryrun.ts` Section E (not-required rows must be PUBLISHED) is
now the check that this touched ONLY the review path.

### web_flag_for_md_review keeps a confidence it was not given

`confidence_score` is optional and COALESCEs onto the stored value. Since every
create persists the model's number, the repair scripts' hard-coded sentinels
(`legacy-fact-sweep` 0.5, `fix-injury-laterality` 0.5,
`republish-social-orphans` 1) overwrote the only record of it — and wrote a
fabricated value into the 183 historical NULLs, which must stay NULL. They pass
nothing now. **Never pass a placeholder confidence to this tool.** Migration 022
adds `CHECK (… BETWEEN 0 AND 1)` on both confidence columns, because above 1 is
the fail-OPEN direction (`confidence < threshold` is false).

Two traps for anyone testing near this. The mcp suite's
`getTool(server, name).handler(args, {})` calls the RAW callback — zod runs in
`McpServer.validateToolInput` on the `tools/call` path only, so that pattern
hands the handler an object zod never touched and a stripped field is
structurally invisible to it. Go through `tool.inputSchema.parse()` first. And
`post-content.ts`'s RTP confidence must NEVER fall back to
`md_review_confidence`: that link was unreachable only while the column was
NULL, and it would print a FACT confidence as a LITERATURE confidence.
Re-verify with `src/scripts/md-confidence-dryrun.ts`; the numbers that must be
zero are RTP confidences that move under the new chain, rows with a NULL
`rtp_confidence`, flagged rows with a NULL value, and — with `--since` — new
auto-published rows still NULL.

### forceMDReviewReason outranks all of that

The poller's `forceMDReviewReason` makes review unconditional — no confidence
score and no threshold change can un-gate a post once it is set. Sites:
`x_insider` (poller.ts, env-gated), `athlete_name_drift`, `fact_soft_fail:*`
(the 8 soft codes), `laterality_thread_mismatch`, `content_type_drift`,
`post_team_mismatch`, `post_team_unverifiable`, `injury_date_unresolved`,
`team_timeline_anchor_ambiguous`, `date_anchor_year_divergence`,
`thread_date_write_failed`. Between Aug 16-18 2026 **every**
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

### Publishing and re-routing are different questions

Five checks in publishing-pipeline.ts read the same `web_list_posts` rows and
answer different things. Do not unify them. The last three share
`isSameReviewQuestion`, which reads neither status nor time precisely so that
each can own its own.

- `isDuplicate` and `checkFollowUpCadence` answer **"should this follow-up
  publish?"** and both filter to `PUBLISHED`, because an unapproved post reached
  nobody and is not evidence we covered a story.
- `findEquivalentPendingReview` answers **"should this event re-route to
  review?"** and reads `PENDING_REVIEW` ONLY, with no time window: while the row
  is pending the queue still holds the question, however old it is. A pending
  post is not evidence of coverage, but it IS evidence we already asked the MD
  this exact question.
- `findRecentRejection` answers **"has the MD already said no to this?"** and
  reads `REJECTED` inside 21 days. Same branch, one step further on.
- `findSupersededPending` answers **"did this publish just make a queued item
  redundant?"** and additionally REQUIRES thread identity.

The second exists because the first two, once correct, left a pending post with
no memory anywhere. ESPN re-serves the same status row every `POLL_INTERVAL_MS`,
the classifier keeps answering `is_new`, entity dedup passes it through as a
legitimate follow-up, and the pipeline filed another identical review item every
six hours: Tyler Biadasz ×3 and Alvin Kamara ×2 byte-identical `TRACKING` rows on
2026-08-20, same `md_review_reason` each time.

It runs INSIDE the `review.needed` branch, never before it. A post that would
publish must never be skipped for having a pending sibling — that is the publish
question, already answered above.

Anything that differs files a fresh item: `content_type` (a CONFLICT_FLAG belongs
BESIDE the BREAKING it contradicts, not behind it — Danny Pinter filed both 25s
apart for one patellar tendon tear), thread, severity escalation, or a materially
new team-disclosed timeline. `injury_type`/`headline`/`clinical_summary` are
deliberately NOT compared — they are free model prose that varies on every
generation, and comparing any of them would suppress nothing.

**`disclosedWeeks` vs `weeksValue`.** The pending check reads
`team_timeline_weeks` through `disclosedWeeks`, which collapses a non-positive
count to "not disclosed"; the cadence throttle keeps the strict `weeksValue`
reading. The model emits a stray `0` where the schema says to omit the field —
the three Biadasz rows alternate null, 0, null for a tear nobody put a number on
— and read strictly that flap is two material changes, so the fix would have been
inert on its own flagship case. Both functions err toward "let it through", but
that means opposite things: there it publishes an update, which is safe; here it
files another review item, which is the failure.

Observable: `review_supp=` in the poller summary line, counted separately from
`skipped` on purpose. The log line is `[Pipeline] Review already pending`.

**A rejection is remembered for 21 days.** The Reject button used to DELETE the
post row — destroying the one thing `findEquivalentPendingReview` anchors on, so
rejecting was the single action that guaranteed the story came back next cycle.
mcp migration 021 keeps the row as `REJECTED` and `findRecentRejection` reads it.

21 days, matching `web_find_matching_entity`'s `recency_days`: a rejection stops
mattering once the entity that anchored it ages out, because after that the next
report opens a new thread and is a genuinely new question. Anchored on
`retired_at` — NOT `created_at` (filing time, which often leaves no window at
all) and NOT `updated_at` (the social-hash writeback bumps it, so the window
would silently stretch). **Fails OPEN on an unreadable `retired_at`**, with a
greppable log line: a malformed row must not silence a review item, the same rule
severity already gets. Observable: `reject_supp=`.

**A pending item can be overtaken by events.** `findEquivalentPendingReview` runs
inside the `review.needed` branch, so when the next cycle's post PUBLISHES
instead it never enters that branch and the pending sibling is left approvable.
Kamara 2026-08-21: TRACKING `c59cba69` pending at 12:26, TRACKING `caf3fee4`
published at 12:41, same thread, same 4 weeks — approving the first would have
posted him twice. `findSupersededPending` retires it (step 3d in
`publishInjuryPost`, after the social calls, never fatal). Observable:
`superseded=`.

It REQUIRES thread identity, unlike the rejection check: retiring a queue item is
a write against the MD's work and athlete-level identity is too weak to authorise
it. The two err in opposite directions on purpose — there a false match delays a
question, here it silently removes one.

**Supersede has no second chance.** If it fails, the next cycle's equivalent post
dies at `checkFollowUpCadence` and never re-enters the path, leaving a
permanently approvable stale item. `[Pipeline] SUPERSEDE FAILED` is the only
signal. A recovery sweep in `approval-sync.ts` is the proper fix and is not
built.

**Three functions, one predicate.** `isSameReviewQuestion` reads neither status
nor time; each caller owns its own filter and window. Do not fold the window into
it — that would make one function answer two questions.

**`REJECTED` and `SUPERSEDED` join every unfiltered query.** Use
`isRetiredPostStatus` / `RETIRED_POST_STATUSES` (`src/utils/web-posts.ts`). The
equality allowlists were already safe; `listAthletePosts` in deduplicator.ts was
the dangerous one — a REJECTED post is the STRONGEST evidence we have NOT covered
a story, and without the exclusion the first rejection suppressed every later
report about that athlete for 24h. That exclusion is narrow ON PURPOSE and does
not tighten to a `PUBLISHED` allowlist; that is a separate change.

### An entity can outlive the post that justified it

Entities are minted BEFORE any post exists (`resolveThreadAndDates`, pre-OTM),
and both FKs back to `injury_posts` are `ON DELETE SET NULL`. The MD's Reject
button used to delete the post — so rejecting one left the thread ACTIVE,
post-less, and still inside the 21-day `web_find_matching_entity` window, where
it absorbed every later report about that athlete as a duplicate. Greenard's
false "back / surgery" thread collected 7 post-less CORRECTION rows that way.

`web_thread_close` now takes `outcome: 'VOID'` (mcp migration 020) and the
frontend reject route voids the thread when the rejected post is its only link
to published content.

**Reject no longer deletes, and `rejectPost` performs the FK nulling by hand.**
That cleanup was a side effect of `ON DELETE SET NULL` and nothing else does it.
Skip it and `injury_entities.canonical_post_id` stays pointed at a rejected post
— `updateThreadDates` backfills canonical only when NULL, so the thread can never
re-anchor — and `shouldVoidThreadOnReject` reads a previously-rejected post's
`injury_updates` row as "other coverage exists" and stops voiding, re-opening the
exact bug above. Doing it explicitly makes the whole subsystem see byte-identical
inputs; `frontend/tests/reject-void.test.ts` passing unmodified is the proof.
**Supersede re-POINTS `canonical_post_id` instead of nulling it** — the
superseding post is on the same thread by construction.

Consequence for callers: **void the thread BEFORE calling reject.** After the
nulling there is no way to reach the entity from the post id. VOID writes **no** `accuracy_record` — scoring a
projection that was never valid pollutes the accuracy number the platform is
judged on — and it is excluded from matching, from the accuracy view, and from
every `listThreads` call the dashboard makes.

**Nothing ages an ACTIVE entity out** — no sweeper, no TTL, no cron — so a
thread whose event died downstream stays ACTIVE forever and keeps absorbing
later reports about that athlete inside the 21-day matching window.
`src/scripts/void-thread.ts` retracts ONE by id with a reason you write by hand;
it refuses any thread carrying a canonical post, an `injury_updates` row, an
audit row, a date, a projection or an accuracy record. Do not reach for
`close-backfill-shells.ts` instead: its eligibility predicate requires
`first_reported_at` inside the 2026-05-31 `BACKFILL_WINDOW` and its default
`void_reason` names that script, so borrowing it writes a false sentence into an
immutable audit row.

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

A wrong side on the ENTITY is correctable now, and was not before.
`laterality`/`body_part`/`injury_type` on `injury_entities` were INSERT-only, and
`fix-injury-laterality.ts --fix-entity` had been calling `web_apply_correction`
with `{entity_id, field:'laterality'}` — a tool that targets `injury_posts`,
requires `post_id`, and does not carry `laterality` in its field enum. Rejected
on three counts every time, never `isError`-checked, so entity laterality had
never once been corrected. mcp `web_thread_correct_laterality` is the real call
shape; it refuses a VOID thread, writes nothing when the side already matches,
and deliberately leaves `last_updated_at` alone because that column drives
`web_find_matching_entity`'s 21-day window and a correction is not new injury
activity. Scoped to laterality alone: changing `body_part` or `injury_type` in
place re-points which past reports should have matched the thread. Live census
2026-09-11: 0 of 88 ACTIVE threads disagree with their canonical post.

Prefer the source's own fielded data: `RawInjuryEvent.injury_details`
(ESPN's `{type, location, detail, side}`) beats re-scraping the prose that
`buildDescription` assembled FROM those fields. `side: "Not Specified"` means
the source declined to say, so the text still gets its turn.

### Corroboration means a second PUBLISHER, not a second sighting

The defer queue holds a borderline event (score inside the DEFER band) until
something confirms it. It had never once done that, for three independent
structural reasons, and the counters said `promoted=0` without saying why.

- **`ttl_hours: 6` equalled `POLL_INTERVAL_MS`.** `scheduleNext` chains the next
  cycle AFTER the current one finishes, and `evictExpired` runs at cycle start,
  so every entry was evicted at the beginning of the very next cycle. 324 EXPIRE
  lines, every one `deferred_for_h=6.0–6.2`; all 39 live entries sat at
  `source_count 1`. **DEFER was DROP with extra steps.** `ttl_hours` is now 48 —
  it MUST exceed the poll interval, and 48 is what gives an entry one NewsAPI
  window (that source runs 1 cycle in 6). `checkDeferTtlReachable` (poller.ts)
  warns `DEFER_TTL_UNREACHABLE` if this breaks again.
- **The key could only match a source to itself.** `computeFingerprint` mixes the
  athlete with the first four description words. ESPN's table says "Ankle - Leg,
  Not Specified" and a tweet says "placed on IR" — two publishers never share a
  fingerprint, so `source_count` counted one feed re-serving its own row. The key
  is now `computeAthleteKey` (`sport|normalized name`), on the CLASSIFIER's name:
  for an ESPN row that is really about a teammate, that names the injured
  athlete. Measured on the live log: **15 of 353 deferred events would have
  promoted on self-repetition alone** under the old model.
- **A same-day second source never reached the queue.** `deduplicateEvents`
  collapses `sport|athlete|day` before the poller loop and dropped the loser.
  The survivor now carries `corroborating_families`, in BOTH win directions (the
  incumbent-wins case was entirely silent). Families are stored RESOLVED, not as
  names: `newsapi-nfl` covers five outlets and only the loser's own `source_url`
  says which.

**`sourceFamily` (`src/monitoring/source-family.ts`) is one family per
PUBLISHER.** Every `espn-*` fetcher collapses to `espn` — the structured feed and
an ESPN story are one newsroom. Each X insider is its own family (`x:<handle>`);
a tweet is reporting, not a table. NewsAPI keys on the outlet host. Anything
unidentifiable is **null, and null never corroborates** — a source we cannot name
must not be able to lower a publishing bar. It imports only types, because
`multi-source.ts` calls it and fact-validator would drag the MCP client into the
lowest-level fetch path.

**Corroboration is a THRESHOLD DISCOUNT, not a score bonus.** The score is a
property of the event; pickiness lives in the threshold (`computeSignificance`).
The predecessor added points to `event_recency_novelty`, weight 0.20 — so its
advertised `corroboration_bonus_max: 20` moved the composite by 4, and at the one
corroboration the TTL allowed, by 2. Config that could not do what it said. The
discount is `(families − 1) × 10`, capped at 20, applied inside
`effectiveThresholds` alongside the season delta so one code path owns both, and
**clamped at the DEFER floor** — which is also what keeps an oversized cap
harmless on the 15-point BREAKING_T1 and DEEP_DIVE bands.

**A promotion requires all three of:** an arrival that ADDED a family (otherwise
an entry holding two families re-promotes on every ESPN re-serve up to
`promotion_cap`), at least two families outright (the re-decision happens on a
later date, and a season boundary moves every bar — Sept 1 moves NFL's by 5), and
a passing re-score. The re-scored assessment is RETURNED and written back onto
`classified.significance` by `applyDeferOutcome`; `sig` in the poll loop is `let`
for exactly that reason, and `checkContentTypeDrift` is passed the same discount
so the gate and the drift check never judge one event against two bars.

Body part is stored on the entry but is NOT in the key: a tweet saying "placed on
IR" names no part, and keying on it would make exactly the ESPN+tweet pair
unmatchable. It is a null-tolerant guard — two known and different parts open a
separate entry; a null is learned once and never overwritten.

Entries written before this change carry no families. `normalizeEntry` fills them
in on load, and an entry with `sources: []` is **SEEDED** by its next arrival,
never corroborated by it: we do not know who filed it.

One interaction to know about: keying on the classifier's name means that when
the classifier misattributes several different reports to one athlete — the live
log has "Calvin Austin" standing in for three separate source athletes — those
reports share a defer entry. They are all `espn`, so they cannot corroborate each
other, and the body-part guard splits them when the parts differ. The residual
case (two misattributed reports from two families) would promote something
nobody corroborated, and it is caught downstream: `athlete_name_drift` sets
`forceMDReviewReason` BEFORE the gate runs, so such a post routes to a human
rather than to social. Taking `ATHLETE_REANCHOR_MODE` off `shadow` shrinks this
further.

`DEFER_CORROBORATION_MODE=off|shadow|on` (default `on`) is the lever; `off` is
honest about being what the queue already did. Re-verify with
`src/scripts/defer-corroboration-dryrun.ts --log <railway log>`. The numbers that
must be zero are promotions at one family, events from a registered source with
no resolvable family, cross-family merges whose second publisher was lost, and
any decision that changes at discount 0 or gets worse under one.

### Two dedups, and the crude one must not outrank the good one

Publishing runs the entity-aware dedup in the poller (`deduplicator.ts`, keyed on
player + body part + laterality inside a 21-day window) and then, inside
`publishInjuryPost`, a FALLBACK `isDuplicate` — a flat 24h `(athlete, sport)`
match for when there is no thread context at all.

The fallback runs FIRST, so two rules matter:

- **It only counts posts that reached an audience.** `web_list_posts` returns
  every status, and without a `PUBLISHED` filter an unapproved post silenced
  every later report about that athlete for 24h. With almost everything routing
  to MD review, the queue was suppressing its own follow-ups.
  `checkFollowUpCadence` always had that filter; `isDuplicate` did not, and a
  test had pinned the inconsistency as if it were deliberate.
- **It stands aside for a known follow-up.** When `parent_post_id` is set the
  poller has already matched an entity and decided this is a legitimate
  follow-up; `checkFollowUpCadence` governs those, with the 5-day per-thread
  window that a new team-disclosed timeline bypasses. The exemption is narrow —
  only TRACKING and CONFLICT_FLAG, the types that throttle actually covers — so
  nothing becomes ungoverned.

Jayden Higgins is the worked example: cleared entity dedup as
`entity_match_pass_through`, reached the thread manager, resolved his dates, then
died at `[Pipeline] Duplicate detected`.

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

### A hashless PUBLISHED row is ambiguous for as long as the publish runs

The same signal that says "this post reached nobody" also says "this post is
publishing right now" — the web row is written BEFORE the social calls and the
hashes AFTER. `auditSocialReach` has had a 10-minute floor for that reason since
it was written. `selectPostsToRepublish`, which actually CASTS, had none, and
`processedIds` does not cover the gap: it is in-memory and holds only this
loop's own publishes, not the pipeline's and not the approve route's.

**The clock is `max(updated_at, created_at)`, not `created_at`.** There is no
`published_at` column. `created_at` is when the post was FILED, and a
review-routed post is filed PENDING_REVIEW hours or days before approval — so a
`created_at` floor does not protect the approve path at all, which is the path
with the LONGER window (the frontend flips the status, then calls agents).
`updated_at` is set explicitly in SQL by every writer, including both
transitions into PUBLISHED (`web_approve_injury_post`, `web_update_md_review`),
so on these rows it reads as "when this row last changed state". Live: 35 of 35
approved-and-hashed rows had `updated_at >= md_reviews.reviewed_at`. Taking the
max means a malformed `updated_at` can only make the gate MORE cautious, and a
row with no usable timestamp is treated as in-flight.

**The filter runs AFTER the newest-per-thread choice**, for the same reason
`withholdUnapproved` does: holding back the newest post must not promote an
older sibling on the same thread, which by construction carries a superseded
timeline. Counted as `inFlight`, separately from `suppressed` — an in-flight row
is not suppressed, it is not decidable yet.

Measured live 2026-09-11: the window is sub-second (median 0.4s auto, 0.8s
approve, max 1.1s over 54 rows) and there were zero hashless PUBLISHED rows in
the 7-day lookback, so this changes no live decision today. It is argued from
consequence: a double cast to the real accounts with no MD in the loop.
`callTool` has no timeout and no retry, so the pathological case has no upper
bound at all — the 10 minutes is headroom, not calibration.

### web_get_social_state returns an envelope, not the value

The MCP text is `{"key": "...", "value": "<the stored string>"}`, with
`value: null` when the key was never written. The stored string is **one
JSON.parse deeper than it looks**.

`defer-queue.ts` parsed that text and then read `.entries` off the ENVELOPE,
where they never are, so `loadQueue` returned an empty queue on every load from
the day it shipped. Three consequences, all silent:
- corroboration never fired — every DEFER looked brand new, so `promoted=0` was
  structural, not a finding about the data;
- TTL expiry never fired, so `expired=0` likewise;
- `saveQueue` writes `entries` IN FULL, so appending to a wrongly-empty list
  **overwrote everything already stored**. Six live NFL cycles deferred 121
  events; the stored queue held exactly one entry.

`defer_q=0` reported that as "queue empty" rather than "queue broken" — the
exact confusion the `available` flag exists to prevent. So the read now fails to
`unreadable` (→ `available:false` → `defer_q=-1`) on anything it does not
recognize, and `handleDeferDecision` **refuses to write a queue it could not
read**. An empty list and an unreadable store must never be the same value.

Use `readSocialState` / `readSocialStateValue` in `src/utils/social-state.ts`.
Both callers hand-rolled this and only `mention-monitor-loop.ts` got it right;
that copy is gone. Do not write a third.

**DEFER was equivalent to DROP for the whole time this was live** — worth
remembering when reading any pre-2026-08-22 claim about defer-queue behaviour,
including "revisit the corroboration redesign after two weeks of defer_q data".
There was no data.

It survived because `mcpStateResponse` in `tests/defer-queue.test.ts` handed the
BARE state back as the MCP text instead of the envelope, so nine tests passed
against the bug. Fixtures are now recorded live in
`tests/fixtures/social-state-responses.json`. Third instance of that failure in
this repo; see the RTP-column and `status`-field cases above.

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

**PUBLISHED is not proof of approval.** A row with `md_review_required=true` is
re-cast only if it has an APPROVED md_reviews row — see "A review-routed post is
born PENDING_REVIEW".

`publishApprovedPost` handles every content type — never assume DEEP_DIVE when
reconstructing a row. Use `reconstructPostContent` (`src/utils/post-content.ts`),
which fails closed on an unrecognized or missing `content_type` rather than
defaulting: `content_type` picks the formatter, and the AequOs CTA is emitted
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

### An unknown key is a rejected call, not a dropped field

Every mcp tool's zod input used to be a plain `z.object`, which STRIPS keys it
does not declare and returns success — while `tools/list` advertised
`additionalProperties: false` the whole time. That mismatch is the bug class
behind `md_review_confidence` (discarded on 183 rows) and `status` (see "A
review-routed post is born PENDING_REVIEW"). mcp now applies `.strict()` to
every tool, deep (`MCP_UNKNOWN_KEYS=strict|strip`, default `strict`, set in the
mcp service — `strip` restores the old behaviour without a deploy).

The consequence to remember: **a key the server does not declare now fails the
WHOLE call**, where it used to cost one field. A rejection is a normal VALUE
with `isError`, never a throw, and several callers here do not check isError
(`web_set_social_state`, most `web_audit_append`). So `callTool` logs
`[MCP] INPUT REJECTED <server>.<tool>: …` for every caller at once
(`inputRejectionMessage`, mcp-client-manager.ts). That line must never appear;
grep for it after any change to a payload. The audit before strict shipped
(2026-09-11, all 123 agents call sites + all 33 frontend ones) found the
undeclared keys were `status` (now declared) and `fix-injury-laterality.ts:360`'s
`entity_id`, a call that was already rejected for a missing `post_id`.

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
