# NBA Injuries Reference
## SidelineIQ OrthoTriage Master (OTM) — Sport-Specific Intelligence Layer

> **Status:** Session 3 Draft — Pending Physician Founder Sign-Off
> **Scope:** NBA-specific injury prevalence, load management vs. injury distinction rules, back-to-back and playoff context, seasonal load patterns, and underreported injury flags
> **Integrates with:** SKILL.md (Section 2: RTP Framework, Section 3: NBA Demand Profile), rtp-probability-tables.md

---

## 1. Injury Prevalence and Priority Archetypes

### 1.1 Organizational Framework

The NBA reference file is organized by **injury type rather than position.** Unlike the NFL, today's NBA features significant positional role fluidity — the distinctions between guard, wing, and big are increasingly porous at the roster construction level. Organizing by injury type produces more durable and clinically consistent OTM rules than position-based groupings.

**Epidemiological baseline:**
- Lower extremity injuries account for **62.4% of all NBA injuries** and **72.3% of games missed**
- OTM should weight lower extremity injury content accordingly — this is where clinical signal is densest and where conservative framing most frequently applies

---

### 1.2 Priority Injury Archetypes

The following archetypes represent the OTM's highest-priority recognition targets in NBA injury monitoring.

---

#### Archetype 1 — Lateral Ankle Sprain (High Frequency, High Recurrence)

- Highest-frequency injury in the NBA by raw count
- Individual episodes are often genuinely minor (Grade 1); the clinical concern is **recurrence rate**, which is the highest in the league
- A player with a documented ankle sprain history who re-sprains is not in the same clinical category as a first-time presentation — prior ankle instability accelerates re-injury risk and can produce chronic lateral ankle instability over time
- Media consistently underweights recurrence risk, treating each episode as isolated

**OTM rules:**
- Flag recurrence explicitly in content: "This is not his first ankle sprain — chronic instability is a legitimate concern"
- Do not apply routine low-severity framing to repeat ankle sprains in the same season
- Grade 2+ lateral ankle sprain with documented prior history = conservative RTP framing regardless of team timeline

---

#### Archetype 2 — Patellofemoral Inflammation / Patellar Tendinitis (High Impact, "Silent Season-Killer")

- **#1 cause of games missed in the NBA at 17.5%** — the single highest-impact injury archetype by games lost
- Disproportionately affects high-minute players due to cumulative patellar tendon loading
- Often managed in a chronic, low-visibility pattern: the player misses some games, plays others, is listed as "limited" frequently, and never has a discrete acute event
- Media underweights this archetype because the absence pattern is diffuse rather than dramatic

**OTM rules:**
- Flag patellofemoral/patellar tendon designations as high-impact regardless of individual absence framing
- A player managing patellar tendinitis across a full season is accumulating genuine clinical risk — OTM should note this in recurring coverage
- Any patellofemoral designation in a player averaging 30+ minutes = "silent season-killer" framing is warranted
- Patellar tendinitis that generates a rest absence in October can become a 3-week absence in February without a discrete new injury event

---

#### Archetype 3 — Bone Bruise / Bone Stress Reaction (Red-Flag Archetype)

- **OTM treats "bone bruise" as a red-flag archetype, not a routine contusion**
- Bone bruises (bone marrow edema on MRI) are frequently precursors to stress fractures, particularly at two high-risk NBA sites:
  - **5th metatarsal** (Jones fracture territory — often requires surgical fixation and has high re-fracture risk)
  - **Navicular** (tarsal navicular stress fracture — one of the most serious foot injuries in basketball; RTP is prolonged and re-injury risk is high)
- The media pattern: "bone bruise" reported → player misses 1–2 weeks → returns → re-injures → suddenly "stress fracture" diagnosis
- The clinical pattern: the stress fracture was often present or imminent at the "bone bruise" stage

**OTM rules:**
- Any "bone bruise" designation in the foot, ankle, or knee warrants an explicit OTM flag: *"Bone bruises in this location can be precursors to stress fractures — this designation deserves more scrutiny than a standard contusion"*
- If the bone bruise is at the 5th metatarsal or navicular: escalate to high-severity framing immediately
- See Section 4.2 for the soreness → Out Indefinitely escalation pattern that frequently signals a stress injury diagnosis

---

### 1.3 Severity Skews by Body Region and Player Profile

#### Hand and Wrist — Outsized Significance for Guards and Shooters

- Hand and wrist injuries account for only 4–7% of NBA games missed overall
- However, they carry **outsized functional significance for point guards and shooting guards**, particularly dominant-hand injuries
- A dominant-hand finger sprain in a primary ball-handler or shooter is not a routine low-severity injury — shooting mechanics and ball-handling precision are exquisitely sensitive to finger and wrist function
- OTM should not apply generic hand/wrist framing to guard-position players; apply position-aware severity weighting

**OTM rule:** Dominant-hand finger or wrist injury in a PG/SG = flag functional significance explicitly. Do not default to "minor" framing based on injury type alone.

---

#### Hindfoot and Midfoot "Sprain" — Stress Fracture Suspicion in Large Players

- Hindfoot and midfoot sprains in players **over 6'10" or over 240 lbs** carry elevated stress fracture suspicion
- The navicular in particular is a high-risk stress fracture site in taller, heavier NBA players — the combination of body mass, repetitive impact loading, and limited vascular supply to the central navicular creates a vulnerable biomechanical environment
- Media consistently frames these as "foot sprains" with routine recovery expectations

**OTM rule:** Any hindfoot or midfoot "sprain" designation in a player over 6'10" or 240 lbs should be flagged for navicular stress fracture suspicion. If imaging is mentioned or timeline is extended beyond 2 weeks, escalate framing accordingly.

---

## 2. Load Management vs. Injury — Distinction Framework

### 2.1 The Core Problem

The NBA's load management landscape creates a structural ambiguity that has no direct equivalent in other major sports. Teams routinely rest players under clinical-sounding designations. Since the 2022–23 season, the league requires teams to classify absences as "injury" or "rest," but the reliability of this distinction in practice is limited.

**OTM's operating principle:** Load management and genuine injury are not always distinguishable from external data. OTM should apply signal-based inference rules, communicate confidence levels explicitly, and never fabricate clinical certainty where ambiguity is the honest answer.

---

### 2.2 Load Management Signal Rules

The following signals, individually or in combination, increase OTM's confidence that an absence is load management rather than a genuine acute injury event.

| Signal | Load Management Confidence |
|---|---|
| Single missed game, road trip context | High — single-game road absences are the most common load management pattern |
| "Doubtful" → "Active" in under 24 hours | High — genuine acute injuries do not resolve at this rate; this trajectory is inconsistent with clinical recovery |
| No identifiable in-game event preceding the designation | Moderate-High — acute injuries typically have a discrete mechanism; "soreness" without event = fatigue signal |
| Second leg of a back-to-back (see Section 3.1) | High — the B2B context is the strongest structural amplifier for rest-disguised-as-injury |
| Vague designation language (see Section 2.3) | Moderate — language pattern alone is not sufficient, but combined with other signals elevates confidence |
| Star player, nationally televised game | Low-Moderate — teams sometimes rest stars in marquee games; context-dependent |

---

### 2.3 Euphemism Taxonomy — Clinically Adjacent Load Management Language

Certain designation terms function as de facto load management signals in NBA practice, even when filed under "injury." OTM should recognize these patterns.

**"Knee/Heel/Back Soreness" (without in-game event)**
The classic load management signal. When soreness at a chronic-load site (knee, heel/Achilles, lumbar) is not tied to a specific in-game event — a collision, a fall, a visible mechanism — it is typically a fatigue-management signal, not an acute injury.
- *OTM framing: "Listed with knee soreness — no in-game event reported. This reads as a load management decision."*

**"Injury Management"**
The league-approved explicit load management language. When a team files "injury management" as the designation, they are acknowledging an underlying condition while indicating the immediate absence is a rest call, not an acute event.
- *OTM framing: Acknowledge the underlying condition context, signal that the absence is managed rest.*

**"Non-Displaced Fracture" / "Stress Reaction"**
These are the clinically legitimate load management designations — real pathology that justifies enforced rest the league cannot penalize. A stress reaction is not a break yet, but it is the medical rationale for a 2–3 week absence that looks like load management from the outside.
- *OTM framing: Do not dismiss. Stress reactions are a yellow flag on the stress fracture continuum. See Section 4.2.*

---

### 2.4 Chronic Condition Ambiguity — The Blurry Line Protocol

Some NBA players carry chronic conditions (patellar tendinopathy, plantar fasciitis, lumbar disc pathology) that generate both genuine injury absences and load management absences across a full season. The line between the two is sometimes genuinely ambiguous even clinically.

**Acute:Chronic Load Ratio (Conceptual Framework)**
A precise acute:chronic load ratio (comparing 7-day load to 28-day rolling average) would be the ideal signal — a ratio >1.5x suggests preventative management; a ratio <0.8x with a soreness designation suggests an acute flare. However, OTM typically lacks access to real-time minute-load data at the granularity required to apply this ratio mechanically.

**OTM practical rule for chronic condition ambiguity:**
- When a player has a documented chronic condition (e.g., patellar tendinopathy, Achilles tendinopathy) and a new absence occurs without a discrete in-game event: **OTM attests to the ambiguity explicitly**
- Do not force a classification. Communicate uncertainty as clinical information, not a limitation.
- *Example framing: "Listed again with patellar tendon soreness — with his history, it's genuinely unclear whether this is a managed rest day or a flare in an underlying condition that's been tracking all season. Either way, the cumulative pattern warrants attention."*

---

## 3. Back-to-Back and Playoff Context

### 3.1 Back-to-Back Rules — The 1 PM Rule

Back-to-back games represent the NBA's highest-frequency load amplifier. The second leg of a B2B is the most common context for rest-disguised-as-injury designations.

**The 1 PM Rule:**
For the second leg of a back-to-back, teams must submit injury reports by 1 PM local time. If OTM detects a player added to the injury report **only for the second leg** of a B2B with a vague "soreness" or non-specific designation:

> **Encode 90% Rest confidence.** Frame as load management in OTM content unless a specific in-game event from the previous night's game is documented.

**B2B context rules:**

| Scenario | OTM Rule |
|---|---|
| Player added to B2B leg-2 report only, vague soreness | 90% Rest confidence; load management framing |
| Player with documented in-game event on leg-1 (e.g., visible ankle roll, collision) added to leg-2 report | Genuine injury signal; apply standard injury assessment |
| Star player added to B2B leg-2 report, national broadcast | Load management confidence elevated; note broadcast context |
| Player with chronic condition added to B2B leg-2 report | Apply Section 2.4 chronic ambiguity protocol; B2B amplifies load management probability |

---

### 3.2 Playoff Modifier

NBA playoff incentive structure shifts player and team behavior materially, paralleling the NFL postseason modifier.

**Core rule: Once it is May, "Questionable" = effectively "Probable."**

Players competing in the NBA playoffs will accept clinical risk they would not accept in March. The threshold for sitting out increases substantially.

**Playoff-specific OTM rules:**

| Rule | Rationale |
|---|---|
| OTM only predicts sit-out in playoffs if designation is Doubtful or Out | Questionable in playoff context carries a high plays-rate; do not apply regular-season uncertainty weighting |
| Chronic issues effectively green-lit | Patellar tendinopathy, ankle instability, and lumbar soreness that generated missed games in the regular season are unlikely to sit a player in May without escalation |
| Load management disappears | B2B rules and rest-signal inference do not apply in the playoffs; no team is resting stars in a playoff game |
| Injury severity framing adjusted | OTM should acknowledge when players are visibly competing through injury in the playoffs — this is relevant clinical context for the audience and sets up offseason recovery narratives |
| Post-game escalation monitoring | Playoff injuries that are downplayed in the moment frequently escalate to surgical announcements in the offseason. OTM should note when a playoff-context injury warrants offseason follow-up. |

---

## 4. Seasonal Load Patterns and Volume Context

### 4.1 Time-of-Season Injury Patterns

The NBA's 82-game regular season produces predictable injury clustering that OTM should incorporate as contextual signal.

**December / January — Soft Tissue Peak**
- Hamstring strains and calf strains peak in this window
- Mechanism: cumulative fatigue of the first 30+ games without sufficient recovery adaptation
- A hamstring or calf designation in December/January carries more clinical weight than the same designation in October — the seasonal load context is relevant
- OTM should note when an injury occurs within this window: *"December soft-tissue injuries reflect cumulative load — these can linger if not managed carefully"*

**April — Dual-Signal Month**

April injury and absence patterns require team-context interpretation before OTM applies standard injury framing.

| Team Context | April Absence Signal |
|---|---|
| Bottom-tier team (lottery positioning) | High probability of competitive tanking / planned star rest. An April "calf strain" on a 20-win team is not the same clinical event as the same designation on a 50-win team. |
| Top-tier team (playoff seeding) | Pre-playoff buffering. Teams protecting stars from unnecessary injury risk before the postseason. Load management confidence elevated. |
| Bubble team (play-in positioning) | Genuine competitive context; injury designations carry standard signal weight |

**OTM rule:** Check team standing context before applying standard injury framing to April soft-tissue designations. State the contextual read explicitly in content.

---

### 4.2 The Bone Stress Escalation Pattern — Underreported Injury Flag

The NBA's most clinically significant underreported injury pattern follows a recognizable escalation arc:

**Stage 1:** Player listed with "knee soreness," "foot soreness," or "ankle soreness" for 2–3 consecutive games. No discrete in-game event. Media frames as load management or minor issue.

**Stage 2:** Player's absence extends. Designation shifts to "day-to-day" or vague "lower leg" language.

**Stage 3:** "Out Indefinitely" announcement. Shortly after: stress reaction or stress fracture diagnosis confirmed.

> **OTM Stress Injury Warning Flag:** Persistent "soreness" at the same anatomical site across 3 or more consecutive games should trigger a stress injury warning, not routine rest framing. The soreness → Out Indefinitely escalation pattern is a known clinical arc for bone stress injuries in the NBA.

**High-risk anatomical sites for this pattern:**
- Foot (5th metatarsal, navicular) — see Section 1.2, Archetype 3
- Tibia (tibial stress reaction/fracture)
- Knee (femoral condyle, tibial plateau bone bruise → stress fracture)

**OTM rule:** Three or more consecutive game absences or designations at the same site, escalating from soreness to extended absence, should be flagged explicitly: *"This pattern — persistent soreness at the same site without a discrete event — is consistent with a bone stress reaction. The 'Out Indefinitely' designation suggests imaging may have revealed more than initially disclosed."*

---

## 5. OTM Content Application — NBA-Specific Rules Summary

| Scenario | OTM Rule |
|---|---|
| Lateral ankle sprain, repeat presentation | Flag chronic instability risk; do not treat as isolated minor event |
| Patellar tendinitis, high-minute player | "Silent season-killer" framing; note cumulative risk regardless of individual absence |
| Bone bruise, foot/ankle/knee | Red-flag archetype; note stress fracture precursor risk explicitly |
| Bone bruise at 5th metatarsal or navicular | Escalate to high-severity framing immediately |
| Hand/wrist injury, PG or SG | Apply guard-position functional significance; do not default to minor framing |
| Hindfoot/midfoot "sprain," player >6'10" or >240 lbs | Flag navicular stress fracture suspicion |
| Single missed game, road context | Load management signal; apply high Rest confidence unless in-game event documented |
| Doubtful → Active in <24 hours | Inconsistent with genuine acute injury; flag as load management |
| "Soreness" without in-game event | Fatigue/load management signal; apply euphemism taxonomy |
| "Injury Management" designation | League-approved load management language; frame accordingly |
| "Stress Reaction" designation | Do not dismiss; stress fracture continuum; conservative framing |
| B2B leg-2, vague soreness, no prior event | 1 PM Rule applies; 90% Rest confidence |
| Chronic condition, ambiguous absence | Attest to ambiguity explicitly; do not force classification |
| Playoff context (May) | Questionable = Probable; only predict sit-out at Doubtful or Out |
| Persistent same-site soreness 3+ games | Stress injury warning flag; not routine rest signal |
| Soreness → Out Indefinitely escalation | Bone stress reaction / stress fracture flag; note pattern explicitly |
| April absence, bottom-tier team | Apply tanking/rest context before injury framing |
| April absence, top-tier team | Pre-playoff buffering context; load management confidence elevated |
| December/January soft tissue injury | Note seasonal load context; cumulative fatigue framing warranted |

---

*Reference file drafted Session 3. Pending physician founder sign-off before deployment to `sidelineiq-agents/skills/references/`.*
