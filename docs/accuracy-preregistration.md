# Accuracy pre-registration

**Registered 2026-09-15**, before the return detector had closed a single thread
and therefore before anybody — including the people who wrote it — knew what the
number would be. The commit timestamp is the registration. Nothing in this file
may be changed after a number derived from it is published; a definition that
moves after seeing the data is not a definition.

This is a clinical-research habit applied to a software claim, and for the
ordinary reason: the projections go out under a board-certified orthopedic
surgeon's name. Choosing the metric after seeing which metric flatters the model
is the failure mode, and it is invisible from the outside.

## What is being measured

Every published injury post carries an OTM return-to-play window — `min_weeks`
to `max_weeks`, measured **as a total from `injury_date`**, not as time
remaining. At thread open, `projected_return_date` is frozen as `injury_date`
plus the midpoint of that window. The question is whether the athlete came back
inside the window.

## Definition: "returned"

The **first completed regular-season game after `injury_date` in which the
athlete recorded a stat line**, from ESPN's athlete gamelog endpoint, converted
to the sport's own local calendar date.

Deliberate properties of that choice:

- **It is an event, not a designation.** An ESPN status transition to `Active`
  was rejected: `status` is a STATE with no change indicator anywhere in the
  payload, and an `Active` row sometimes exists to carry a comment about a
  teammate. A game is a thing that happened, on a date a reader can check.
- **It under-counts rather than invents.** The gamelog lists only games with a
  stat line, so an athlete who dressed and took no snaps is missed, not
  fabricated. Errors therefore push threads toward "still injured", which is the
  direction that costs us a data point instead of the direction that
  manufactures a success.
- **Preseason and postseason do not count.** Both appear in the same payload; a
  preseason appearance is a look-see in August, not a return to competition.
- **Strictly after the injury date.** The athlete has a stat line for the game he
  was hurt in.

**Scope: NFL and NBA.** Premier League is excluded because a substitute
appearance and an unused bench spot are a different question; UFC has no gamelog
and no season.

## The headline metric: `within_range`

> **Returns inside the published window: X of Y.**

`within_range` is true when the return date falls in
`[injury_date + min_weeks, injury_date + max_weeks]`.

**MAE is not the headline, and this is the part most likely to be argued with
later, so it is settled here.** An ACL window of 39–52 weeks is 91 days wide.
Mean absolute error measures distance from the window's midpoint — a point the
model never claimed. An athlete returning at week 40 is squarely inside the
published range, a *correct* call by the system's own framing, and MAE scores
that as −38 days. **Headlining MAE punishes exactly the calls that were right.**
It is the same coordinate error as the `team_timeline_weeks` bug: the bar is the
WINDOW, not its midpoint.

## Secondary metrics

- **Median signed error in days**, with **its own n**. Median, not mean: one
  outlier destroys a mean at n≈20. Its denominator is smaller than the headline's
  because a thread can be scoreable for `within_range` while carrying no frozen
  `projected_return_date`.
- **The distribution of window widths**, published beside the headline.
  "90% inside the window" without saying the windows average 13 weeks wide is its
  own kind of dishonest.

## Exclusions, and how they are made visible

A thread is counted only when `accuracy_record.scoreable` is true. `scoreable`
is false, with `unscoreable_reason`, when:

| Reason | Meaning |
|---|---|
| `no_projection` | the thread never carried an OTM window |
| `no_injury_date` | no anchor, so no window to fall inside |
| `no_actual_return_date` | closed without a return (RETIRED) |

Also excluded: **VOID** threads (retracted as never having described a real
injury — scoring one would grade a projection about a wrong athlete), and
threads whose close was later reversed with `web_thread_reopen`.

`scoreable` is **absent** on every row written before 2026-09-15. Readers derive
it for those (`within_range != null`) and never read `undefined` as `false`.

**The excluded count is published with the metric**, never silently dropped. A
denominator that quietly discards the hard cases is the oldest trick in this
genre.

## Publication rules

1. **No number below n = 30.** "75% (3 of 4)" is unretractable once
   screenshotted.
2. Compute privately first. `AccuracyView` is admin-only and stays there until
   the decision to publish is made deliberately.
3. If published, publish **this definition, unchanged**, beside the number.
4. **Kill switch (gate G1): if `within_range` is below ~50% at n ≥ 30, do not
   sell or publish projections to anyone.** Fix the clinical model instead.
   Finding that out privately and cheaply is worth more than any revenue path
   that depends on the answer being good.

## One constraint on the wording of any public page

`skills/SKILL.md` and its six reference files read
`status: DRAFT — Pending physician founder sign-off`. Until they are signed, a
public page **describes what the system does** — these definitions, these counts
— and must not cite `skills/` as a clinical standard. Quoting an unsigned
document as a standard under a physician's byline is the thing to avoid, and it
is avoidable for free by wording.

## Where the numbers come from

- `injury_entities.accuracy_record` (JSONB), written once at
  `web_thread_close` by `computeAccuracyRecord` (mcp `src/servers/web/service.ts`).
- `actual_return_date`, written by the return detector
  (`src/monitoring/return-detector.ts`) with `return_source = 'detector'`, or by
  a physician with `return_source = 'md'` — which a machine may not overwrite.
- Verified before it ran by `src/scripts/return-detect-dryrun.ts`, whose gated
  numbers must all be zero.


---

## Observation after the first cohort — 2026-09-16

**No definition above has changed.** This section records what the first live
sweep looked like, dated, so that any later amendment is a deliberate act with a
visible before and after rather than a quiet edit after seeing the data.

The detector's first `on` cycle closed **24 threads**. Every one of them:

- returned on **2026-09-09, 09-10 or 09-13 — Week 1 of the 2026 NFL season** (21 of
  the 24 on a single date); and
- was injured **before the season opener** (`injury_date` range 2025-09-21 to
  2026-08-27).

**For an athlete injured in the offseason or preseason, the first regular-season
game is a floor the CALENDAR imposes, not a date the recovery produced.** Sione
Vaki carried a 0–2 week window from an August 3 injury and "returned" on
September 13; he was in all likelihood available weeks earlier, with no
regular-season game to be available for. The metric, on this cohort, is largely
measuring whether the OTM window happened to contain Week 1.

The first reading is therefore **`within_range` 6 of 12 scoreable** (12 more
closes were `no_projection`), median signed error +12 days over n=12, range −76
to +175. **It is not a verdict on anything.** The publication bar is n ≥ 30 and
the G1 kill switch is evaluated at n ≥ 30; this is n = 12, drawn from a cohort
whose return dates were censored by the schedule.

**The open question, to be decided BEFORE n reaches 30 and before any number is
published:** should a return whose date equals the athlete's first regular-season
game of a season that began after `injury_date` be marked unscoreable — a
censored observation — rather than scored? There is a real argument for it (the
observation carries no information about recovery) and a real argument against
(it discards the offseason cohort entirely, and "available for the first game
that mattered" is a defensible clinical claim). Either way the decision belongs
in this file, dated, before the number exists — not after.

The honest expectation is that this resolves itself as the season runs: an
injury that occurs AND resolves in-season returns on a date the recovery
actually chose. Those are the rows that carry signal.

---

## Amendment 1 — 2026-09-16

**Made at n = 12 scoreable, before any accuracy number has been published
anywhere.** Nothing above this line has been edited; this section supersedes it
where the two differ, and says so point by point. It was decided on the
reasoning below, without first computing which option makes the first 12 rows
look better — which is the only condition under which amending a
pre-registration is honest at all.

Everything not named here is unchanged: the definition of "returned", the
`within_range` headline, the n ≥ 30 publication bar and the G1 kill switch.

### A1.1 — Which window is scored: the first PUBLISHED estimate

The text above says the projection is "frozen at thread open". **It was not.**
The thread's stored `otm_projection` was rewritten by every later post on the
thread, of any status. Two rows in the first cohort show why that cannot be the
thing scored:

- **Wan'Dale Robinson**: the stored window was written by a TRACKING post that
  a physician later REJECTED.
- **Ashton Jeanty**: his thread's only published post gave 1–4 weeks. The
  stored window read 2–8, written by a later post that never reached an
  audience, and that 2–8 window is what was scored.

A window that later posts can move toward the outcome is not a forecast.

**The scored window is the RTP window on the earliest-created post that is
linked to the thread (through `injury_updates` or `canonical_post_id`), has
status `PUBLISHED`, and carries an estimate (A1.2).** It is read when the thread
is closed, not from the stored `otm_projection`. That column remains a display
value and nothing is scored from it.

- The projected return date used for the signed error is `injury_date` plus the
  midpoint of the scored window, computed at close.
- The record names the post the window came from.
- A post a physician rejected, a post still in review, and a post superseded
  before approval are never the scored window, because none of them reached an
  audience.
- **Why first rather than latest:** the first published window is the claim
  made before anyone knew how the recovery would go. A later window is often
  better informed, and that is exactly the problem: it can only become better
  informed by moving toward the result.

### A1.2 — A window of zero is not an estimate

SKILL.md forbids an RTP estimate for CONCUSSION and SYSTEMIC events. Those posts
still publish, and by instruction they carry `min_weeks = max_weeks = 0` and
`rtp_confidence = 0`. That means "we decline to estimate", not "back in zero
weeks". Robinson's 0–0 was a concussion, and it was being scored as a miss that
no return could ever have avoided.

**A post carries an estimate only when `rtp_confidence > 0` and
`max_weeks ≥ 1`.** A thread with no published post that carries an estimate is
`no_projection`, the same as a thread that never had a window.

A window whose floor is zero and whose ceiling is not is a real estimate and is
scored. For example, 0–2 weeks for a nasal fracture says "may not miss a game".

### A1.3 — Calendar-censored returns: the interval rule

A return is **calendar-censored** when the return game is the **first completed
regular-season game on the returning team's schedule dated strictly after
`injury_date`**, both compared as the sport's local calendar dates. In other
words, the athlete missed no games because there were none to miss. Every
offseason or preseason injury that resolves by the opener is censored, and so
is an in-season injury followed by the very next game.

A censored return does not tell us when the athlete recovered. It tells us only
that recovery happened **on or before** the return date. Scored against the
window `[injury_date + min_weeks, injury_date + max_weeks]`:

| Censored return date | What it proves | Treatment |
|---|---|---|
| before `injury_date + min_weeks` | recovery was earlier than the window's floor | **scored**, `within_range = false` |
| on or after `injury_date + min_weeks` | nothing: recovery could have been anywhere up to that date | **unscoreable**, `calendar_censored` |

Censored-and-unscoreable records carry no `within_range` and no signed error.
Every record says whether it was censored.

**Why this rule and not the two simpler ones:**
- **Scoring censored returns as-is** grades the NFL schedule. Whether a window
  "contains Week 1" is not a clinical claim anyone made.
- **Excluding every censored return** also drops the returns that provably came
  before the window's floor. Those are known misses, and dropping them silently
  flatters the headline. It is the "denominator that quietly discards the hard
  cases" that this file already forbids.
- **The interval rule** keeps every observation that carries information and
  only those. It is the standard treatment of an interval-censored observation
  against an interval claim.

Two notes:
- A return far enough before the floor already never closes a thread. The
  detector's too-early bar holds it ACTIVE for date review, because at that
  distance the injury date is the likelier error. The first row of the table
  therefore applies only between that bar and the floor.
- The schedule consulted is the team the athlete returned WITH. An athlete
  traded while injured is judged against the new team's calendar.

The exclusions table above gains one row:

| Reason | Meaning |
|---|---|
| `calendar_censored` | returned in the first game available after injury, on or after the window's floor |

`no_projection` now means "no PUBLISHED post on the thread carries an estimate"
(A1.1, A1.2).

### A1.4 — Retroactive, and how

This amendment applies to **every** close, including the first cohort of 24.
Those threads are re-scored by reopening them (`web_thread_reopen`, whose
`thread_reopened` audit row keeps the original record verbatim) and letting the
detector close them again through the one scoring path. There is no hand-edited
record and no second formula.

---

## Amendment 2 — 2026-10-03

**Made at 18 scored threads (17 returns), before any accuracy number has
been published anywhere.** Nothing above this line has been edited. This
section supersedes the text above where the two differ, and says so point by
point.

**One disclosure that Amendment 1 did not need.** A2.1 was decided after a
duplicate had already been scored, and its effect on the current data is
known. It removes exactly one observation: Brian Burns, whose single return
was a miss on each of two threads. Today that moves the reading from 9 of 18
to 9 of 17; after the physician re-score in A2.3, it moves 8 of 17 to 8 of 16. The rule was chosen on the reasoning below, and it would have been
chosen whichever way that one row had gone. A reader is entitled to know the
order of events, so here it is.

Unchanged: the definition of "returned", the `within_range` headline, the
scored window (A1.1), the estimate rule (A1.2), the interval rule (A1.3), the
n ≥ 30 publication bar and the G1 kill switch.

### A2.1 — One return is one observation

The headline is "Returns inside the published window: X of Y". The scorer,
however, writes one `accuracy_record` per closed **thread**, and those two
units diverge whenever one injury is carried on more than one thread.

That happens. The thread matcher keys on body part, laterality and an
injury-type substring, so a "sprain" report and a later "surgery" report about
the same ankle can open two threads. Brian Burns' left ankle did exactly this:
both threads closed on the 2026-09-27 game, and the one return was counted
twice.

**Closed threads for the same athlete (`player_id`) with the same
`actual_return_date` are one observation.**
- Its verdict is the scoreable record of the group's **earliest-opened**
  thread, ordered by `first_reported_at` and then by thread id.
- When no member of the group is scoreable, the group is **one** exclusion,
  under its earliest thread's reason.

Exclusions are counted per return as well, so the excluded count published
beside the headline is in the same unit as the headline itself.

- **Why earliest-opened:** it is A1.1's principle applied one level up. It
  selects the first claim made, before anyone knew how the recovery would go.
  It is also decidable from the thread list alone.
- **Nothing is re-scored.** The verdict, the error and the window are the
  record that `computeAccuracyRecord` froze at close. A2.1 decides only which
  records count as the same observation, so there is still one formula.
- **Where it is implemented:** `summarizeAccuracy`, in
  `src/utils/accuracy-observations.ts`, with a byte-identical copy in the
  frontend's `lib/`. Both are pinned by
  `tests/fixtures/accuracy-observation-cases.json`.
  `src/scripts/accuracy-report.ts` prints the result in this file's terms.

### A2.2 — Dated note: a return that predates the report (no definition changed)

The detector now **holds** a candidate return for date review, rather than
closing on it, when the game was played **before the thread's own first
report**, comparing sport-local calendar dates.

The reasoning: a thread is opened by a report that the athlete is injured now,
so an earlier stat line cannot be the return from that injury. Either the
stored `injury_date` belongs to an older injury, or the athlete was hurt in
that game.

This is a date-sanity hold of the same kind as the too-early bar (A1.3's
second note). The definition of "returned" is unchanged.

Seven closes made before the hold existed were of this kind. All seven are
`no_projection`, and **no scored record was among them**, so the hold changed
no reading. `src/scripts/return-detect-dryrun.ts` gates that claim for every
detector close (Section H).

The seven are:
- Alec Pierce ×4, injury 03-01, return 09-13, reported 09-23 to 09-25. Each
  close let the next report mint a fresh thread.
- Lukas Van Ness ×2.
- Jonathan Greenard `d5001ade`, a re-injury in the 09-28 game, reported 09-30.
- Trey Hendrickson.

They stay closed. They carry no published estimate, so reopening them gains
nothing for this metric, and under A2.1 they collapse into their returns.

### A2.3 — Physician closes are re-scored too

A1.4 applies to every close. The detector's closes were re-scored by
reopening them, but a physician's close cannot go that way:
`web_thread_reopen` erases the return date the physician entered.

Physician closes are therefore re-scored by the physician closing the thread
again **with the same date**. `src/scripts/rescore-md-closes.ts` does this, and
it runs only at the physician's direction. The new record comes from the same
`computeAccuracyRecord`.

Until that has run, records without a `scoreable` key are derived as this file
already says, and `accuracy-report.ts` lists them separately as legacy.
