# Prognosis Ledger — scoring pre-registration

**Registered 2026-10-04**, before the first ledger entry exists and therefore before
anybody knows what any number will be. The commit timestamp is the registration.
Nothing in this file may be changed after a number derived from it is published; a
definition that moves after seeing the data is not a definition. Amendments, if any,
are appended below a dated heading, state the n at the time, and say what changed.

This is the ledger's own pre-registration. It is a sibling of
`docs/accuracy-preregistration.md`, not an extension of it: that file governs the
return-to-play window of the autonomous injury posts; this one governs the
physician-signed forecasts of `docs/paratrOs Prognosis Ledger — Working Spec.md`.
Where the two products' rules differ (publication floors, headline metric), each file
is authoritative for its own product. Where this file is silent, the spec governs.

## What is being measured

Every ledger entry carries five forecasts on a publicly reported NFL injury, signed
by Keith P. Johnson, MD, each resolvable from public records:

| Field | Forecast | Resolution source | Score |
|---|---|---|---|
| F1 | P(placed on IR within 7 days of injury) | transaction wire | Brier |
| F2 | P(plays ≥ 1 snap in the team's next scheduled game) | gamebook participation | Brier |
| F3 | P(plays ≥ 1 snap in any game within 28 days) | gamebook participation | Brier |
| F4 | games missed, point estimate + 80% interval | gamebook participation | MAE on the point; 80% interval coverage |
| F5 | P(same-site injury on the injury report AND ≥ 1 game missed within 6 games of return) | injury report + gamebook | Brier |

Field order, labels and sources are fixed in `src/ledger/fields.ts`.

## Sources, as decided 2026-10-04

- **Gamebook participation** = nflverse `snap_counts_<season>.csv`, derived from Pro
  Football Reference's per-game snap counts. "Played" = `offense_snaps +
  defense_snaps + st_snaps ≥ 1`. The evidence link is the PFR boxscore.
- **Transaction wire** = ESPN's NFL transactions feed. Its entries are prose and
  day-granular; every reading of one is a proposal quoting the sentence, confirmed
  by the physician.
- **Official injury report** = nflverse `injuries_<season>.csv` (`report_primary_injury`,
  `report_secondary_injury`).
- **Game universe** = nflverse `games.csv`, `game_type = 'REG'`. A completed game is one
  whose `result` is populated.
- **Identity** = nflverse `players.csv`, which carries the ESPN, PFR and GSIS ids
  together. A player missing an id is **unresolvable** for the fields that need it and
  is surfaced, never matched by name.

## Resolution rules (the approved interpretations)

All dates are compared on the NFL's local calendar (America/New_York), never UTC.
Byes are not rows in the schedule and are never counted as games. Postseason games
count toward nothing. The implementation is `src/ledger/rules.ts`; each bullet is a
test in `tests/ledger-rules.test.ts`.

- **F1.** An IR transaction dated on or before `injury_date + 7` calendar days → 1. No
  such transaction once day 7 has passed → 0, resolved on day 7.
- **F2.** The "next scheduled game" is the team's first regular-season game dated
  strictly after `injury_date`; the game the athlete was hurt in is not it. A bye pushes
  it out. Played → 1, otherwise 0, resolved on the game date.
- **F3.** A game with ≥ 1 snap dated on or before `injury_date + 28` → 1. Otherwise 0,
  resolved on day 28, or on the team's last regular-season game if the season ends
  first ("season end resolves F3 as no").
- **F4.** The count of completed regular-season team games dated strictly between
  `injury_date` and the return game. Resolved on the return date. If the season ends
  without a return, the outcome is the games remaining after `injury_date`.
- **F5.** Within the team's next six completed regular-season games after the return
  game: an injury-report row for the athlete naming the same body site as the entry's
  reported injury (`BODY_SITE_LEXICON` in `rules.ts` defines "same site"), and a game
  in that span, at or after the week of that listing, with no snap. Both → 1; the span
  completing without both → 0; the season ending short of six games resolves 0 at
  season end. Concussion entries: F5 void by rule.
- **A game the snap file does not cover at all is "awaiting snap counts", never a
  miss.** Absence of the athlete's row is evidence only when other rows for that game
  exist.
- **Season-ending flag** (metadata, not scored): set when F3 < 5% and the F4 lower
  bound exceeds the regular-season games remaining after `injury_date`.

### Void

A trade, release, retirement or suspension dated strictly before the date a field
resolved on voids that field only. Fields resolve independently; a field that resolved
first stays resolved. A field whose first resolvable moment had already passed when v1
was published is void (`forecast_after_freeze`): there was nothing to forecast. Void
entries are listed on the scoreboard with their reason; nothing is deleted.

### Freeze points

| Field | Freeze point |
|---|---|
| F1 | the START of the IR transaction's day (the wire is day-granular), else the END of day 7 |
| F2 | kickoff of the next scheduled game (gameday + gametime, Eastern) |
| F3 | kickoff of the return game, else the END of day 28 |
| F4 | kickoff of the return game |
| F5 | kickoff of the return game |

Day-based freeze points are the end of that New York day, so the field is forecastable
until the day has fully passed.

## Revisions

Each entry is a chain of immutable rows: v1, v2, … Every revision names a public
trigger. A revision counts for a field only if its `published_at` is strictly before
that field's freeze point; later revisions are stored and excluded from that field's
scoring. Fields already resolved at revision time are copied forward unchanged.

**One injury event contributes exactly one observation per field to any scoreboard.
Revisions never add to n and are never averaged with the original.**

## Computation (`src/ledger/scoring.ts`)

- **Initial board** (the headline): for each resolved, non-void (entry, field), score v1.
- **Latest board**: score the last revision published before that field's freeze point.
  Same n, same outcomes, by construction.
- **Brier** per field = mean over entries of (p − outcome)², outcome ∈ {0, 1}. Reported
  to three decimals with n.
- **F4**: mean absolute error of the point estimate in games (two decimals), and the
  fraction of outcomes inside the 80% interval (three decimals). Target coverage 0.80;
  below 0.70 means the intervals are too narrow.
- **Calibration** per field: buckets 0–10%, 10–20%, …, 90–100% (upper bucket closed),
  forecast mean vs observed frequency and n per bucket. A bucket is published once
  n ≥ 5.
- **Revision delta**: Latest minus Initial per field. Negative means updating helps; a
  large negative on Latest beside a poor Initial reveals hedging after the fact, so
  both boards are always shown together.
- **Exclusions are named, never silently dropped**: `no_v1`, `no_freeze_at`,
  `v1_after_freeze`, `no_forecast_value`, `outcome_not_binary`, `outcome_not_integer`.
  The scoreboard lists them with the voids.
- **Card scoreboard line**: appears once ≥ 20 distinct entries have at least one scored
  field, reads the Initial board, and is formatted
  `Ledger: n=<entries scored> · F2 Brier <2dp> · 80% intervals hit <percent>`.

## Publication

- Monthly, on the first Tuesday: both boards, calibration tables, n per field, the void
  list, the exclusion list, and a link to the raw CSV export so anyone can recompute.
- Both boards are always published together; neither alone.
- Nothing is deleted. Clerical corrections (wrong player, wrong date) are rows in the
  corrections table with a note, never edits to a forecast row.
- The scoring helper is shared byte-identically with the public site and pinned by
  `tests/fixtures/ledger-scoring-cases.json`, whose synthetic cases carry hand-computed
  expectations. Live cases are appended by `src/scripts/ledger-scoreboard.ts
  --emit-fixture` once entries exist, and never edited.

## What is deliberately not scored

- The mechanism line, the source tier, the base-rate row and strength, and "what would
  move this" are metadata. They are published so a reader can judge the forecast, and
  they are never scored.
- Confidence is expressed only through the F4 interval width. There is no separate
  confidence label.
- `forecast_after_freeze` fields are void, not misses. A number published after the
  event it predicts is not a forecast and must not be allowed to flatter or damage the
  board.
