# SidelineIQ Agents — Build Tracker

## Prerequisites
- [x] sidelineiq-mcp-servers deployed to Railway
- [x] MCP server URLs available as env vars

## Session 1 — MCP Integration ✅
- [x] MCP Client Manager
- [x] Content Formatter (BREAKING/TRACKING/DEEP_DIVE x 3 platforms)
- [x] Publishing Pipeline with deduplication and MD review routing
- [x] Integration tests
- [x] .env.example complete
- [x] E2E test endpoint (POST /test/publish) — Farcaster confirmed working

## Session 2 — Injury Intelligence Agent
- [ ] Research Agent transplanted from orthoiq-agents
- [ ] Injury classifier (type, severity from raw text)
- [ ] Return-to-play probability engine
- [ ] Core Injury Intelligence Agent

## Session 3 — Sports Monitoring (NFL First)
- [ ] 15-minute polling loop
- [ ] Deduplicator
- [ ] NFL data source handler (ESPN + NewsAPI)
- [ ] End-to-end test: NFL injury → publish

## Session 4 — NBA Coverage
## Session 5 — Premier League Coverage
## Session 6 — UFC Coverage
