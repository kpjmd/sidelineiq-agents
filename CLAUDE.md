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
`RawInjuryEvent.is_update` is a TRI-STATE and the third value
matters: `undefined` means the source has no status field to
answer with, which is every news source. `resolveUpdateSignal()`
in poller.ts falls back to the classifier's `is_new` only in that
case, so the structured feeds are untouched. Without the fallback,
a news-sourced sport is silenced for the whole 21-day entity
window after its first post about an injury.

### OrthoIQ Reference Rule
Append OrthoIQ referral link ONLY on DEEP_DIVE content type,
on the final post/cast only. Never on BREAKING or TRACKING.

### MD Review Routing
Route to review queue when:
- confidence score < MD_REVIEW_CONFIDENCE_THRESHOLD (default 0.75)
- injury_severity === 'SEVERE'
Posts pending review are stored in database with status PENDING_REVIEW.
They do NOT publish to Farcaster or Twitter until approved.

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
  on a failed query rather than reporting a clean bill of health.
- `[Audit] N PUBLISHED post(s) in the last 24h reached no social platform` —
  emitted from the ApprovalSync cycle, at most hourly.
- Three distinct pipeline log lines, which mean different things and have
  different fixes: `SOCIAL PUBLISH FAILED` (reached nobody),
  `SOCIAL HASH UNPARSEABLE` (it IS live, only the DB link is lost), and
  `Failed to write social hashes` (writeback rejected).

`APPROVAL_SYNC_NOT_BEFORE` holds a backlog back. ApprovalSync re-casts any
hashless DEEP_DIVE from the last 7 days and its duplicate guard is in-memory,
so without a cutoff the first deploy after an outage fires the whole backlog at
the live accounts at once.

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
