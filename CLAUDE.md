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
│   ├── poller.ts               # 15-minute sports data polling loop
│   ├── deduplicator.ts         # Prevents duplicate injury coverage
│   └── sports/
│       ├── nfl.ts              # NFL data source handlers
│       ├── nba.ts              # NBA data source handlers
│       ├── premier-league.ts   # Premier League handlers
│       └── ufc.ts              # UFC/MMA handlers
└── utils/
    ├── mcp-client-manager.ts   # Connects to sidelineiq-mcp-servers
    ├── content-formatter.ts    # Formats content per platform
    └── publishing-pipeline.ts  # Orchestrates full publish flow

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
- All sports data polling runs on 15-minute intervals
- All injury posts go through publishing-pipeline.js —
  never publish ad hoc
- All errors logged with sport, athlete, and timestamp context
- Deduplication check before every publish
- MD review routing when confidence < threshold OR severity is SEVERE

### Content Types
- BREAKING — injury just reported, publish immediately
- TRACKING — recovery update on existing injury
- DEEP_DIVE — educational deep dive on injury type, scheduled

### Sports Coverage (Launch Order)
1. NFL (active now)
2. NBA (add after NFL stable)
3. PREMIER_LEAGUE (add after NBA stable)
4. UFC (add after Premier League stable)

### OrthoIQ Reference Rule
Append OrthoIQ referral link ONLY on DEEP_DIVE content type,
on the final post/cast only. Never on BREAKING or TRACKING.

### MD Review Routing
Route to review queue when:
- confidence score < MD_REVIEW_CONFIDENCE_THRESHOLD (default 0.75)
- injury_severity === 'SEVERE'
Posts pending review are stored in database with status PENDING_REVIEW.
They do NOT publish to Farcaster or Twitter until approved.

## MCP Server Connections

This repo connects to sidelineiq-mcp-servers via HTTP:
- FARCASTER_MCP_URL — Farcaster publishing
- TWITTER_MCP_URL — Twitter publishing
- WEB_MCP_URL — Database reads/writes and MD review flagging

If an MCP server is unavailable, log a warning and continue
with available servers. Never crash the polling loop.

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
