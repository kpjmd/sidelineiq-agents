# SidelineIQ Significance Gate — Design Doc

> **Status:** Implemented. Phase 2 (implementation) complete. Phase 3 (agent-level DECLINE gate in Sonnet) is a separate session.

## Context

The SidelineIQ pipeline was publishing ~40 posts/day. Many were clinically
thin ("Player X has a foot injury. RTP: 2–12 weeks.") and actively damaging
the brand — physician-grade clinical analysis is the differentiator, not
volume. The MD review queue was also receiving 15–20 posts/day, unsustainable
for a single physician reviewer.

This gate is a Stage 1 **Triage Gate** at the classifier seam: a cheap
Haiku-level filter that drops or defers events before they reach the Sonnet
agent. Target: 60–70% drop rate before Sonnet, taking daily volume from ~40
to a state where a Stage 2 agent gate can land on 6–7 posts/day.

This document covers the design for `types.ts`, `classifier.ts`, `poller.ts`,
`significance.ts`, and `defer-queue.ts`. The agent-level DECLINE escape valve
in Sonnet is a separate session.

---

## 1. Type Changes (`src/types.ts`)

Four new exports added to `ClassificationResult`:

```typescript
export type AthleteTier = 1 | 2 | 3 | 4;
export type TriageDecision = 'PROCESS' | 'DEFER' | 'DROP';

export interface SignificanceSubscores {
  athlete_prominence: number;       // 0-100, deterministic from tier
  information_specificity: number;  // 0-100, Haiku-judged
  event_recency_novelty: number;    // 0-100, Haiku-judged
  content_type_prior: number;       // 0-100, deterministic from content_type
}

export interface SignificanceAssessment {
  raw_score: number;
  sport_multiplier: number;
  composite_score: number;
  triage_decision: TriageDecision;
  athlete_tier: AthleteTier;
  athlete_tier_source: 'lookup' | 'default';
  subscores: SignificanceSubscores;
  rationale: string;  // ≤240 chars, surfaced in logs
}

// ClassificationResult gains:
significance?: SignificanceAssessment;  // present iff is_injury_event === true
```

`significance` is optional (`?`) because we skip scoring when
`is_injury_event` is false — there's nothing to triage.

---

## 2. Scoring Architecture

### Haiku scores 2 of 4 sub-signals; the other 2 are computed in code

| Signal | Source | Rationale |
|---|---|---|
| `athlete_prominence` | Code (tier lookup) | Haiku reliably hallucinates star/depth status for non-stars. Tier is looked up in `data/athlete-tiers.json` before the Haiku call. |
| `content_type_prior` | Code (enum map) | Fully deterministic from `content_type`. |
| `information_specificity` | Haiku (0-100) | Requires reading the source text — LLM judgment is appropriate. |
| `event_recency_novelty` | Haiku (0-100) | Requires comparing to "no update" patterns — LLM judgment is appropriate. |

### Hardcoded weights (change requires code review)

```typescript
WEIGHTS = { prominence: 0.35, specificity: 0.30, recency: 0.20, prior: 0.15 }
TIER_TO_PROMINENCE = { 1: 95, 2: 70, 3: 40, 4: 10 }
CONTENT_TYPE_PRIOR = { BREAKING: 75, TRACKING: 30, DEEP_DIVE: 80, CONFLICT_FLAG: 85 }
```

### Config-driven thresholds (`data/significance-config.json`)

```
raw_score  = Σ(sub-score × weight),  clamped [0, 100]
composite  = raw_score × sport_multiplier,  clamped [0, 100]
```

Decision logic (from `data/significance-config.json`):

| Content Type | PROCESS | DEFER | Notes |
|---|---|---|---|
| Default (BREAKING non-T1) | ≥55 | ≥35 | |
| BREAKING + Tier 1 | ≥45 | ≥30 | Star news is news even if thin |
| TRACKING | ≥70 AND tier ≤ 2 | ≥35 | Biggest noise source; Tier 3 can only DEFER |
| DEEP_DIVE | ≥40 | ≥25 | Lower floor; rare and high-quality |
| CONFLICT_FLAG | always | — | Always PROCESS when validated |

Sport multipliers (April 29, 2026 context):
- NFL offseason (Mar 1–Aug 31): ×0.7
- NFL regular season: ×1.0
- NBA playoffs (Apr 15–Jun 30): ×1.1
- NBA regular season: ×1.0
- Unknown sport: ×1.0 (default)

---

## 3. Athlete Tier Database (`data/athlete-tiers.json`)

**Storage: curated JSON file.** The agents repo has no DB connection of its
own (hard rule). A per-event MCP roundtrip would add a network hop to every
classification. The data is small and changes infrequently.

**Tier assignment:**
- Tier 1: franchise stars, All-NBA/Pro Bowl-caliber, household names
- Tier 2: rotation starters, solid pros — clinically interesting when injured
- Tier 3: default for any athlete not in the file (the long tail)
- Tier 4: explicit depth/practice-squad entries (prevent T3 inflation to T4 athletes)

Only Tiers 1, 2, and 4 are listed. Tier 3 is the default for unknowns.

The v1 seed file contains 20 obvious examples (5 NFL T1, 5 NFL T2, 5 NBA T1,
5 NBA T2) for testing. The full ~200-athlete proposal is in
`docs/athlete-tier-proposals.md` — **pending founder review**. Do not expand
the seed file until the founder has reviewed and approved that list.

**Reload behavior:** Loaded (and cached) at the start of every `pollSport`
cycle. Config edits take effect within 15 minutes without a service restart.
On parse error: log, keep last-known-good cache, never crash the poll loop.

---

## 4. Defer Queue (`src/monitoring/defer-queue.ts`)

**Storage: `web_get_social_state` / `web_set_social_state`** MCP tools — the
same pattern used by `mention-monitor-loop.ts`. No new infrastructure.

**Per-sport keys** (`defer_queue_v1:NFL`, `defer_queue_v1:NBA`, etc.) prevent
write races between parallel sport poll cycles.

### Corroboration mechanics

When a new event arrives with `triage_decision = DEFER`:
1. Check if the same fingerprint is already in the queue.
2. If yes: apply corroboration bonus to `event_recency_novelty`:
   `bonus = min(corroboration_bonus_max, newSourceCount × bonus_per_source)`
   Re-score with the adjusted recency. If new composite ≥ PROCESS threshold → **promote**.
3. If no: add new entry with 6-hour TTL.

**Promotion cap:** 3 attempts per fingerprint. Prevents runaway re-scoring on
persistently noisy athletes.

**TTL eviction:** At the start of each `pollSport` cycle, expired entries are
dropped and logged as `[SignificanceGate] decision=EXPIRE`.

### Fingerprint

```typescript
// <athlete_normalized>:<top-4-content-words-sorted>
"moses moody:patellar-rupture-tendon-torn"
```

Coarse but deterministic. "ACL tear" and "torn ACL" produce the same
fingerprint after stop-word removal and sort. Imperfect; tunable.

---

## 5. Poller Gate (`src/monitoring/poller.ts`)

### Safety valve

`SIGNIFICANCE_GATE_ENABLED=false` env var bypasses the gate entirely. Logs a
loud warning every poll cycle when bypassed — can't be silently forgotten.

### Flow

```
pollSport(sport):
  1. loadSignificanceData()          ← refresh athlete tiers + config cache
  2. evictExpired(sport)             ← TTL cleanup
  3. source.fetchLatestEvents()      ← existing
  4. for each event:
       tierInfo = lookupAthleteTier(name, sport)
       classified = classifyEvent(event, tierInfo)  ← Haiku + significance
       if !is_injury_event: skip
       logGateDecision(sig)          ← [SignificanceGate] INFO line
       if gateEnabled:
         DROP  → summary.dropped_significance++, continue
         DEFER → handleDeferDecision() → 'deferred' or 'promoted'
                 deferred: summary.deferred++, continue
                 promoted: summary.promoted_from_defer++, fall through
       checkForExisting() → dedup (existing)
       processInjuryEvent() → Sonnet (existing)
       publishInjuryPost() (existing)
```

### Log shapes

Per-event INFO:
```
[SignificanceGate] decision=DROP score=27 raw=38 mult=0.70 athlete="Garrett Wilson" tier=2 sport=NFL ct_prior=30 prom=70 spec=25 rec=5
[SignificanceGate] decision=PROCESS score=89 raw=81 mult=1.10 athlete="Donte DiVincenzo" tier=2 sport=NBA ct_prior=75 prom=70 spec=90 rec=90
[SignificanceGate] decision=PROMOTE fingerprint=... athlete="..." sport=NBA from_score=40 to_score=55 sources=2
[SignificanceGate] decision=EXPIRE fingerprint=... athlete="..." sport=NBA deferred_for_h=6.0
```

Per-cycle summary:
```
[Poller] NFL — summary: fetched=12 classified+=8 dropped_sig=5 deferred=2 promoted=1 expired=0 dupes=1 published=1 review=0 skipped=4 errors=0
```

---

## 6. Configuration Split

| Knob | Location | Reason |
|---|---|---|
| Weights (35/30/20/15) | Hardcoded in `significance.ts` | Research-grade — changing them changes score semantics |
| Tier→prominence map | Hardcoded | Same |
| Content-type priors | Hardcoded | Same |
| PROCESS/DEFER thresholds | `data/significance-config.json` | Need tuning in first 2 weeks — hot-reloaded |
| Content-type overrides | `data/significance-config.json` | Same |
| Sport multipliers | `data/significance-config.json` | New sports (PL, UFC) added without code deploy |
| Date windows | `data/significance-config.json` | Annual calendar update — no restart needed |
| Defer TTL, promotion cap, bonus | `data/significance-config.json` | Likely to tune |
| Athlete tier data | `data/athlete-tiers.json` | Data, not policy — separate file |

---

## 7. Observability

All logging via `console.log` with `[SignificanceGate]` prefix — greppable,
no new dependency.

**Calibration constraint:** 40% < drop_rate < 75%. Monitor weekly for first
2 weeks. Adjust thresholds/multipliers/tier list via config edit (no redeploy).

**Key queries on Railway logs:**
```bash
# Drop rate
grep '\[SignificanceGate\] decision=DROP' | wc -l

# Score distribution
grep '\[SignificanceGate\]' | grep -oP 'score=\d+' | sort | uniq -c

# Top dropped athletes
grep '\[SignificanceGate\] decision=DROP' | grep -oP 'athlete="[^"]+"' | sort | uniq -c | sort -rn | head 10
```

---

## 8. Tests

Three test files in `tests/`:

| File | Coverage |
|---|---|
| `significance.test.ts` (43 tests) | `computeRawScore`, `decideTriage` boundaries, `resolveSportMultiplier` windows, `lookupAthleteTier` normalization, `computeFingerprint` paraphrase matching |
| `defer-queue.test.ts` (9 tests) | TTL eviction, new entry creation, corroboration bonus, promotion cap, per-sport key isolation |
| `significance-gate.fixture.test.ts` (6 tests) | All 6 calibration examples from spec (3 DROP, 3 PROCESS) |

All 87 tests pass (`npm test`).

### Calibration fixture results

| Event | Tier | Sport | Mult | Spec | Rec | Composite | Decision |
|---|---|---|---|---|---|---|---|
| Mark Williams foot fracture | 3* | NBA | ×1.1 | 20 | 10 | **30** | DROP |
| Garrett Wilson knee sprain | 2 | NFL | ×0.7 | 25 | 5 | **27** | DROP |
| Calvin Ridley leg surgery | 2 | NFL | ×0.7 | 25 | 20 | **29** | DROP |
| DiVincenzo Achilles | 2 | NBA | ×1.1 | 90 | 90 | **89** | PROCESS |
| Moses Moody patellar tendon | 2 | NBA | ×1.1 | 90 | 90 | **90** | PROCESS |
| Anthony Edwards knee | 1 | NBA | ×1.1 | 55 | 70 | **83** | PROCESS |

*Mark Williams defaults to Tier 3 (not in tier DB).

---

## 9. Risks and Notes

**R1 — Haiku miscalibration:** Prompt includes explicit low/high anchor examples. First-2-week log review is the mitigation.

**R2 — NFL offseason × 0.7 may over-suppress:** If NFL drop rate exceeds 90% in May–August, raise multiplier or narrow the window in `significance-config.json`.

**R3 — Tier seed drift:** Athletes are promoted/demoted each season. Quarterly review of `athlete-tiers.json`. Monthly "top-filtered athletes" log review surfaces miscalibration.

**R4 — CONFLICT_FLAG bypass:** Haiku's prompt explicitly discourages setting CONFLICT_FLAG at classification time. Monitor if CONFLICT_FLAG frequency increases anomalously.

**R5 — Defer queue MCP failure:** On MCP failure, `handleDeferDecision` logs a warning and returns `'deferred'` (conservative). Event is dropped for the cycle; re-evaluated next poll.

**Answered open questions (founder 2026-04-29):**
- Q1: Founder will curate full list; proposals in `docs/athlete-tier-proposals.md`
- Q2: Using v1 date windows; founder will PR adjustments
- Q3: TRACKING Tier 1-2 gate stays hard for v1; revisit after 2 weeks of data
- Q4: Logs only for deferred entries (no admin UI)
- Q5: `SIGNIFICANCE_GATE_ENABLED=false` env var implemented as safety valve
- Q6: Significance internal — not surfaced in published content
