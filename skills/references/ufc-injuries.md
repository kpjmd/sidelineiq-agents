# UFC / MMA Injuries Reference
## SidelineIQ OrthoTriage Master (OTM) — Sport-Specific Intelligence Layer

> **Status:** Session 3 Draft — Pending Physician Founder Sign-Off
> **Scope:** UFC/MMA-specific injury prevalence, fighting style modifiers, commission suspension taxonomy, weight cut context, short-notice replacement flags, and underreported injury patterns
> **Integrates with:** SKILL.md (Section 2: RTP Framework, Section 3: UFC Demand Profile), rtp-probability-tables.md

---

## 1. The UFC Injury Environment — Framing

The UFC presents a fundamentally different injury landscape than the NFL, NBA, or Premier League. Fighters sustain what amount to **car crash injuries at every event** — acute trauma, fractures, lacerations, and neurological events that would end a team sport athlete's season occur in the normal course of a single bout.

This shapes OTM's entire approach to UFC content:
- The primary clinical domain is **trauma recovery and regulatory compliance**, not load management or soft tissue maintenance
- **State Athletic Commission medical suspensions** are the most reliable objective data signal in the sport — more reliable than fighter statements, manager statements, or promotional communications
- Pre-fight injury information is systematically suppressed; post-fight commission data is involuntary and clinical
- OTM operates in a **higher uncertainty environment** than any other covered sport, and should communicate that uncertainty explicitly

---

## 2. Organizational Framework — Injury Type with Fighting Style Modifier

### 2.1 Structure

The UFC reference file is organized by **injury type**. There are no positions in MMA, but **fighting style** functions as the primary severity and re-injury risk modifier — analogous to the PL's role-based load profile modifier.

**Two primary style modifier axes:**

**Striker**
- Joint exposure: dynamic impact forces, ground-reaction forces from leg kick checks, hand/foot fracture risk from contact with skulls and elbows
- Primary vulnerability: facial trauma, hand/foot fractures, concussion from head movement exchanges
- Lower chronic joint load than grapplers in training, but higher acute trauma exposure per fight

**Grappler / Wrestler**
- Joint exposure: submission hyperextensions, massive isometric loads during wall-and-stall wrestling, repeated slam impact on the canvas and cage
- Primary vulnerability: shoulder (Kimura/armbar), knee (heel hook/kneebar), cervical and lumbar spine (slam accumulation)
- Higher chronic joint and spinal load; injury often accumulates across training camps rather than occurring in discrete fight events

**OTM application:** When injury type is identified, apply the fighter's primary style as a severity and re-injury risk modifier before generating any RTP estimate or content framing.

---

## 3. Priority Injury Archetypes

### 3.1 Facial Lacerations and Soft Tissue (Highest Volume)

- Highest volume of in-cage injuries by raw count
- The primary **OTM signal is fight stoppage risk via doctor stoppage**, not underlying injury severity
- A deep supraorbital laceration can stop a fight regardless of whether the fighter is otherwise undamaged
- Media typically frames lacerations as superficial; OTM should frame them through the lens of vision impairment and doctor stoppage probability

**OTM rules:**
- Laceration over the orbital rim or near the eye = doctor stoppage flag; elevate fight stoppage probability in content
- Post-fight laceration requiring suture repair = flag for potential fight timeline impact (sutures typically removed at 7–10 days; full contact clearance follows)
- Facial soft tissue injuries do not typically generate commission suspensions beyond the standard administrative floor (see Section 5)

---

### 3.2 Fractures — Hand, Foot, Nose ("Combat Fractures")

- **Mechanism:** "Boxer's fractures" (4th/5th metacarpal) from punching skulls or elbows; foot fractures from checking leg kicks; nasal fractures from strikes
- Extraordinarily common relative to other sports — these are expected occupational injuries in striking disciplines
- Hand and foot fractures in fighters are frequently fought through acutely, with surgical management deferred until after the fight

**Fighter style modifier:**
- Strikers: higher hand and foot fracture risk (punch/kick contact mechanics)
- Grapplers: lower acute fracture risk but higher chronic hand/wrist pathology from grip-intensive training

**OTM rules:**
- Post-fight hand or foot fracture disclosure = flag for next fight timeline impact; surgical fixation vs. conservative management drives RTP meaningfully
- Metacarpal fracture requiring fixation: 6–8 week RTP minimum
- Nasal fracture: low clinical RTP impact unless septal deviation requiring surgical correction; flag for completeness but do not anchor matchmaking timeline
- Commission suspension for fractures: typically filed as "180 days pending X-ray clearance" — apply Pending Clearance (TBD) classification (see Section 5.3)

---

### 3.3 Knee (ACL / MCL / Meniscus)

- High volume across both training camp and in-fight contexts
- **Training camp mechanisms:** Wrestling-intensive camps generate significant knee ligament stress; ACL injuries in training are common and frequently force late fight withdrawals
- **In-fight mechanisms:** Heel hook and kneebar submission hyperextension; checked leg kicks producing valgus knee force

**Fighter style modifier:**
- Grapplers/Wrestlers: elevated training camp knee injury risk from submission wrestling; heel hook exposure is style-specific
- Strikers: elevated in-fight knee risk from checked kicks; less training camp grappling exposure

**OTM rules:**
- ACL injury (training or in-fight): season-equivalent flag; 9–12 month RTP baseline
- "180 days pending MRI clearance" commission suspension following a fight with visible knee hyperextension event = ACL/meniscus suspicion; apply Clinical Trigger classification
- Heel hook submission: flag ulnar collateral/knee ligament complex; joint-specific injury call in content
- Kneebar submission: similar joint flag; patellar tendon and ACL stress depending on angle

---

### 3.4 Shoulder — Rotator Cuff and Dislocation

- Heavily prevalent in grapplers — the shoulder is the primary joint at risk in the submission grappling arsenal
- **Primary mechanisms:** Kimura lock (posterior capsule, rotator cuff, potential dislocation), armbar (anterior capsule, biceps tendon, UCL of elbow), canvas posting during takedown defense (AC joint, rotator cuff)

**Fighter style modifier:**
- Grapplers: dominant shoulder injury archetype; every training camp involves thousands of repetitions of shoulder-loading submission defense and offense
- Strikers: lower chronic shoulder load; acute dislocation risk from falls or clinch work

**OTM rules:**
- Armbar submission (fighter taps or is stopped): flag elbow and shoulder complex; mechanism determines which joint is primary
- Kimura submission: flag posterior shoulder and rotator cuff; dislocation possible depending on the force before tap
- "180 days pending MRI clearance" following shoulder submission = Clinical Trigger; most clear in 3–6 weeks if no surgical finding
- Post-fight shoulder disclosure from a grappler = conservative RTP framing; chronic rotator cuff accumulation is often the underlying context

---

### 3.5 Concussion and TBI (Most Critical — Long-Term RTP and Matchmaking)

- The most clinically significant injury category for long-term fighter health, career trajectory, and OTM content
- **Weight class modifier:** Heavier weight classes sustain significantly more head trauma, knockouts, and concussions per fight due to higher striking power; lighter weight classes experience higher-volume limb and joint wear but proportionally less catastrophic head trauma per event

**OTM rules:**
- Apply CONCUSSION special-case flag from SKILL.md Section 1 — no RTP probability estimate generated
- KO suspension is a Hard Block (see Section 5.2) — OTM does not speculate on early return
- Cumulative KO history is a legitimate OTM content angle: a fighter on their third KO loss in 18 months is in a materially different clinical situation than a fighter with their first KO loss
- Micro-concussion accumulation in hard sparring camps is a cumulative narrative OTM should track (see Section 6.2)
- Commission concussion suspensions are treated as objective clinical data, not administrative formality

---

### 3.6 The Wrestler's Spine — Chronic Cervical and Lumbar Disc Pathology

- Grapplers and wrestlers sustain an outsized rate of **chronic cervical and lumbar disc herniations** from repetitive slam impact, cage grinding, and isometric spinal loading across training careers
- This is a **cumulative injury narrative**, not typically an acute event
- Unlike most other injury archetypes, the Wrestler's Spine does not present with a single discrete fight-night mechanism — it accumulates across years of training and competition

**OTM handling:**
- Cover acutely **only when a documented event occurs** — a visible slam KO, a disclosed disc herniation, a commission suspension citing cervical/lumbar pathology
- When a documented acute event occurs in a known grappler with fight history, note the cumulative context: *"For a career wrestler, this isn't a single event — it's the culmination of years of spinal loading. The RTP picture is more complicated than a single disc injury in an athlete without that history."*
- Do not generate speculative cumulative spine content without a clinical anchor event

---

## 4. Short-Notice Replacement Flag

### 4.1 The Truncated Camp Problem

The UFC regularly books short-notice replacement fights when a scheduled fighter withdraws. Short-notice fights are among the highest-risk clinical scenarios OTM encounters in MMA content.

**OTM Flag — Trigger Criteria:**
> Fighter takes a bout with **less than 21 days' notice**

A full training camp typically runs 8–12 weeks. A fighter entering a bout with <21 days notice has:
- No full sparring taper (elevated acute injury risk from incomplete fight preparation)
- Compressed or incomplete weight management descent (elevated dehydration and AKI risk)
- Potentially no specific game-plan preparation for the opponent

**Short-notice risk profile:**

| Risk Category | Mechanism | OTM Signal |
|---|---|---|
| Dehydration / AKI | Compressed weight cut timeline; no gradual descent | Elevated; flag in pre-fight content |
| Early-round fatigue | No full camp conditioning; incomplete gas tank | Elevated; note in performance framing |
| Concussion vulnerability | Incomplete sparring taper + potential dehydration-driven CSF reduction | Elevated; apply weight cut modifier if applicable |
| Acute injury risk | No gradual load increase in camp; body not fight-ready | Elevated |

**OTM content framing:**
*"[Fighter] is stepping in on short notice — less than 21 days to prepare. Truncated camps carry real clinical risk: compressed weight cuts, incomplete conditioning, and a body that hasn't gone through a proper sparring taper. This is a high-variance situation beyond the matchup itself."*

---

## 5. State Athletic Commission — Suspension Taxonomy

### 5.1 Commission Data as Objective Ground Truth

State Athletic Commission medical suspension records are the **most reliable injury data signal available in UFC/MMA coverage.** Commission post-fight medical exams are:
- **Involuntary and clinical** — fighters cannot opt out
- Signed under penalty of perjury — while pre-fight underreporting is common, post-fight commission findings carry legal weight
- Specific to documented findings — "fractured orbital" in a commission record overrides a manager saying "he's fine, just a scratch"

**OTM hierarchy for UFC injury data:**
1. Commission medical suspension records — **objective ground truth**
2. Post-fight fighter disclosures (voluntary, but post-outcome so financial suppression incentive is reduced)
3. Promotional communications — treat with moderate skepticism
4. Pre-fight fighter/camp statements — **lowest reliability; do not anchor OTM analysis**

*The commission blind spot:* Fighters may underreport symptoms at the pre-fight medical exam to avoid being pulled from the bout. The post-fight exam is the reliable clinical touchpoint, not the pre-fight screening.

---

### 5.2 Commission Suspension Classification Framework

| Finish Type | Standard Suspension | OTM Classification | RTP Anchor |
|---|---|---|---|
| KO (loss of consciousness) | 60 days no competition / 45 days no contact | **Hard Block** | RTP ≥60 days; no early clearance pathway; legal license block |
| TKO (strikes) | 30 days no competition / 21 days no contact | **Hard Block** | RTP ≥30 days |
| Submission — Choke | 7–14 days mandatory rest | **Soft Block** | Administrative floor; zero clinical concern for RTP |
| Submission — Joint Lock | 180 days pending MRI/X-ray clearance | **Clinical Trigger** | OTM status: "Pending Clearance (TBD)"; flag specific joint; most fighters clear in 3–6 weeks post-swelling |
| Decision — Hard Fight | 30 days no competition | **Fatigue Trigger** | High probability of unreported soft tissue damage; RTP ≥30 days but clinical picture may be more complex |

---

### 5.3 Suspension Type Interpretation Rules

**Administrative Floor (≤30 days, no specific clinical finding)**
Suspensions of 30 days or less with no specific clinical finding documented represent a mandatory rest period issued to every fighter regardless of damage sustained. Even a fighter who wins in 30 seconds with zero visible damage receives this floor.
- OTM treatment: Note the suspension exists; do not assign clinical significance

**The "180-Day Placeholder"**
"Suspended 180 days or until cleared by orthopedic/ophthalmologic exam" is a regulatory stop-loss mechanism, not a clinical recovery prediction. The commission is saying: *we won't clear this fighter until a specialist signs off.*
- OTM treatment: Status = **"Pending Clearance (TBD)"** — not "6 months out"
- Most fighters with this suspension clear in **3–6 weeks** once acute swelling resolves and imaging is clean
- OTM should note the specific clearing requirement: *"Listed as pending orthopedic clearance — once the MRI is clean, the path back is relatively short. This is a regulatory hold, not a 6-month injury."*

**The Hard No (KO Suspension)**
A KO suspension with "60 days no competition, 45 days no contact" is an **absolute anchor**. There is no specialist clearance mechanism that unlocks early return. This is a legal block on the fighter's license.
- OTM treatment: Do not speculate on early return; flag as hard block; apply CONCUSSION protocol from SKILL.md

**Joint Lock Submission — Clinical Trigger**
When a submission via joint lock (armbar, heel hook, Kimura, kneebar) generates a 180-day pending clearance suspension, OTM should flag the **specific joint at risk** based on the submission type.

| Submission Type | Primary Joint at Risk | OTM Flag |
|---|---|---|
| Armbar | Elbow (UCL, radial head) + shoulder (anterior capsule) | Ulnar collateral ligament / elbow joint risk |
| Kimura | Shoulder (posterior capsule, rotator cuff, potential dislocation) | Posterior shoulder / rotator cuff risk |
| Heel Hook | Knee (ACL, LCL, posterolateral corner) | Knee ligament complex — potentially career-altering |
| Kneebar | Knee (ACL, patellar tendon) | Anterior knee complex |
| Guillotine / RNC | Cervical spine (if resisted heavily before tap) | Cervical spine flag; escalate if fighter shows neurological symptoms post-fight |

---

## 6. Weight Cut Context

### 6.1 The UFC's Unique Load Amplifier

Extreme weight cutting has no equivalent in any other sport covered by OTM. Fighters commonly cut 10–20+ lbs in the 24–48 hours before weigh-ins via dehydration protocols. This creates a distinct physiological context that modifies injury risk and fight performance interpretation.

**The CSF mechanism:**
Dehydration reduces cerebrospinal fluid (CSF) volume, which normally acts as a shock absorber for the brain within the skull. Reduced CSF volume means the brain has less hydraulic buffering against impact — this is the primary mechanism by which extreme weight cuts elevate concussion vulnerability.

**Weight cut complications:**
- Elevated concussion risk (CSF volume reduction)
- Acute Kidney Injury (AKI) from severe dehydration
- Cardiovascular strain → decreased muscle strength and endurance
- Early-round fatigue from incomplete rehydration

---

### 6.2 Weight Cut Signal Rules

**OTM Durability Score Modifier:**
> If a fighter **misses weight** or appears visibly emaciated at weigh-ins, decrease their Durability Score by **20–30%** for the bout.

A fighter who misses weight or shows visible signs of an extreme cut has not adequately rehydrated and has likely compromised their neurological and physiological baseline before the first punch is thrown.

**Weight cut vs. true injury signal:**
When a fighter shows visible in-fight performance decline — slowed movement, diminished output, apparent fatigue — OTM should note the weight cut context before defaulting to injury framing. Early-round performance decline in a fighter with a known extreme cut is as likely a weight cut complication as a genuine in-fight injury.

*OTM framing: "The visible fatigue here warrants context — [Fighter] came in heavy and the weight cut may be a factor in what we're seeing, separate from any in-fight damage."*

---

## 7. Underreported and Misclassified Injury Patterns

### 7.1 Staph Infection / MRSA — "The Turf Toe of MMA"

- Methicillin-resistant Staphylococcus aureus (MRSA) and other staph infections are endemic to grappling gym environments — shared mats, skin-to-skin contact, and open wounds from training create ideal transmission conditions
- MRSA can completely deplete a fighter's cardio and systemic capacity, or force a fight withdrawal with 48 hours' notice
- Media rarely covers staph as a serious fight-altering condition; the clinical reality is that systemic MRSA infection is a legitimate medical emergency

**OTM scrape terms:** "infection," "cellulitis," "staph," "antibiotics," "skin infection," "hospitalized"

**OTM rules:**
- Any fighter withdrawal citing infection or cellulitis = apply SYSTEMIC special-case flag from SKILL.md
- Do not generate RTP estimate for active systemic infection — apply systemic illness protocol
- Note the gym transmission risk context: *"Staph infections in MMA are more common and more serious than media coverage suggests — this isn't a minor issue."*
- Post-clearance RTP: fighter must complete antibiotic course and receive medical clearance; OTM status = "Pending Clearance (TBD)" until confirmed

---

### 7.2 Micro-Concussion Accumulation — Cumulative Narrative

Fighters sustain dozens of sub-concussive blows in hard sparring every training week across a multi-year career. This cumulative neurological load does not present as a single acute event — it accumulates silently and manifests as progressive cognitive and neurological changes over time.

**OTM handling:**
- Micro-concussion accumulation is a **cumulative narrative context**, not an acute event signal
- OTM should not generate RTP content based on speculative sub-concussive load without a clinical anchor
- When a fighter with a long, high-volume career sustains a KO loss, the cumulative context is relevant: *"At this stage of his career, the accumulated neurological load — not just this single KO — is the story the medical community is watching."*
- Post-fight disclosures about chronic neurological symptoms (headaches, vision changes, cognitive symptoms) should be flagged for MD escalation per SKILL.md criteria

---

### 7.3 Post-Fight Injury Disclosure — Forward-Looking Value

Fighters frequently disclose injuries sustained during or before a fight only after the bout is concluded — once the financial outcome is secured and there is no competitive disadvantage to disclosure.

**OTM value of post-fight disclosures:**
- **Retroactive application is limited** — the fight is over; outcome cannot be revised
- **Forward-looking value is high** — post-fight disclosures directly inform the next matchmaking cycle, timeline to next fight, and commission suspension interpretation
- OTM should treat post-fight disclosures as primary input for next-fight RTP framing, not as post-hoc fight analysis

*OTM framing: "Now that the fight is over, [Fighter] has disclosed he was carrying a [injury] into camp. This changes the picture for his next bout — [RTP context] — and explains the commission's [suspension] filing."*

---

## 8. OTM Content Application — UFC-Specific Rules Summary

| Scenario | OTM Rule |
|---|---|
| Pre-fight fighter/camp injury statement | Lowest reliability; do not anchor OTM analysis |
| Commission suspension record | Objective ground truth; trust over all other sources |
| Suspension ≤30 days, no clinical finding | Administrative floor; no clinical significance |
| "180 days pending clearance" suspension | Pending Clearance (TBD); most clear in 3–6 weeks; not "6 months out" |
| KO suspension (60 days no competition) | Hard Block; no early clearance pathway; apply CONCUSSION protocol |
| TKO suspension (30 days) | Hard Block; RTP ≥30 days |
| Submission — choke | Soft Block; administrative floor only |
| Submission — joint lock (armbar, heel hook, Kimura) | Clinical Trigger; flag specific joint per submission type |
| Armbar | Elbow UCL + anterior shoulder flag |
| Heel hook | Knee ligament complex flag; potentially career-altering |
| Kimura | Posterior shoulder / rotator cuff flag |
| Short notice (<21 days) | High-risk flag; truncated camp = elevated dehydration, fatigue, concussion risk |
| Missed weight / emaciated weigh-in | Durability Score -20–30%; weight cut complication vs. injury signal |
| In-fight performance decline | Check weight cut context before injury framing |
| Facial laceration, orbital area | Doctor stoppage flag; frame through fight stoppage probability |
| KO loss, veteran fighter with history | Note cumulative neurological load context |
| "Infection" / "cellulitis" / "antibiotics" | MRSA/staph flag; SYSTEMIC protocol; no RTP estimate |
| Post-fight injury disclosure | Forward-looking value only; apply to next fight timeline |
| Wrestler's Spine (grappler, cervical/lumbar) | Cumulative narrative; cover acutely only when documented event occurs |
| Heavyweight KO pattern | Note weight class modifier; higher head trauma rate than lighter divisions |
| Micro-concussion disclosure / chronic symptoms | Flag for MD escalation; cumulative narrative framing |
| Commission "fractured orbital" vs. manager "he's fine" | Trust commission record; override manager statement |

---

*Reference file drafted Session 3. Pending physician founder sign-off before deployment to `sidelineiq-agents/skills/references/`.*
