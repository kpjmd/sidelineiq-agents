# NFL Injuries Reference
## SidelineIQ OrthoTriage Master (OTM) — Sport-Specific Intelligence Layer

> **Status:** Session 3 Draft — Pending Physician Founder Sign-Off
> **Scope:** NFL-specific injury prevalence, practice report interpretation, position-group archetypes, and underreported injury flags
> **Integrates with:** SKILL.md (Section 2: RTP Framework, Section 3: NFL Demand Profile), rtp-probability-tables.md

---

## 1. Position Group Injury Prevalence

### 1.1 Clinical Significance Hierarchy

Position groups are organized by biomechanical demand profile. Different contact mechanics, movement patterns, and physical loading explain each group's anatomical vulnerability.

| Position Group | Primary Risk Signal | Key Vulnerability |
|---|---|---|
| Running Back (RB) | Highest injury-per-game rate | Repeated high-velocity contact, cutting, direct collision |
| Defensive Back (DB) | Highest total volume + LE time-loss | Open-field tackling, sprint-deceleration, overhead reach |
| Offensive Line (OL) | Highest total injury count | Repetitive axial loading, high-mass collisions, valgus knee forces |
| Wide Receiver (WR) | Highest soft-tissue strain rate | Explosive acceleration/deceleration, contested catch mechanics |
| Quarterback (QB) | Highest UE + head trauma risk | Sack mechanics, throwing-arm overload, scramble exposure |
| Tight End (TE) | Blended WR/OL exposure | Route running + blocking collision demands |
| Defensive Line (DL) | High repetitive-contact load | Pass-rush mechanics, rip/swim moves, pile-up forces |
| Linebacker (LB) | Multi-vector trauma exposure | Run-fill contact + coverage athleticism demands |

---

### 1.2 Injury Archetypes by Position Group

#### Quarterback (QB)
**Dominant cluster: Upper extremity + head**
- AC joint sprain/separation (direct sack impact, fall mechanics)
- Rotator cuff / labral pathology (throwing-arm overuse, cumulative microtrauma)
- Hand and finger fractures (ball-handling trauma, defensive contact)

*OTM note: QB shoulder injuries warrant conservative RTP estimates regardless of initial severity designation. Throwing mechanics are sensitive to sub-clinical pain and instability. A QB returning "limited" from a rotator cuff injury is not equivalent to a WR returning limited from a hamstring.*

---

#### Wide Receiver (WR)
**Dominant cluster: Lower extremity soft tissue**
- Hamstring strain (Grade 1–2; highest prevalence in position group)
- Ankle sprain / high ankle sprain (cutting, landing mechanics)
- Concussion (contested catch, crossing route exposure)

*OTM note: See Section 3 — Grade 1 hamstring and Grade 1 high ankle sprain in WRs carry outsized RTP uncertainty. The margin between 95% and 100% health is functionally significant at this position. Treat conservatively.*

---

#### Tight End (TE)
**Dominant cluster: Lower extremity structural**
- Knee sprain (ACL/MCL; blocking collision + route-running pivot forces)
- Ankle sprain (contested catch landing, run-blocking mechanics)

*OTM note: TE injury archetypes blend WR and OL exposure patterns. Evaluate based on role — pass-catching TE vs. in-line blocking TE — when context is available.*

---

#### Running Back (RB)
**Dominant cluster: Lower extremity, multi-structural**
- Knee sprain (ACL/MCL; highest per-game rate of structural knee injury)
- Turf toe (first MTP joint hyperextension; see Section 5 — Underreported Injuries)
- Hamstring strain (sprint-load injury, especially late-season)

*OTM note: RBs have the highest injury-per-game exposure of any position. Even Grade 1 RB injuries should be contextualized against their cumulative seasonal load.*

---

#### Offensive Line (OL)
**Dominant cluster: Spine + knee + tendon**
- Lumbar disc herniation (repetitive axial loading, high-mass collision)
- MCL knee sprain (valgus forces from pass-rush engagement)
- Patellar tendon pathology (chronic loading, repetitive squat-stance mechanics)

*OTM note: OL injuries are the most clinically underrepresented in media coverage. Grade 2 OL knee injuries and any OL lumbar pathology with radicular symptoms warrant conservative OTM framing. These players absorb the highest cumulative mechanical load on the roster.*

---

#### Defensive Line (DL)
**Dominant cluster: Knee + shoulder + spine**
- Knee sprain (MCL/meniscus; engagement mechanics, pile-up forces)
- Shoulder labral tear (rip/swim pass-rush mechanics, repetitive overhead load)
- Lumbar spine injury (axial loading similar to OL, but with higher rotational forces)

---

#### Defensive Back (DB)
**Dominant cluster: Lower extremity + shoulder**
- Hamstring strain (open-field pursuit, sprint-deceleration mechanics)
- Ankle sprain (plant-and-cut, contested coverage mechanics)
- Shoulder labral tear (third-ranked; overhead reach in coverage, tackling mechanics)

---

#### Linebacker (LB)
**Dominant cluster: Knee + head + shoulder**
- Knee sprain (ACL/MCL; highest structural knee risk after RB, multi-directional demands)
- Concussion (run-fill contact, zone blitz exposure)
- Shoulder labral tear / dislocation (tackling mechanics, arm-tackle leverage forces)

---

### 1.3 Severity Distribution Skew by Position

Not all Grade 1 injuries carry equivalent uncertainty. Position and injury type interact to determine functional significance.

**Grade 1 injuries with outsized RTP uncertainty:**
- Hamstring strain in WR, DB, RB — the difference between 95% and 100% health is the difference between a productive starter and a liability. Do not treat Grade 1 hamstring in a skill player as a routine low-severity event.
- High ankle sprain (syndesmotic) in WR, RB, DB — syndesmotic injuries disrupt rotational ankle stability, which is disproportionately demanded at skill positions. Grade 1 syndesmotic injuries routinely produce multi-week absences despite initial "minor" framing.

**Grade 2 "swing" category — NFL-wide:**
Grade 2 injuries (partial tears with moderate instability) represent the highest clinical uncertainty tier across all position groups. RTP timelines are genuinely variable and should not be compressed to a single estimate without T1/T2 evidence.

**Grade 2 injuries with known surgical escalation risk:**
- Athletic pubalgia (see Section 5 — frequently escalates to surgery; OTM should flag escalation risk when chronic groin/core symptoms persist beyond expected recovery window)
- Shoulder labral tear in DL, LB, DB — repetitive microtrauma from tackling/pass-rush mechanics accelerates instability; players who return without surgical repair often face progressive functional loss

---

## 2. NFL Injury Report — Practice Participation System

### 2.1 Signal Calibration

NFL practice reports are **noisy proxies for functional status**, not diagnostic instruments. They disclose participation tolerance, not injury severity, mechanism, or imaging findings. Teams have structural incentives to overestimate severity on minor issues (to conceal strategy) and occasionally underestimate severity on significant ones (to preserve trade value or maintain opponent uncertainty).

**OTM treats practice reports as one data layer.** They are not sufficient standalone input for RTP probability generation. Practice participation data is combined with injury type, positional demand, historical recovery curves, and any available clinical reporting before any probability estimate is issued.

---

### 2.2 Practice Participation Designations

| Designation | Abbreviation | Clinical Interpretation |
|---|---|---|
| Did Not Participate | DNP | No functional tolerance for practice; broadest range of clinical significance (true injury limitation → strategic rest) |
| Limited Participation | LP | Partial functional tolerance; most information-rich designation when tracked across the week |
| Full Participation | FP | Full functional clearance for practice; strongest positive signal when reached by Friday |

**Game-status tags:**

| Tag | Interpretation |
|---|---|
| Questionable | ~50% game-day uncertainty per league definition; real signal is highly position- and injury-type dependent |
| Doubtful | High probability of absence; historically plays at <25% rate |
| Out | Confirmed absent |
| IR (standard) | Season-ending; no return pathway in current season |
| IR (Designated for Return) | Administrative placement; earliest eligible return = 4 weeks (see Section 2.5) |
| PUP (Physically Unable to Perform) | Pre-season/early-season designation; ineligible for first 4 regular season games |

---

### 2.3 Practice Trajectory — Primary Signal

**Weekly trajectory is more clinically informative than the final game-status tag.**

The Wed→Thu→Fri practice participation arc is the OTM's primary interpretive framework for NFL injury status. A final "Questionable" tag means materially different things depending on the trajectory that produced it.

#### Decision Tree

**Path 1 — Strong Likely Plays**
- Pattern: DNP or LP Wednesday → LP or FP Thursday → FP Friday
- Interpretation: Consistent functional improvement across the week. Player trending toward full clearance. "Questionable" in this context is largely administrative.
- OTM signal: High confidence plays barring Friday/Saturday downgrade

**Path 2 — Doubtful / High Risk**
- Pattern: DNP Wednesday → DNP or LP Thursday → LP or DNP Friday
- Pattern variant: DNP all three days
- Interpretation: Limited or absent functional tolerance throughout the week. Doubtful designation carries real clinical weight here. No functional progression = genuine uncertainty.
- OTM signal: High risk for absence; OTM should not issue optimistic RTP framing

**Path 3 — Edge Cases (Additional Rules Apply)**

| Edge Case | OTM Rule |
|---|---|
| Late-week downgrade | FP Wednesday/Thursday → DNP or LP Friday = elevated risk signal regardless of final tag. A player who regresses late in the week has demonstrated a functional setback. This pattern is clinically more concerning than a player who was limited all week. |
| Rest / non-injury DNP | Player listed DNP with no injury designation, or with "rest" / "veteran rest day" notation = does not carry injury signal. These players frequently play. OTM should flag as non-clinical DNP and not apply injury-status interpretive rules. |
| Friday / Saturday update | Late-week updates and the final Saturday injury report carry the highest predictive weight. OTM should treat Friday/Saturday LP→FP upgrades as a strong plays signal, and FP→DNP downgrades as a significant red flag. |
| Final inactive list | Gameday inactive declaration is definitive. OTM should update any prior analysis immediately upon inactive confirmation. |

---

### 2.4 Position and Injury-Type Modulation

When a player reaches Path 3 (Edge Cases), position group and injury type provide additional interpretive signal.

**Injury types where "Questionable after limited week" is higher-risk:**
- QB with any shoulder or throwing-hand injury — functional demands are exquisitely sensitive to sub-clinical pain
- WR/RB/DB with hamstring strain — high-speed running demands mean any residual limitation is functionally significant
- Any player with high ankle (syndesmotic) sprain — rotational instability not captured by linear participation tolerance

**Injury types where "Questionable after limited week" carries lower risk:**
- OL with chronic knee or lumbar condition on maintenance protocol (see Section 2.6 — Chronic Management Flag)
- Veteran players with known week-to-week management patterns

---

### 2.5 IR Designation — Differentiated Interpretation

OTM differentiates between two distinct IR designations with different clinical and content implications.

**Standard IR (Season-Ending)**
- No return pathway in the current season
- OTM content: Acknowledge injury, classify tissue type and severity where reportable, provide full-season RTP context (offseason recovery timeline, surgical vs. conservative management framing where applicable)
- Do not generate in-season RTP probability estimates

**IR — Designated for Return ("IR-DTR")**
- Player placed on IR with team designation for potential in-season return
- Administrative minimum: 4 weeks of IR placement before eligibility to return to active roster
- **The 4-week minimum is an administrative eligibility floor, not a clinical or predictive anchor.** It prevents false "could play this week" signals but does not predict when — or whether — the player will actually return.
- OTM rule: Use 4-week minimum as the earliest possible eligibility date. Layer real medical timelines (injury type + historical recovery curves from rtp-probability-tables.md) on top for any probabilistic RTP forecast.
- OTM content: Acknowledge IR-DTR status, classify injury, provide earliest eligibility window, generate RTP estimate anchored to injury biology — not the administrative floor

---

### 2.6 Chronic Management vs. Acute Injury Flag

NFL practice reports do not formally distinguish chronic management from acute injury. OTM infers this distinction from available context.

**Chronic Management (CM) Flag — Indicators:**
- Player with documented multi-season history of the same body part appearing on the injury report
- Near-permanent LP designation with no acute event or game-absence pattern
- "Maintenance," "load management," or "veteran rest" language in reporting
- Player practicing limited mid-week but consistently available (FP Friday, active on game day)

**Acute Injury (AI) Flag — Indicators:**
- New injury report appearance following a specific game event (sack, collision, non-contact mechanism described)
- Downward trajectory (FP → LP → DNP) suggesting functional deterioration
- First-time appearance on injury report for that body part

**OTM Interpretive Rules:**
- A CM-flagged player who remains LP or upgrades to FP by Friday = routine; do not over-signal
- A CM-flagged player who deteriorates (LP → DNP across the week) = legitimate red flag; apply full acute-injury interpretive rules
- An AI-flagged player whose practice trajectory stagnates or worsens = escalate clinical concern in OTM content

*Note: When chronic vs. acute status is ambiguous and clinically significant, OTM should state the ambiguity explicitly rather than defaulting to either flag.*

---

## 3. Playoff Modifier

### 3.1 Reporting Structure

The official NFL injury reporting structure is identical in the postseason. Practice reports (Wed/Thu/Fri) with DNP/LP/FP designations and game-status tags (Questionable/Doubtful/Out) remain the same framework.

### 3.2 Incentive Shift

**Team behavior and player decision-making change materially in the postseason.** The season-ending stakes alter the clinical calculus in predictable ways.

**Playoff-specific OTM rules:**

| Rule | Rationale |
|---|---|
| Chronic issues more likely green-lit | Players and teams accept higher pain tolerance and functional risk when season survival is at stake. A chronic knee or lumbar condition that generated conservative management during the regular season is more likely to be played through in January. |
| Questionable threshold effectively lowered | A "Questionable" tag in the playoffs does not carry the same ~50% uncertainty as the regular season. The historical play-rate for Questionable designees increases in postseason. OTM should not apply standard Questionable uncertainty weighting without noting the playoff context. |
| FP by Friday = strong signal in playoffs | A player who achieves full practice by Friday in a playoff week has a high probability of playing. The FP designation in playoffs carries more weight than the same designation in a Week 10 game. |
| Strategic DNP still exists | Teams still obscure healthy players with strategic DNPs in the postseason, potentially at higher rates given the competitive stakes. Non-injury DNPs require the same scrutiny as regular season. |
| Severity framing adjusted | OTM should acknowledge that players competing through significant injuries in the playoffs may be absorbing clinical risk that will manifest as offseason surgery or extended recovery. This is relevant context for injury analysis, not a reason to suppress the injury designation. |

---

## 4. Systematically Underreported and Misclassified Injuries

These injury types are consistently misrepresented in media coverage. OTM is trained to recognize and correctly classify them regardless of how they appear in reporting.

### 4.1 Turf Toe and Lisfranc Injury

**Media classification:** "Mid-foot sprain," "foot soreness," "sore feet"
**Clinical reality:** Two distinct and often serious injuries

**Turf Toe** (first MTP joint hyperextension injury):
- Affects the plantar plate and sesamoid complex of the great toe
- Grade 1: Mild sprain, often manageable. Grade 2–3: Partial to complete disruption of plantar plate — can be season-altering
- Disproportionately affects RBs and WRs on artificial turf surfaces (forced hyperextension at push-off)
- Frequently underplayed in media due to perceived location ("just a toe")
- OTM flag: Any "turf toe" mention should trigger position-appropriate severity assessment. Grade 2–3 turf toe in a skill player is a legitimate multi-week to season-altering event

**Lisfranc Injury** (tarsometatarsal joint complex disruption):
- Spectrum from ligamentous sprain to frank dislocation/fracture
- High-energy Lisfranc injuries frequently require surgical fixation
- Even "low-grade" Lisfranc sprains produce prolonged RTP timelines due to weight-bearing demands
- OTM flag: Any "mid-foot sprain" in a skill player with extended timeline should raise Lisfranc suspicion. If surgical consultation is mentioned, treat as high-severity

---

### 4.2 Athletic Pubalgia (Sports Hernia)

**Media classification:** "Sports hernia," "groin injury," "core injury," "abdominal strain"
**Clinical reality:** Athletic pubalgia is a distinct clinical entity — a chronic musculotendinous injury at the posterior inguinal wall, not a true hernia

- The "sports hernia" misnomer persists among coaches, media, and fans
- Frequently mismanaged conservatively when surgical repair is the definitive treatment
- In the NFL, commonly affects OL (chronic loading) and QB (rotational core forces)
- RTP after surgical repair: typically 8–12 weeks; conservative management can produce prolonged cycles of partial improvement and re-injury
- OTM flag: Any player with chronic, recurrent groin/core symptoms across multiple weeks should be flagged for potential athletic pubalgia, with note that conservative management has poor long-term outcomes if the diagnosis is correct

---

### 4.3 Concussion — Underreporting Patterns

**Clinical reality:** Despite increased scrutiny since the NFL Concussion Settlement era, concussion remains systematically underreported due to structural factors.

**Underreporting mechanisms:**
- Diagnosis requires player self-reporting of symptoms — players have documented incentives to suppress symptoms
- Sideline concussion assessment protocols are not infallible, particularly for high-threshold players who mask symptoms acutely
- Media coverage is position-biased: QB and skill player concussions receive disproportionate coverage; OL concussions are systematically undercovered despite significant exposure

**OTM rules for concussion:**
- Apply CONCUSSION special-case flag (from SKILL.md Section 1)
- No RTP probability estimate generated — acknowledge protocol, follow league concussion protocol timeline
- Do not apply position hierarchy to severity framing: an OL concussion is clinically equivalent to a QB concussion
- If a player is listed with a concussion following a game with documented high-contact event, OTM should note the protocol process and not speculate on timeline until cleared by protocol

---

### 4.4 Stingers (Burner Syndrome) — Repetitive Injury Escalation Flag

**Media classification:** "Stinger," "burner," "neck stinger" — typically dismissed as transient
**Clinical reality:** A single stinger is a brachial plexus traction or compression injury, usually transient. Repetitive stingers are a different clinical entity.

- Single stinger: Transient nerve conduction disruption, typically resolves within minutes to hours. Low clinical concern in isolation.
- **Repetitive stingers: OTM escalation flag** — repeated episodes suggest underlying cervical spinal stenosis, cervical disc pathology, or nerve root vulnerability. This is a potentially serious structural finding.
- Players with repetitive stinger history may face career-altering decisions — the NFL has protocols for evaluating cervical stenosis that can result in disqualification
- Media consistently frames repetitive stingers as routine because each individual episode is transient

**OTM rule:** Any report of a player with a history of multiple stinger episodes — or any stinger disclosure in the context of prior cervical spine concerns — should be escalated from "transient" to potential cervical spine/nerve root pathology. OTM content should note the distinction between isolated and repetitive stinger presentation.

---

## 5. OTM Content Application — NFL-Specific Rules Summary

| Scenario | OTM Rule |
|---|---|
| Practice report analysis | Treat as one data layer; trajectory > final tag; combine with injury type and position before signaling |
| Hamstring Grade 1 in skill player | Flag outsized uncertainty; do not default to low-severity framing |
| High ankle sprain | Syndesmotic injury flag; conservative RTP regardless of initial designation |
| QB shoulder / hand | Conservative framing; functional demands are exquisitely sensitivity-dependent |
| IR — Designated for Return | Note 4-week administrative floor; anchor RTP to injury biology not eligibility date |
| Season-ending IR | No in-season RTP estimate; full-season and offseason recovery context |
| Chronic Management flag | Distinguish from acute injury when inferable; CM player deteriorating = escalate |
| Non-injury / rest DNP | Do not apply injury interpretive rules; these players frequently play |
| Playoff context | Lower Questionable threshold; chronic issues green-lit; FP Friday = strong signal |
| "Mid-foot sprain" | Suspect turf toe or Lisfranc; apply severity-appropriate framing |
| "Sports hernia" / "groin" | Flag athletic pubalgia; note surgical escalation risk for chronic presentations |
| Concussion | CONCUSSION flag; no RTP estimate; no position hierarchy on severity |
| Repetitive stinger | Escalate to cervical spine / nerve root flag; not routine |
| OL injury | Do not underweight; these players absorb the highest cumulative mechanical load |

---

*Reference file drafted Session 3. Pending physician founder sign-off before deployment to `sidelineiq-agents/skills/references/`.*
