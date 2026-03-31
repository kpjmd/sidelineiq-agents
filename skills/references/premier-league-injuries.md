# Premier League Injuries Reference
## SidelineIQ OrthoTriage Master (OTM) — Sport-Specific Intelligence Layer

> **Status:** Session 3 Draft — Pending Physician Founder Sign-Off
> **Scope:** PL-specific injury prevalence, fixture congestion context, international duty handling, pitch condition modifiers, and underreported injury flags
> **Integrates with:** SKILL.md (Section 2: RTP Framework, Section 3: PL Demand Profile), rtp-probability-tables.md

---

## 1. Information Environment — PL vs. NFL/NBA

The Premier League operates with significantly less structured injury disclosure than either the NFL or NBA. There is no formal weekly injury report system. Injury information flows through manager press conferences (low reliability), club official communications (sparse), and training ground observation (highest reliability when available).

**OTM's operating principle for PL content:** Clinical specificity will frequently be unavailable. OTM should communicate what is known, flag what is inferred, and state information gaps explicitly rather than fabricating diagnostic certainty. Confidence levels should be stated in PL content more often than in NFL or NBA content.

**PL information reliability hierarchy (highest to lowest):**
1. Training ground footage and credible social media sightings of player in training
2. Club official injury communications (rare but authoritative when issued)
3. Physio/medical staff leaks via beat reporters
4. Manager press conference quotes — **treat as lowest-reliability signal by default**

---

## 2. Injury Prevalence and Priority Archetypes

### 2.1 Organizational Framework

The PL reference file is organized by **injury type with a load-profile modifier.** Given significant tactical role fluidity in modern PL football, position alone is an unreliable primary organizational axis. Instead:

- **Injury type** is the primary organizational layer
- **Load profile** (high-speed running volume, sprinting demands by role) functions as a modifier that adjusts RTP conservatism and re-injury risk on return
- **Role-based re-injury risk** is calculated on return: a winger returning from a hamstring strain faces materially higher re-injury risk than a center back returning from the same Grade classification, because their role demands sustained top-end sprinting that a center back can compensate around

---

### 2.2 Priority Injury Archetypes

#### Archetype 1 — Hamstring Strain (Highest Volume)

- **~40% of all PL muscle injuries** — the single highest-volume soft tissue archetype
- Driven by high-speed transition play: counter-attacks, defensive recovery sprints, pressing triggers
- PL-specific mechanism: the intensity and frequency of high-speed running in modern pressing systems creates a chronic hamstring loading environment that differs from American sports

**Load-profile modifier — Role-based RTP conservatism:**

| Role | Sprinting Demand | RTP Conservatism |
|---|---|---|
| Winger / Wide Forward | Maximal — game built on top-end speed bursts | High — even Grade 1 "twinge" warrants conservative framing; 95% health ≠ 100% health at this position |
| Fullback | High — overlapping runs, defensive recovery | High — similar to winger; sprinting volume is a core positional demand |
| Striker | Moderate-High — explosive bursts, but less sustained | Moderate — positional compensation possible at partial fitness |
| Central Midfielder | Moderate — high total distance but lower top-end sprint volume | Moderate — less top-end speed dependency |
| Center Back | Lower — positional play can compensate for speed deficit | Lower — CB can "position" through a hamstring recovery where a winger cannot |

**OTM rule:** Do not apply uniform RTP framing to hamstring strains across positions. A winger's Grade 1 hamstring is a materially different clinical event than a center back's Grade 1 hamstring. State the role-based modifier explicitly in content.

**Recurrence flag:** Hamstring re-injury in the same season = escalate framing. Repeat hamstring strain is not a routine event — it signals incomplete biological recovery, premature return, or underlying structural vulnerability.

---

#### Archetype 2 — Adductor / Groin Strain ("The Footballer's Injury")

- The defining soft tissue injury of football — constant change of direction, kicking mechanics, and lateral loading create chronic adductor stress
- Often underreported in severity: "groin tightness" or "adductor strain" language frequently obscures a spectrum from Grade 1 strain to early athletic pubalgia (see Section 6.2)
- Central midfielders are disproportionately affected due to 360-degree movement demands and constant pivoting

**OTM rules:**
- Any "groin" or "adductor" designation that persists beyond 2 weeks without a clear return trajectory should trigger an athletic pubalgia flag (see Section 6.2)
- Adductor injuries in central midfielders warrant conservative framing given the positional demand for rotational loading
- Distinguish between acute kicking-mechanism adductor strain and chronic groin pain without discrete event — the latter is a load management / athletic pubalgia signal

---

#### Archetype 3 — Ankle Syndesmosis (High-Intensity Tackle Mechanism)

- **Mechanism:** High-intensity tackles and "studs caught in turf" moments — forced external rotation of the planted foot
- Syndesmotic (high ankle) sprains are frequently undergraded at initial assessment in the PL context, where "ankle sprain" language does not distinguish lateral from syndesmotic injury
- Syndesmotic injuries disrupt the tibiofibular joint complex; RTP timelines are materially longer than lateral ankle sprains of equivalent subjective severity

**OTM rules:**
- "Ankle sprain" in the context of a high-intensity tackle or awkward landing should prompt syndesmosis suspicion, particularly if the player is non-weight-bearing immediately post-injury
- If the club reports a timeline of >3 weeks for an "ankle sprain," OTM should flag syndesmotic involvement as likely
- Apply conservative RTP framing to all PL ankle sprains until lateral vs. syndesmotic distinction is confirmed

---

#### Archetype 4 — Knee (ACL / MCL) (Highest Days-Lost Impact)

- Lower volume than NFL knee injuries, but **highest days-lost impact per injury event** in the PL
- ACL injuries in football typically occur via non-contact deceleration/rotation mechanism rather than direct impact — plant-and-cut, landing from a header, sudden change of direction
- MCL injuries more commonly involve direct contact (tackle mechanism)
- OTM should treat any confirmed ACL injury as a season-ending event with 9–12 month RTP framing as baseline

**OTM rules:**
- Non-contact knee injury mechanism (no opposing player contact visible) = ACL suspicion flag, particularly in deceleration or landing context
- "Knee ligament" language without further specification = conservative framing until imaging confirmed
- MCL Grade 1–2: variable RTP; apply standard tissue-type framework from rtp-probability-tables.md
- ACL: season-ending flag; no in-season RTP estimate

---

#### Archetype 5 — Calf / Soleus Strain ("The Veteran's Curse")

- High recurrence rate — among the most notoriously unpredictable RTP injuries in football
- Soleus (deep calf) injuries are particularly problematic: they are frequently underdiagnosed as "calf tightness" because they do not produce the acute, dramatic presentation of a gastrocnemius tear
- Disproportionately affects players in their late 20s and 30s — cumulative tendon and muscle fiber changes increase vulnerability
- The "veteran's curse" pattern: player returns from calf strain, plays 1–2 games, re-injures

**OTM rules:**
- Any calf injury in a player aged 28+ warrants conservative framing regardless of initial severity designation
- Calf re-injury in the same season = significant escalation flag; do not apply standard recovery timeline
- "Calf tightness" without discrete mechanism in a high-minute veteran = soleus involvement suspicion; timelines are longer than gastrocnemius strain
- OTM should note the re-injury risk explicitly when a veteran player returns from calf injury: *"Calf injuries at this stage of a career carry meaningful re-injury risk — the RTP timeline matters less than whether the underlying tissue has fully recovered"*

---

### 2.3 Goalkeeper — Position-Specific Archetypes

Goalkeepers represent a sufficiently distinct physical demand profile to warrant separate notation despite the injury-type organizational framework.

- **Hand / Finger injuries:** High frequency; diving save mechanics produce finger hyperextension and distal phalanx fractures. Analogous to MLB catchers in cumulative exposure.
- **Shoulder (Rotator Cuff):** Diving and landing mechanics load the rotator cuff differently from outfield players. Rotator cuff pathology in goalkeepers tends to be cumulative rather than acute.
- **OTM note:** Goalkeeper hand/finger injuries are systematically underreported in media because goalkeepers frequently play through them. Any goalkeeper listed with a hand or shoulder designation should be flagged — these players have limited capacity to compensate around upper extremity dysfunction in the way outfield players can compensate around minor lower extremity issues.

---

## 3. Fixture Congestion Context

### 3.1 Congestion Threshold and Load Flag

The Premier League's fixture calendar — incorporating league, FA Cup, League Cup, and European competition — can produce schedule densities with no American sport equivalent. The sports science literature defines "congested" as **less than 72 hours between matches.**

**OTM Congestion Flag — Trigger Criteria:**
> Player has accumulated **>180 minutes of playing time within a 7-day window**

When this threshold is met, all subsequent injury designations within that window or immediately following it should be interpreted through a congestion load context.

---

### 3.2 Fatigue-Induced Injury Classification

Injuries occurring in the **final 15 minutes of the 3rd match in a 7-day window** should be classified as **Fatigue-Induced** rather than standard acute impact injuries.

**Clinical significance of Fatigue-Induced classification:**
- Fatigue-induced soft tissue injuries (hamstring, adductor, calf) correlate with longer biological recovery than acute impact injuries of equivalent grade
- Neuromuscular fatigue at time of injury means the surrounding tissue is also compromised — not just the primary injury site
- Recovery timeline estimates should be adjusted upward from standard grade-based RTP tables when Fatigue-Induced flag applies

**OTM content framing:**
*"This injury occurred late in [Club]'s third match in seven days — the Fatigue-Induced context matters. These soft tissue injuries tend to run longer than the initial grade suggests."*

---

### 3.3 Midweek European Fixture Rule

Midweek European competition (Champions League, Europa League, Europa Conference League) — particularly away fixtures — introduces compounding recovery factors beyond simple fixture density:

- Travel fatigue (long-haul or Eastern Europe away trips)
- Circadian rhythm disruption
- Higher psychological load in knockout/group stage competition
- Compressed preparation window for the subsequent weekend PL fixture

**OTM Rule — The 48-Hour Rehab Window:**
> If a player is injured in a **Thursday Europa League away fixture** (or any European away match with <72 hours to the next PL kickoff), OTM applies injury-classification-specific RTP probabilities for the subsequent weekend PL match. The absence of a 48-hour rehab window is itself a clinical constraint that modifies — and in most cases eliminates — RTP probability.

The hamstring inflammatory cascade does not peak until 24–48 hours post-injury. A player returning into peak inflammation risks immediate Grade II or III escalation. Injury type determines how absolute this constraint is.

| Injury Classification | RTP % (<48hr Window) | Rationale |
|---|---|---|
| Muscle strain (MYO) | 0% | Inflammatory cascade peaks at 24–48 hours; return into peak inflammation = Grade II/III escalation risk |
| Ligament sprain (LIG) | 10% | Structural sprains highly unlikely to clear; Grade I lateral ankle sprain is the only realistic exception, and remains high-risk |
| Contusion (impact, no structural disruption) | 30% | No equivalent inflammatory cascade; soft tissue contusion can be managed with treatment and may allow return |
| Bone bruise / stress reaction (BON) | 0% | Compressed window compounds stress injury risk; ground-reaction forces in match play are contraindicated |
| Unclassified "knock" / insufficient data | 15% | Conservative default when mechanism and tissue type are unconfirmed; PL clubs use vague language deliberately |

**OTM classification rule:** Apply SKILL.md tissue-type taxonomy first. Then apply the window-appropriate RTP percentage from the table above. Do not default to 0% across all injury types — but do not exceed these thresholds without confirmed imaging and club medical clearance language.

*Example: A player reported with a "hamstring strain" in a Thursday Europa League away match cannot realistically return Sunday — 0% RTP applies. A player reported with a "dead leg" (contusion) from a collision in the same match carries a 30% RTP signal for Sunday, conditional on no subsequent imaging disclosures.*

---

## 4. Managerial Opacity — Information Handling Protocol

### 4.1 The PL Press Conference Problem

PL managers operate with minimal obligation to disclose injury specifics. Press conference injury language is characteristically vague:
- *"He'll be out for a few weeks"*
- *"We're hopeful he'll be available soon"*
- *"It's not as bad as it first looked"*

These quotes carry limited clinical signal. OTM should not anchor RTP estimates to manager quote language.

### 4.2 Signal Priority Override

**When training ground footage or credible social media sightings of a player in training are available, they override manager press conference framing.**

| Scenario | OTM Rule |
|---|---|
| Player listed "Doubtful" but seen in full training on Friday | Discount manager quote; upgrade availability confidence |
| Player listed "Available" but absent from visible training | Flag discrepancy; do not default to manager optimism |
| No training ground visibility, manager says "a few weeks" | Apply injury-type and grade-based RTP estimate; note information gap |
| Manager historically known for conservative public framing | Note pattern if established; do not overcorrect without corroborating signal |

### 4.3 Manager Coefficient — Future Development

Individual managers vary meaningfully in their historical accuracy and strategic use of injury disclosure. A manager coefficient — weighting press conference quotes by each manager's track record of accuracy — is a viable future enhancement. When sufficient historical data is available, OTM could discount quotes from managers with documented patterns of strategic opacity and weight quotes from managers with more reliable disclosure histories.

*Current state: OTM treats all PL manager quotes as low-reliability by default until manager-specific historical data is encodable.*

---

## 5. International Duty — Information Blackout Protocol

### 5.1 International Injury Handling

When a player sustains an injury while on international duty, OTM should flag an **Information Blackout** period. The club medical staff typically has limited real-time access to the player, receives incomplete information from the national team's medical personnel, and requires their own independent assessment upon the player's return before clearing him for club training.

**OTM Rule — International Injury RTP Adjustment:**
> Add **+3 to +5 days** to the standard RTP estimate for any injury reported during an international window.

This adjustment reflects:
- Club medical staff insisting on independent imaging and functional assessment upon return
- Travel and recovery time from the international camp
- Delayed access to the treating physician's clinical notes and imaging

**OTM content framing:**
*"Reported injured on international duty — club medical staff will conduct their own assessment on return. Add several days to any RTP estimate until the club issues their own update."*

---

### 5.2 Post-Tournament Muscle Tear Risk

Players who participate deep into major international tournaments (World Cup knockout rounds, Euros semi-finals and beyond) return to club football with elevated soft tissue injury risk in the weeks immediately following the tournament.

**OTM Rule — Post-Tournament Risk Window:**
- Flag players who played **deep into a World Cup or European Championship** (semi-finals onward) as elevated risk for muscle tears in the subsequent **October–November** club season window
- This risk is driven by compressed pre-season preparation, residual fatigue from tournament-level intensity, and inadequate recovery between tournament conclusion and domestic season commencement
- OTM should note this context when covering soft tissue injuries for flagged players in the risk window: *"He played deep into the summer tournament — elevated soft tissue risk in this early-season period is consistent with the post-tournament fatigue pattern"*

---

## 6. Pitch Conditions and Environmental Context

### 6.1 Winter Pitch Condition Modifier

Modern PL pitches use **Desso GrassMaster** construction (97% natural grass, 3% synthetic fibers), which provides a consistent surface throughout most of the season. However, low winter temperatures materially affect playing surface properties in ways that increase injury risk.

**November–February: Hard Ground / Frost Window**
- Low temperatures reduce pitch "forgiveness" — the surface becomes harder and less energy-absorbent
- Ground-reaction forces at foot-strike increase, elevating loading at the ankle and knee
- Ankle and knee impact injuries during this window carry higher intrinsic severity than equivalent-mechanism injuries on summer-condition pitches

**OTM Severity Multiplier — Winter Impact Injuries:**
> For impact injuries (ankle sprain, knee sprain, bone bruise) occurring during the **November–February window**, apply an elevated severity multiplier to account for increased ground-reaction forces.

*OTM content framing: "The hard winter pitch conditions add context here — ground-reaction forces in these temperatures are meaningfully higher, which can turn what looks like a routine ankle sprain into something more significant."*

---

## 7. Underreported and Misclassified Injuries

### 7.1 Athletic Pubalgia ("Sports Hernia")

**PL classification:** "Groin strain," "general soreness," "abdominal tightness," "groin management"
**Clinical reality:** Athletic pubalgia — chronic musculotendinous injury at the posterior inguinal wall — is as systematically misrepresented in PL media as in the NFL

- The pattern: player reported with groin soreness → conservative management → partial returns → regression → suddenly unavailable for surgery
- Central midfielders and fullbacks are disproportionately affected
- "Groin strain" persisting beyond 3–4 weeks without clear MRI findings = athletic pubalgia flag
- RTP after surgical repair: 8–12 weeks (consistent with NFL reference)

**OTM rule:** Chronic, recurrent groin designation across multiple weeks without a clear return trajectory should trigger explicit athletic pubalgia flag. Note that conservative management of true athletic pubalgia has poor long-term outcomes.

---

### 7.2 Lumbar Neuropraxia Misclassified as Hamstring Strain

**PL classification:** "Hamstring strain," "recurring hamstring issue," "hamstring tightness"
**Clinical reality:** Lumbar disc pathology or sciatic nerve irritation producing referred pain and weakness in the hamstring distribution — not a primary hamstring injury

- **Red flag pattern:** Player has recurring hamstring designation across multiple seasons, imaging does not show clear primary hamstring pathology, conservative hamstring management produces incomplete or temporary relief
- The hamstring receives its neural innervation from the sciatic nerve (L4–S3); lumbar disc herniation or piriformis irritation can produce hamstring-distribution symptoms indistinguishable from primary muscle strain on clinical examination alone
- OTM cannot diagnose this distinction from public data, but can flag the pattern

**OTM rule:** Any player with **recurring hamstring designations across 2+ seasons without clear structural MRI findings** in public reporting should carry an OTM flag for potential lumbar/sciatic involvement. *"A hamstring injury that keeps coming back without a clear structural explanation is worth watching — lumbar spine involvement is a clinical possibility that changes the RTP picture entirely."*

---

### 7.3 Christmas Period "Minor Knocks" — Rotation and Rest Signals

**The PL December fixture cluster** (typically 5–7 matches between late November and early January) generates a documented spike in minor injury designations. OTM should apply dual-signal interpretation during this window.

**Legitimate injuries:** Genuine fatigue-induced soft tissue events driven by fixture congestion — the December cluster is the most compressed period of the PL calendar and produces real clinical load

**Rotation / rest signals:** Some minor injury designations in December are used by managers to justify star player rotation or enforced rest without disclosing tactical decisions publicly

**Yellow card accumulation context:** A player reaching their 5th yellow card accumulation threshold in early December faces an automatic one-match suspension — typically falling in a late December fixture. OTM should cross-reference injury designations with suspension status. A "minor knock" immediately preceding a suspension-triggered match is a meaningful signal that the injury designation is a cover for an enforced absence.

**OTM rule for December minor injuries:**
- Check suspension status before applying injury framing
- Check team fixture congestion context (Section 3.1)
- Check team's league position — rotation is more common at both ends of the table in December
- State the ambiguity explicitly when context is mixed: *"Listed with a minor knock — in December, these designations are worth watching before assuming genuine injury."*

---

## 8. OTM Content Application — PL-Specific Rules Summary

| Scenario | OTM Rule |
|---|---|
| Manager press conference injury quote | Lowest-reliability signal; anchor to injury type and grade, not quote language |
| Player seen in training, listed doubtful | Training ground signal overrides manager quote; upgrade confidence |
| Hamstring strain, winger or fullback | High conservatism; role-based load modifier applies; not equivalent to CB hamstring |
| Hamstring strain, recurrent (2+ seasons) | Flag lumbar/sciatic involvement if no clear structural MRI findings in public record |
| Adductor/groin beyond 2 weeks, no clear return | Athletic pubalgia flag; note surgical escalation risk |
| Ankle sprain, high-intensity tackle mechanism | Syndesmosis suspicion; conservative framing until lateral vs. syndesmotic confirmed |
| Ankle sprain timeline >3 weeks | Syndesmotic involvement likely; flag explicitly |
| ACL injury (any position) | Season-ending flag; 9–12 month RTP baseline |
| Calf/soleus, player aged 28+ | Conservative framing; re-injury risk flag on return |
| >180 minutes in 7 days, new injury | Congestion flag triggered; Fatigue-Induced classification |
| Injury in final 15 min, 3rd match in 7 days | Fatigue-Induced flag; adjust RTP upward from standard grade tables |
| Thursday European away injury, Sunday PL match | 0% RTP Sunday; no 48-hour rehab window exists |
| International duty injury | Information Blackout flag; add +3 to +5 days to standard RTP |
| Post-World Cup / Euros, October–November | Elevated muscle tear risk window; flag for players deep into tournament |
| Impact injury, November–February | Winter severity multiplier applies; harder ground = higher GRF |
| December "minor knock" | Check suspension status, congestion context, and team position before injury framing |
| Yellow card threshold + injury designation | Cross-reference suspension timing; flag if coincidence is high |
| Goalkeeper hand / finger / shoulder | Flag functional significance; limited compensation capacity vs. outfield players |
| "Groin strain" without clear event, 3+ weeks | Athletic pubalgia flag |
| PL information gap (no imaging, vague quote) | State gap explicitly; communicate confidence level in OTM content |

---

*Reference file drafted Session 3. Pending physician founder sign-off before deployment to `sidelineiq-agents/skills/references/`.*
