# SidelineIQ Significance Gate — Implementation Prompt

## Your Role

You are implementing a significance filtering gate for SidelineIQ's OTM (OrthoTriage 
Master) pipeline. SidelineIQ is an autonomous AI sports injury intelligence platform 
founded by a board-certified orthopedic surgeon. The platform's differentiator is 
physician-grade clinical analysis — not volume, not speed, clinical credibility.

This is a targeted extension to an existing pipeline, not a new build. Your job is 
surgical: add filtering logic at two existing seams without changing the pipeline shape.

## Context: The Problem

The pipeline currently publishes ~40 posts/day. Metrics:
- 31.7k impressions, 1.6% engagement rate, ~1 new follower/day
- 15-20 posts/day route to MD review queue (unsustainable)
- Many posts are clinically thin: "Player X has a foot injury. Could be fracture, 
  could be turf toe. RTP: 2-12 weeks." This kind of post actively damages the brand 
  the platform is building.

Target: ~5 posts/day average (4 floor, 10 ceiling). The goal is fewer, denser 
posts that consistently reward attention.

## Pipeline Shape (Unchanged)

1. Data sources (ESPN API + NewsAPI), polled every 15 min
2. Classifier (Haiku, forced tool-use): validates injury event, classifies content type
3. Deduplicator: 24h window
4. Injury Intelligence Agent (Sonnet): full clinical analysis, 3-axis OTM taxonomy
5. Publishing pipeline: routes to MD review if confidence < 0.6 or severity SEVERE

## Insertion Points (Already Exist)

You will modify these files only. Do not refactor adjacent code.

- `types.ts` — extend `ClassificationResult` with significance fields
- `classifier.ts` — expand the existing Haiku tool schema to include significance 
  assessment; same forced tool-use pattern, no new agent
- `poller.ts` — add gate after classification: if not post-worthy, log and continue, 
  never call `processInjuryEvent`
- `agent.ts` — (NEXT PROMPT, not this one) DECLINE escape valve in Sonnet

**This prompt covers `types.ts`, `classifier.ts`, and `poller.ts` only.** The agent-level 
DECLINE gate is a separate session.

## The Architecture You Are Implementing

### Two-Stage Gate (only Stage 1 in this prompt)

Stage 1 — **Triage Gate** at the classifier. Cheap, fast Haiku-level pre-filter. 
Target: eliminate 60-70% of events before they reach Sonnet.

Stage 2 — **Publication Gate** in the agent. (Out of scope for this session.)

### Significance Scoring Rubric (Stage 1)

Composite score 0-100, four weighted signals:

**Athlete Prominence (35%)** — Tier lookup:
- Tier 1 (stars/franchise players): 90-100
- Tier 2 (starters/rotation): 60-80
- Tier 3 (role players): 30-50
- Tier 4 (depth/practice squad/two-way): 0-20

**Information Specificity (30%)** — Does the source name a specific injury 
(ACL, high ankle sprain, Jones fracture) or just a body region ("foot injury," 
"lower body")? Vague reports score low.

**Event Recency & Novelty (20%)** — New disclosure, status change (IR, surgery 
confirmed, return timeline), or re-report of known info? "Still out, no update" 
scores near-zero.

**Content-Type Prior (15%)** — Different baselines per type:
- BREAKING: high prior (75)
- TRACKING: low prior (30)
- DEEP_DIVE: high prior (80)
- CONFLICT_FLAG: high prior (85)

### Triage Decisions

- Score ≥ 55: PROCESS (proceed to Sonnet)
- Score 35-54: DEFER (hold 6h; if confirming reports arrive, re-score; else drop)
- Score < 35: DROP

### Content Type Threshold Overrides

- TRACKING: requires ≥70 AND Tier 1-2 athlete (stricter — biggest noise source)
- DEEP_DIVE: ≥40 (lowest threshold; rare and high-quality)
- CONFLICT_FLAG: always PROCESS if validated
- BREAKING with Tier 1 athlete: ≥45 (lowered — even thin star reports are news-valuable)

### Sport Multipliers (applied to final score)

- NFL offseason: ×0.7
- NFL regular season: ×1.0
- NBA playoffs: ×1.1
- NBA regular season: ×1.0

(Premier League and UFC coming; multipliers must be configurable for new sports.)

### DEFER Bucket Mechanics

Events scoring 35-54 are written to a defer queue with a 6-hour TTL. On each poll cycle:
- Check defer queue for entries past TTL → drop
- Check if new events about same athlete/injury arrived → re-score combined signal; 
  if new score ≥55, promote to PROCESS

## Calibration Examples (Signal vs. Noise)

Here are three example noise pattern ie expected low score. DROP (filter):

Example #1 - The player is not a marquee player and the specific fracture and where a surgery occurred is unknown leading to wide RTP timeline. Expect low score. DROP.
“Mark Williams remains out with a left foot fracture — a designation that carries more clinical weight than it often gets in public coverage, and one that warrants careful tracking given how much variance exists within "foot fracture" as a category.
The fracture type and specific anatomical site are not publicly confirmed, and that ambiguity matters significantly for any RTP estimate. Foot fractures in NBA big men span a wide clinical spectrum: a 5th metatarsal (Jones) fracture, a navicular stress fracture, and a distal metatarsal fracture each follow meaningfully different recovery arcs, with surgical versus non-surgical management adding another layer of variability. The procedure type, if any surgery occurred, has not been disclosed publicly — and that gap is the single biggest driver of uncertainty here.
What the biology anchors for a foot fracture at this severity level: non-surgical management of a moderate bone injury in the foot requires a minimum of 6–10 weeks of protected healing before return to full sport loading is feasible. Surgical fixation — as is common with Jones fractures or displaced fractures — typically produces functional RTP timelines in the range of 8–16 weeks, with higher-risk sites like the navicular pushing toward 4–6 months or longer due to limited vascularity and documented re-fracture risk. The "Out" designation without a weeks-based timeline is consistent with either a surgical case still in early recovery or a complex fracture site where the team is appropriately not committing to a window.
The anatomical site concern is worth naming explicitly: foot fractures in players of Williams' size — a 7-foot center with the body mass that role demands — carry elevated stress at the hindfoot and midfoot, where navicular stress fractures are a known risk archetype in NBA bigs. There is no public confirmation this is a navicular injury, but the combination of position, body type, and "Out" designation makes the stress fracture continuum worth flagging.
The current date is April 29, 2026 — late in the regular season / postseason window — and with the "Out" designation still in place, Williams appears unlikely to return this season regardless of the specific fracture type. The remaining RTP estimates below reflect time from today assuming the injury date is not precisely confirmed, and should be interpreted as the realistic window for return to full basketball activity, not merely clearance to walk.”

Example #2 - The player has an injury of unknown grade or anatomical location making recovery timeline unknown AND the NFL is in offseason. Expected low score. DROP
“Garrett Wilson is carrying a knee sprain designation this offseason, with the injury grade and specific structural involvement not publicly confirmed. The "Questionable" game-status tag is a stale offseason label — it carries no meaningful recovery timeline signal in April, and OTM is not treating it as one.
Without imaging results or a reported mechanism, the tissue involved here is inferred rather than confirmed. "Knee sprain" is a broad descriptor that can cover anything from a mild Grade 1 MCL microstretch — a 1–3 week event — to a more significant Grade 2 collateral or posterior ligament partial tear in the 4–8 week range. A Grade 3 structural disruption or any surgical involvement would carry a materially longer timeline, but there is no reporting to suggest that level of severity here.
What we do know: Wilson is a route-running wide receiver whose game is built on acceleration, sharp cuts, and contested-catch situations. Any knee ligament injury with residual instability or pain at the end-range matters more for his functional profile than it would for a player with less lateral-movement demand. Grade 1 injuries at this position carry outsized uncertainty — the gap between 95% and 100% knee stability is not trivial for a WR.
The positive framing: an offseason knee sprain reported in late April, without surgery language and without a placement on IR or a PUP list, points toward the lower end of the severity spectrum. If this is a Grade 1–2 collateral sprain managed conservatively, Wilson is tracking comfortably toward a full return well before September. The biology supports that. The watch signal here is any escalation in language — surgery consultation, MRI disclosure, or a PUP designation heading into training camp — any of which would reset this estimate meaningfully upward.”

Example #3 - The player had a “leg surgery” of unknown type or anatomical structure and RTP range is therefore speculative/unknown. Expected low score. DROP “Calvin Ridley is recovering from lower leg surgery, with the specific procedure not publicly disclosed. That distinction matters significantly here — "lower leg surgery" is a wide tent that could encompass anything from a fibula fixation or calf/Achilles tendon repair to a peroneal tendon procedure or stress fracture intervention, and each of those carries a meaningfully different recovery floor.
The tissue type is confirmed as lower extremity and surgical, but the precise structure involved is inferred from limited reporting. Because the procedure type is unknown, the RTP range must span the realistic spectrum: a bone fixation (e.g., fibula) might allow return in 6–10 weeks post-op, while a tendon repair — particularly an Achilles or peroneal — carries a 4–9 month biological floor with no shortcuts. Until the procedure is named publicly, any single-point estimate would be false precision.
The surgery date itself has not been disclosed, which further complicates the remaining-time estimate. Without knowing when the procedure occurred, it is not possible to state how far into recovery Ridley currently is. If surgery occurred during the standard NFL post-season window (January–February 2026), he would now be approximately 2–4 months post-op, which would place him on track for a Week 1 return for a lower-severity procedure, but potentially still mid-rehabilitation for a tendon repair.
The "Questionable" game-status tag carries no timeline information in the April offseason — it is a stale administrative designation, not a clinical disclosure. What matters is whether Ridley is progressing through rehabilitation milestones ahead of training camp (late July). For a skill position player whose entire value is built on route-running precision and burst off the line, lower leg integrity is not a secondary concern. Any tendon involvement — particularly Achilles or peroneal — in a wide receiver should be tracked closely as OTAs and mandatory minicamp approach. The watch signal here is simple: is he a full participant when camp opens?” 

These three examples, signal pattern expected high score(process):

Example 1 - Player suffers a confirm achilles rupture in the NBA playoffs. Expected high score. PROCESS “Donte DiVincenzo has ruptured his right Achilles tendon and will require surgery — one of the most serious soft-tissue injuries in professional basketball. The rupture is confirmed by reporting; the specific surgical procedure has not been publicly disclosed, though primary Achilles repair (or open repair with augmentation) is standard in this setting.
The Achilles rupture is the NBA's most consequential soft-tissue injury archetype. Tissue biology here is unforgiving: the Achilles tendon is under extreme tensile load with every step, and surgical repair initiates a remodeling process that cannot be rushed regardless of elite medical support. The published literature on Achilles rupture repair puts functional return to sport at 9–12 months in the large majority of cases — this is one of the better-studied injuries in sports medicine, and that window is a T1, high-confidence range. Critically, functional clearance and biological healing do not coincide; the tendon continues remodeling well beyond the point of sport return, and reinjury risk is meaningfully elevated when athletes return at the early end of the window.
The team-reported timeline of 10 months aligns closely with the literature's central tendency — this is not a conflict situation, and it reflects an appropriately conservative framing from Minnesota's medical staff. Because the actual surgery date has not been publicly confirmed in the source material, the remaining recovery window cannot be calculated with precision from today's date. If surgery occurred at or near the time of this report (late April 2026), DiVincenzo would be targeting a return to play around February–March 2027, putting him on track for a late-season return at best. Depending on how the recovery progresses, the 2026–27 regular season may be largely or entirely lost.
For a guard-role player whose value is tied to explosive cutting, shooting off movement, and lateral defensive range, Achilles ruptures carry additional functional significance beyond the raw timeline. The literature documents meaningful performance variance post-Achilles in NBA guards — many return to play, but return to prior explosive output is not guaranteed. That long-term performance question is the real watch item here alongside the recovery clock.”  Example 2 - A DEEP_DIVE post with specific injury and surgery, status change apparent with timeline. Expected score very high. PROCESS.
“Moses Moody, 22, suffered a complete patellar tendon rupture to his right knee on March 23, 2025 — a season-ending injury requiring surgical repair that will sideline the Warriors' emerging 3-and-D wing well into the 2025–26 season. This is one of the most serious lower-extremity injuries in basketball, and at Moody's age the prognosis for full recovery is favorable, but the road back is long and the biology is unforgiving.
Three-Axis Classification:
* Axis 1 — Tissue Type: TEN (Tendon)
* Axis 2 — Structural Severity: Grade 3 — Complete disruption. CONFIRMED via team reporting ("complete patellar tendon rupture," surgical repair confirmed).
* Axis 3 — Anatomical Region: LE (Lower Extremity) — Right knee
* Flag: SURGICAL — escalated to surgical RTP table; MD review queue triggered.
* Evidence Tier: T1 — High Confidence. Patellar tendon repair is one of the better-studied surgical RTP injuries in sports medicine.
* Grade: CONFIRMED — complete rupture and surgical repair directly reported.
The Anatomy and Why This Matters: The patellar tendon connects the bottom of the kneecap (patella) to the tibial tubercle on the shin — it is the critical mechanical link in the knee extension mechanism. Without it, an athlete cannot extend the knee against resistance, cannot jump, cannot cut, and cannot sprint. A complete rupture means that continuity is entirely lost. Surgical repair is not optional; it is the only path back to athletic function.
The Surgery and Biological Timeline: Patellar tendon repair involves reattaching the torn tendon ends, typically with suture anchors into the patella, followed by a prolonged protected rehabilitation protocol. The biology here is not negotiable: tendon tissue heals via a collagen remodeling process that takes months, not weeks. The biological floor for Grade 3 tendon surgical repair is 6–18 months, and the patellar tendon literature specifically anchors functional sport RTP at 9–12 months — this is a T1 injury with a well-established evidence base. Published data puts RTP in the 9–12 month range for athletes targeting full return to professional competition. Functional clearance — passing strength and movement tests — typically precedes complete biological tendon remodeling, which is why reinjury risk remains elevated if return is rushed before the 9-month floor.
Phased Recovery:
* Weeks 0–6: Post-surgical immobilization, protected weight-bearing, quad activation. The repair is at its most vulnerable.
* Weeks 6–16: Progressive range of motion restoration, closed-chain strengthening, edema management.
* Months 4–7: Functional loading, straight-line running introduced, proprioceptive retraining.
* Months 7–10: Sport-specific movement — cutting, jumping, lateral change of direction — the highest-demand movements for an NBA wing.
* Months 9–12: Return-to-sport criteria testing. Limb symmetry index targets (typically ≥90% quad strength symmetry) must be met before clearance.
NBA-Specific Context — What This Means for Moody and Golden State: Moody was playing an important rotation role as a 3-and-D contributor — a player whose value is built on explosive cutting, off-ball movement, and defensive lateral quickness. All of those capacities are patellar-tendon-dependent. This is not an injury a player manages or plays through; it is a hard stop.
At 22, Moody's age is the most favorable clinical variable in this picture. Younger athletes demonstrate better tendon healing biology and greater neuroplastic adaptation during rehabilitation. The literature on patellar tendon RTP in athletes under 25 is more optimistic than in older cohorts. That said, patellar tendinopathy — chronic anterior knee pain from tendon overload — is a documented long-term complication after patellar tendon repair, and Moody's workload management in his return season will require careful monitoring. The NBA's reference files flag patellar tendon pathology as a "silent season-killer" archetype; that framing applies with even more weight post-surgical-repair.
What to Watch: The RTP clock started March 23, 2025 — from surgery date, not injury date. A 9–12 month window puts realistic full return at December 2025–March 2026, meaning Moody could be available for mid-season 2025–26 at the optimistic end, or not until the second half of that season at the conservative end. Any report of him ramping into 5-on-5 activity before October 2025 should be treated with skepticism — that would be inside the biological floor for this injury.”

Example #3 - Anthony Edwards is a tier 1 all-star caliber player who suffers injury in the NBA playoffs. Higher impact even if injury not clear cut. Expected score high. PROCESS.
“Anthony Edwards is out with a left knee bone bruise and hyperextension — a combination that carries more clinical weight than either designation alone, particularly in the NBA playoffs. The hyperextension component is inferred to involve ligamentous stress, most commonly to the ACL, PCL, or posterolateral corner structures, though no specific ligamentous injury has been confirmed publicly. The bone bruise designation is not a routine contusion — in the knee, bone marrow edema on MRI frequently signals an osteochondral stress event and can be a precursor to more significant structural pathology. Whether any chondral or ligamentous injury underlies the bone bruise is not yet publicly confirmed.
The severity of a knee hyperextension spans an enormous range: a mild capsular stretch resolves in days, while a significant PCL or multi-ligament injury can require months. Without confirmed imaging details, the grade here is inferred from the "Out" designation, which in a playoff context is a meaningful signal — teams do not sit star players in the postseason without clinical justification. That alone warrants conservative framing.
This is the NBA playoffs, which normally pushes the threshold for sitting a player sky-high. The fact that Edwards is listed Out — not Questionable, not Doubtful, Out — tells you the clinical picture forced the decision. The bone bruise at the knee is the piece that demands the most scrutiny here. Persistent bone stress in this location, combined with a hyperextension mechanism, raises the question of whether there is osteochondral or ligamentous involvement that has not yet been publicly disclosed. If imaging reveals anything beyond isolated bone marrow edema, this timeline extends materially. The injury date is not confirmed in the source — RTP estimates below reflect total expected duration from the injury event, with the start date unconfirmed.”

## What You Will Produce

### Phase 1: Design Doc (DO THIS FIRST, THEN STOP)

Produce `docs/significance-gate-design.md` covering:

1. **Type changes** — Exact new fields on `ClassificationResult` with TypeScript 
   signatures and rationale (e.g., do we expose the four sub-scores or just the composite? 
   Recommend with reasoning.)

2. **Classifier prompt changes** — The full updated tool schema for the Haiku 
   forced tool-use call, plus the prompt-level instructions for how Haiku should reason 
   about each signal. Include the athlete tier lookup mechanism (is the tier passed in 
   as context, or does Haiku infer? Recommend — note that Haiku inferring star/depth 
   status is unreliable, so a passed-in lookup is likely correct).

3. **Athlete tier database** — Schema, seed strategy for NFL + NBA (~Tier 1-2 athletes 
   only initially; default everyone else to Tier 3), update process. Recommend storage 
   (JSON file, SQLite, existing DB?) based on what the codebase already uses.

4. **Defer queue** — Storage, TTL mechanics, re-scoring trigger logic. Again, recommend 
   storage based on existing patterns.

5. **Poller gate logic** — Pseudocode for the new branch in `poller.ts`. Should be 
   minimal: check `triage_decision`, log, continue or proceed.

6. **Configuration split recommendation** — What should be config-driven vs. hardcoded 
   for v1? Your judgment. Constraints to weigh:
   - Thresholds and sport multipliers will need tuning in the first weeks → favor config
   - Sub-score weights are research decisions, less likely to change → could hardcode
   - Athlete tier lookup is data, not config → separate file/store
   - Anything that requires a code deploy to tune is a v1 risk
   Make a specific recommendation with rationale, not a menu of options.

7. **Observability hooks** — What metrics/logs are needed to know if the gate is working? 
   At minimum: drop rate, defer rate, score distribution, distribution by sport and 
   content type, athletes most often filtered. Recommend log shape and any dashboard 
   considerations.

8. **Test strategy** — Unit tests for scoring logic, fixture-based tests for end-to-end 
   classification with known events, edge cases (missing athlete in tier DB, malformed 
   source data, score on threshold boundary).

9. **Risks and open questions** — What could go wrong? What requires founder input 
   before implementation?

**STOP after producing the design doc. Do not write any implementation code. 
Wait for explicit approval to proceed to Phase 2.**

### Phase 2: Implementation (ONLY AFTER DESIGN DOC APPROVAL)

After the founder reviews and approves the design doc, implement the changes in this order:

1. `types.ts` — type changes
2. Athlete tier data file/store with NFL + NBA seed data
3. Config file with thresholds, multipliers (per Phase 1 recommendation)
4. `classifier.ts` — expanded tool schema and prompt
5. Defer queue implementation
6. `poller.ts` — gate branch
7. Tests for all of the above
8. Observability hooks

## Codebase Conventions to Follow

  Testing — no established framework. There are no test files and no test runner configured anywhere in the repo. If you add fixture-based classifier tests as part of this build, you'd be establishing the pattern from scratch. 
                                                                                                                                                                                        
  DB access — two hard rules:                               
  - Tagged template literals only, no ORM (neon driver)
  - In the agents repo, never access the DB directly — all DB reads/writes go through MCP tool calls to the web server via mcp-client-manager. The agents repo has no DB connection of its own. Only sidelineiq-mcp-servers talks to Neon directly, through WebDatabaseClient in src/servers/web/client.ts
                                                                                                                                                                                        
  Other conventions worth noting:
  - TypeScript with ES modules throughout — no plain JS, no CommonJS                                                                                                                    
  - Haiku for fast/cheap classification calls, Sonnet for quality generation — already established pattern in classifier.ts and agent.ts                                                
  - All injury posts go through publishing-pipeline.ts — never ad hoc publishes                                                         
  - Forced tool-use pattern for all Claude API calls (tool_choice: { type: 'tool', name: '...' }) — never free-form text responses from the agent                                       
  - Never crash the polling loop — all errors logged with sport/athlete/timestamp context, pipeline continues 

If conventions are unclear from the existing code, surface them as questions in the 
design doc rather than guessing.

## Definition of Done (Phase 2)

- All new types exported from `types.ts`
- Classifier returns valid significance assessment for all test fixtures
- Poller correctly drops/defers/processes per triage decision
- Defer queue persists across process restarts (if the codebase pattern requires it)
- Athlete tier DB is queryable and seeded
- All thresholds and multipliers reachable via config (per recommendation)
- Test coverage for scoring logic, gate branches, defer mechanics
- Logs expose drop rate, defer rate, score distribution at INFO level
- No changes to `agent.ts`, publishing pipeline, or MD review routing
- Existing tests still pass

## Constraints

- Do not modify the agent or publishing pipeline. The DECLINE escape valve is a 
  separate session.
- Do not introduce new external dependencies without flagging in the design doc.
- The athlete tier DB starts simple. Don't over-engineer (e.g., no need for a 
  full ETL from sports data APIs in v1 — a curated JSON file is fine if that 
  matches the codebase pattern).
- Sport multipliers must be configurable per sport — Premier League and UFC are 
  coming and we don't want a deploy to add them.
- Decline rate is the key metric for Stage 1's calibration. If the gate drops <40% 
  of events, it's too loose. If it drops >75%, it's too tight. Build in the 
  observability to know.

## What Success Looks Like

In production, this gate should:
- Drop ~60-70% of events before they hit Sonnet (cost savings + quality protection)
- Reduce daily post volume from ~40 to a place where the agent-level gate (next session) 
  can land at 6-7/day
- Surface clear logs so we can tune thresholds in the first 2 weeks based on real data
- Make NFL offseason noise nearly disappear without hardcoding "ignore NFL right now"

Begin with the design doc.