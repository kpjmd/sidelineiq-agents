# SidelineIQ Agents — Build Tracker

## Infrastructure Prerequisites ✅
- [x] sidelineiq-mcp-servers deployed to Railway (Farcaster, Twitter, Web servers)
- [x] Neon PostgreSQL provisioned and migrated
- [x] Vercel frontend deployed (sidelineiq.vercel.app)
- [x] MCP server URLs available as env vars

---

## Session 1–2 — Publishing Pipeline & Skill System ✅
- [x] MCP Client Manager (mcp-client-manager.ts)
- [x] Content Formatter — BREAKING / TRACKING / DEEP_DIVE / CONFLICT_FLAG × 3 platforms
  - [x] 2-post threads for BREAKING and TRACKING (280/320 char limits)
  - [x] 3–5 cast DEEP_DIVE threads
  - [x] 5-tweet / single-cast CONFLICT_FLAG format
  - [x] Markdown stripping for social posts
  - [x] OrthoIQ referral link on DEEP_DIVE final cast only
- [x] Publishing Pipeline (publishing-pipeline.ts)
  - [x] Deduplication check (24h window)
  - [x] MD review routing (confidence < threshold OR severity SEVERE)
  - [x] Web → social → hash writeback sequence
  - [x] web_update_injury_post correct param shape {post_id, updates, update_reason}
  - [x] Hash extraction for both single and thread tools (hashes[] / ids[])
  - [x] IndexNow ping after successful web publish
- [x] Skill Loader (skill-loader.ts) — loads SKILL.md + sport references at runtime
- [x] Skills: SKILL.md, rtp-probability-tables.md, nfl/nba/premier-league/ufc references
- [x] Content templates including CONFLICT_FLAG format
- [x] Integration tests (publishing-pipeline.test.ts, content-formatter.test.ts)

---

## Session 4 — Frontend ✅
- [x] Next.js App Router frontend (sidelineiq-frontend repo)
- [x] Feed page with BREAKING / TRACKING / DEEP_DIVE / CONFLICT_FLAG card types
- [x] Post detail page with full clinical breakdown
- [x] Admin/MD review queue page
- [x] Sport + content type filter bar
- [x] Load More pagination (?limit=N URL param)
- [x] Branded 404 page (OTM voice)
- [x] Farcaster ↗ and X ↗ social links on cards (conditional on hash presence)
- [x] ISR with 60-second revalidation

---

## Session 5 — Autonomous Monitoring Pipeline ✅
- [x] Types: SportKey, RawInjuryEvent, ClassificationResult (types.ts)
- [x] Classifier (classifier.ts) — Haiku fast triage via forced tool_use
  - [x] Team validation: rejects sport-league names (NBA, NFL) as team values
  - [x] Team correction delegated to Sonnet agent (not Haiku)
- [x] RTP Validator (rtp-estimator.ts) — pure logic, no API calls
- [x] Core Agent (agent.ts) — Sonnet orchestrator
  - [x] Three-axis OTM classification via emit_injury_post tool
  - [x] CONFLICT_FLAG detection (>2 week gap between team timeline and OTM estimate)
  - [x] TRACKING detection (parent_post_id linking)
  - [x] Math.round() on all integer DB fields (min_weeks, max_weeks, team_timeline_weeks)
  - [x] Narrative-first clinical_summary instruction (classification details follow, never lead)
  - [x] Team field in emit_injury_post for Sonnet-side team correction
- [x] ESPN Base Source (espn-base.ts)
  - [x] sanitizeTeamName() — strips angle-bracket sentinels (<UNKNOWN>)
  - [x] SKIP_STATUS_RE — filters IR / PUP / NFI / Out-for-Season
  - [x] MAX_EVENT_AGE_DAYS recency filter (default 7d, env var override)
  - [x] Skips records with no date
- [x] ESPN Sources: NFL, NBA, Premier League, UFC (espn-nfl/nba/premier-league/ufc.ts)
- [x] MultiSource wrapper (multi-source.ts) — composable, cross-source dedup
- [x] Sport Registry (sports/index.ts) — SportKey → MultiSource
- [x] Deduplicator (deduplicator.ts)
  - [x] 24h window: always isDuplicate:true when recent post exists (no is_update re-publish)
  - [x] Correct MCP response parsing (not Array.isArray)
- [x] Poller (poller.ts) — setTimeout chain, per-sport toggles, per-event try/catch
- [x] Server wiring (index.ts) — startPolling on boot, POST /poll/:sport manual trigger

---

## Pre-Session 6 — Polish & Bug Fixes ✅
- [x] IndexNow SEO ping (publishing-pipeline.ts + INDEXNOW_KEY / SITE_URL env vars)
- [x] IndexNow key file in frontend public/ (237a5fee5151417e84e64ba9f8b29e25.txt)
- [x] Social links on all 4 card types (farcaster_hash / twitter_id conditional render)
- [x] Load More pagination (URL param based, preserves filters)
- [x] Branded 404 page (app/not-found.tsx)
- [x] Hash extraction fixed for thread tools (hashes[] / ids[] arrays)
- [x] OTM classification markup stripped from social posts (stripMarkdown enhancements)
- [x] Farcaster CONFLICT_FLAG cast: stripMarkdown applied to clinical_summary
- [x] web_delete_injury_post MCP tool (in sidelineiq-mcp-servers)
  - [x] ON DELETE CASCADE on md_reviews FK
  - [x] TRACKING children guard with force:true override

---

## Session 6 — MD Review Admin UX + DEEP_DIVE + Data Sources (PLANNED)

### MD Review Admin UX
- [ ] Admin page approve/reject actions (currently read-only queue display)
- [ ] One-click approve: moves post from PENDING_REVIEW → PUBLISHED
- [ ] One-click reject/delete: calls web_delete_injury_post
- [ ] Batch clear for low-signal posts (e.g. confidence < 0.4 bulk dismiss)
- [ ] Requires new MCP tools: web_approve_injury_post (or web_update status)

### DEEP_DIVE Content
- [ ] Manual trigger test: POST /test/deep-dive with an injury_type payload
  - Verify DEEP_DIVE format renders correctly on web, Farcaster (3–5 casts), Twitter
  - Verify OrthoIQ referral appears on final cast only
  - Verify no social links until manual approval (MD review required)
- [ ] Autonomous DEEP_DIVE trigger strategy (options to evaluate in session):
  - Option A: Frequency trigger — same injury_type seen ≥3 times in a rolling 72h window
  - Option B: Star-power trigger — injury to high-profile athlete (top 50 by some signal)
  - Option C: Scheduled — once per day, pick highest-frequency injury_type from last 24h
  - Option C is simplest and most predictable — recommend evaluating this first
- [ ] DEEP_DIVE should always route to MD review (physician-authored feel, higher bar)
- [ ] DEEP_DIVE agent prompt: different from BREAKING — educational tone, PubMed citations welcome

### Additional Data Sources
- [ ] Evaluate NewsAPI as secondary source for NFL/NBA (cross-validates ESPN data)
- [ ] MultiSource architecture already supports adding sources — one import + one array append
- [ ] Consider: team injury reports (official practice participation — higher signal than ESPN)
- [ ] Add second source for NFL first (most active, easiest to validate improvement)

### Sports Coverage Expansion
- [ ] Premier League (hold — stabilize NFL/NBA first)
- [ ] UFC (hold — no structured injury feed, lower signal quality)
- [ ] NBA stabilization: monitor dedup rates, MD review queue, confidence distribution

---

## Known Monitoring / Operational Items
- [ ] MD_REVIEW_CONFIDENCE_THRESHOLD currently at 0.6 (lowered from 0.75 due to ESPN data quality)
- [ ] IndexNow key file will need updating when custom domain purchased
- [ ] SITE_URL env var on Railway controls IndexNow URL (update to custom domain, no code change)
- [ ] Neynar basic plan rate limits — first-run flooding resolves naturally via dedup
- [ ] Twitter forbidden errors — monitor; if recurring, regenerate tokens AFTER permission change
- [ ] POLLING_ENABLED=true when ready for fully autonomous operation
