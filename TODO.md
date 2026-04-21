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

## Session 6 — MD Review Admin UX + DEEP_DIVE + Data Sources ✅

### MD Review Admin UX ✅
- [x] Admin page approve/reject actions (was read-only queue display)
- [x] One-click approve: PENDING_REVIEW → PUBLISHED via web_approve_injury_post MCP tool
- [x] One-click reject/delete: calls web_delete_injury_post
- [ ] Batch clear for low-signal posts (e.g. confidence < 0.4 bulk dismiss) — deferred

### DEEP_DIVE Content ✅
- [x] Force DEEP_DIVE to always route to MD review (needsMDReview in publishing-pipeline.ts)
- [x] Manual trigger: POST /test/deep-dive — exercises full Sonnet agent + pipeline
- [x] processDeepDive() in agent.ts — educational tone, 4096 max_tokens, DeepDiveInput interface
- [x] Autonomous scheduler (deep-dive-scheduler.ts)
  - [x] 3-day default interval (DEEP_DIVE_INTERVAL_MS env var)
  - [x] Aggregates last 72h of posts by injury_type, triggers if count ≥ 3
  - [x] 7-day per-type cooldown (DB-side + in-memory belt-and-suspenders)
  - [x] 5-minute startup delay, setTimeout-chaining pattern (matches poller.ts)
  - [x] DEEP_DIVE_ENABLED and DEEP_DIVE_MIN_INJURY_COUNT env vars
- [x] Social publishing on MD approval
  - [x] POST /admin/approve/:post_id endpoint on agents backend
  - [x] Handles both nested return_to_play_estimate and flat DB column shapes
  - [x] Web URL in final social cast (drives traffic web ← social)
  - [x] IndexNow ping fires on approval (first ping since post was PENDING_REVIEW)
  - [x] Frontend approve route calls agents backend after web_approve_injury_post
- [x] Verified end-to-end: Farcaster thread (5 casts) + X thread (5 tweets) with web link
- [ ] OTM signature truncated on X final cast (~10 chars) — minor cosmetic, fix deferred

### Additional Data Sources
- [ ] Evaluate NewsAPI as secondary source for NFL/NBA — deferred to Session 7

### Sports Coverage Expansion
- [ ] Premier League (hold — stabilize NFL/NBA first)
- [ ] UFC (hold — no structured injury feed, lower signal quality)
- [ ] NBA stabilization: monitor dedup rates, MD review queue, confidence distribution

---

---

## 🚀 Launched — April 20, 2026

- [x] Autonomous polling live — NFL + NBA, 15-minute intervals
- [x] Inaugural post: Moses Moody patellar tendon rupture DEEP_DIVE (Farcaster + X + web)
- [x] NewsAPI wired as secondary NFL data source
- [x] MD review queue active
- [x] Database purged of all test data pre-launch
- [x] Twitter MCP tool max tweet length raised to 500 (t.co URL shortening fix)
- [x] web_purge_all_posts MCP tool added (pre-launch utility)

---

## Post-Launch — Active Monitoring

- [ ] Watch first week of autonomous posts: dedup rates, MD review queue volume, confidence distribution
- [ ] MD_REVIEW_CONFIDENCE_THRESHOLD at 0.6 (lowered from 0.75 for ESPN data quality) — revisit after observing queue
- [ ] NewsAPI athlete name extraction: misses DK/DJ/TJ/Za'Darius-style names — improve regex if miss rate is high
- [ ] Batch clear for low-signal posts (confidence < 0.4 bulk dismiss in admin UI) — deferred
- [ ] OTM signature truncated on X final cast (~10 chars) — minor cosmetic, fix when convenient

## Infrastructure / Ops

- [ ] IndexNow key file will need updating when custom domain purchased
- [ ] SITE_URL env var on Railway controls IndexNow URL (update to custom domain, no code change)
- [ ] Neynar basic plan rate limits — monitor if volume increases
- [ ] Twitter forbidden errors — monitor; if recurring, regenerate tokens AFTER permission change

## Sports Coverage Expansion (in order)

- [ ] Premier League — add after NFL/NBA stable (ESPN source exists, needs activation)
- [ ] UFC — add after Premier League (no structured injury feed, lower signal quality)
