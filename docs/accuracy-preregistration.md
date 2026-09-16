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
