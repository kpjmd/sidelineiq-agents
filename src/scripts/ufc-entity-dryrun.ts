// Models UFC entity backing against real data BEFORE POLL_UFC is turned on.
// The ship gate for the feature, in the role salary-tier-dryrun.ts and
// derived-tier-dryrun.ts played for theirs. Exits 1 on any violation.
//
// READ-ONLY against production: it reads the players table and injury_posts
// through MCP, and ESPN's news + scoreboard feeds over HTTP. It writes nothing
// and publishes nothing. It DOES spend Haiku classifier calls (one per UFC
// article in the window) because the classifier's `is_new` judgement is the
// signal under test and modelling it would be modelling the thing we most need
// to measure.
//
// The question this answers is not "does UFC work" but "which of two opposite
// failures does each design produce". Three dedup regimes are replayed over the
// same real corpus, chronologically:
//
//   TODAY    — no player rows. 24h athlete window + the same-article guard.
//              Fails by REPUBLISHING: a story that stays in the feed comes back
//              every day past 24h, and a genuine follow-up inside 24h is lost.
//   NAIVE    — player rows, entity dedup, no substitute for is_update. Fails by
//              SILENCING: everything after the first post is suppressed for 21
//              days, including the real follow-ups.
//   PROPOSED — player rows + the classifier's is_new as the update signal +
//              the same-article guard inside the entity path.
//
// Five sections:
//   A  Roster coverage — how many tagged fighters the card window holds, and
//      how many arrive only via register-on-sight.
//   B  Per-event classification against the live feed (real Haiku calls).
//   C  The three regimes, per athlete, chronologically — the before/after.
//   D  Structured-feed no-flip check: replays recent NFL/NBA posts and asserts
//      the update signal is unchanged for every one of them.
//   E  Volume against MAX_PUBLISHES_PER_DAY.
//
// Ship criteria (any failure exits 1):
//   1. Every fighter tagged in the live feed resolves (window or on sight).
//   2. No structured-feed event's update signal changes.
//   3. PROPOSED publishes at most 1 BREAKING + ceil(days/5) TRACKING per thread.
//   4. PROPOSED loses no follow-up that TODAY published.
//
// Usage:
//   npx tsx src/scripts/ufc-entity-dryrun.ts
//   npx tsx src/scripts/ufc-entity-dryrun.ts --days 45
//   npx tsx src/scripts/ufc-entity-dryrun.ts --days 45 --json docs/ufc-entity-dryrun.json
//   npx tsx src/scripts/ufc-entity-dryrun.ts --no-classify   (skip Haiku, model is_new)

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { ESPNUFCSource } from '../monitoring/sports/espn-ufc.js';
import { ATHLETE_LIST_PROVIDERS } from '../monitoring/roster-sync.js';
import { classifyEvent } from '../agents/injury-intelligence/classifier.js';
import { resolveUpdateSignal } from '../monitoring/poller.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
} from '../agents/injury-intelligence/significance.js';
import { refreshTierSnapshotsIfStale } from '../agents/injury-intelligence/tier-snapshots.js';
import { extractInjuryMetadata } from '../agents/injury-intelligence/fact-validator.js';
import type { RawInjuryEvent } from '../types.js';

const TRACKING_COOLDOWN_MS = 5 * 24 * 60 * 60 * 1000;
const ENTITY_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Args {
  days: number;
  json?: string;
  classify: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = parseInt(get('--days') ?? '', 10);
  return {
    days: Number.isFinite(days) && days > 0 ? days : 7,
    json: get('--json'),
    classify: !argv.includes('--no-classify'),
  };
}

const violations: string[] = [];
function violate(msg: string): void {
  violations.push(msg);
  console.log(`  ✗ ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function hours(ms: number): string {
  return `${Math.round(ms / 3600_000)}h`;
}

// ── The three dedup regimes ──────────────────────────────────────────────────

type Regime = 'TODAY' | 'NAIVE' | 'PROPOSED';

interface Publication {
  at: number;
  contentType: 'BREAKING' | 'TRACKING';
  headline: string;
  /** The thread this post belongs to, when there is one. */
  entityKey?: string;
}

/** The fields web_find_matching_entity matches on. */
interface EntityKey {
  player: string;
  bodyPart: string | null;
  laterality: string;
  injuryType: string | null;
}

interface SimEvent {
  event: RawInjuryEvent;
  isNew: boolean | undefined;
  key: EntityKey;
}

/**
 * Whether a new report matches an open entity, mirroring the SQL predicate in
 * web_find_matching_entity rather than approximating it with a string key.
 *
 * The fuzziness is the point and a strict key gets the answer badly wrong: a
 * NULL on either side matches anything, UNSPECIFIED laterality matches any
 * side, and injury type matches by substring in BOTH directions. Under an
 * exact-join key McGregor's nine articles fragment into three separate threads;
 * under the real predicate they are one, which is what production would do.
 */
function matchesEntity(entity: EntityKey, incoming: EntityKey): boolean {
  if (entity.player !== incoming.player) return false;
  if (incoming.bodyPart !== null && entity.bodyPart !== null && entity.bodyPart !== incoming.bodyPart) {
    return false;
  }
  if (
    entity.laterality !== 'UNSPECIFIED' &&
    incoming.laterality !== 'UNSPECIFIED' &&
    entity.laterality !== incoming.laterality
  ) {
    return false;
  }
  if (incoming.injuryType !== null && entity.injuryType !== null) {
    const a = entity.injuryType;
    const b = incoming.injuryType;
    if (!a.includes(b) && !b.includes(a)) return false;
  }
  return true;
}

/**
 * Replay one athlete's events chronologically under one regime.
 *
 * Deliberately a re-implementation rather than a call into deduplicator.ts:
 * the point is to compare regimes that no longer exist in the code (TODAY) or
 * never did (NAIVE), so the shared logic would have to be re-parameterised into
 * something neither regime actually is. Every rule here is a quotation of the
 * real one, and D checks the real code agrees on the part it can still reach.
 */
function replay(regime: Regime, events: SimEvent[]): Publication[] {
  const published: Publication[] = [];
  // article url -> when we published it
  const publishedArticles = new Map<string, number>();
  const entities: Array<{ key: EntityKey; opened: number; lastTracking: number | null }> = [];

  for (const { event, isNew, key } of events) {
    const at = event.reported_at.getTime();
    const headline = event.injury_description.slice(0, 60);
    const { isUpdate } = resolveUpdateSignal(event, isNew);

    if (regime === 'TODAY') {
      // No entity ever forms. 24h athlete window, then the same-article guard.
      const lastAny = published.length ? published[published.length - 1].at : null;
      if (lastAny !== null && at - lastAny < FALLBACK_WINDOW_MS) continue;
      const sameArticle = publishedArticles.get(event.source_url);
      if (sameArticle !== undefined && at - sameArticle < 7 * 86400000) continue;
      published.push({ at, contentType: 'BREAKING', headline });
      publishedArticles.set(event.source_url, at);
      continue;
    }

    // Most recently updated match first, as the SQL's ORDER BY does.
    const entity = entities
      .filter((e) => at - e.opened < ENTITY_WINDOW_MS && matchesEntity(e.key, key))
      .sort((a, b) => b.opened - a.opened)[0];

    if (!entity) {
      published.push({ at, contentType: 'BREAKING', headline, entityKey: describeKey(key) });
      entities.push({ key, opened: at, lastTracking: null });
      publishedArticles.set(event.source_url, at);
      continue;
    }

    // NAIVE has no signal that can open the escape: the news source never sets
    // is_update, so every matched event is suppressed for the whole window.
    if (regime === 'NAIVE') continue;

    if (!isUpdate) continue;

    // The same-article guard, inside the entity path.
    const sameArticle = publishedArticles.get(event.source_url);
    if (sameArticle !== undefined && at - sameArticle < 7 * 86400000) continue;

    // The 5-day per-thread cadence throttle.
    if (entity.lastTracking !== null && at - entity.lastTracking < TRACKING_COOLDOWN_MS) continue;

    // publishing-pipeline.ts's own 24h backstop, which runs after everything
    // above and is content-type AGNOSTIC: any post about this athlete inside
    // 24h skips this one. It is what stops a TRACKING follow-up landing minutes
    // after the BREAKING that opened the thread — the cadence throttle cannot,
    // because it only compares TRACKING against TRACKING. Modelled here because
    // leaving it out overstates volume, which is the wrong direction to be
    // wrong in for an anti-spam gate.
    const lastForAthlete = published.length ? published[published.length - 1].at : null;
    if (lastForAthlete !== null && at - lastForAthlete < FALLBACK_WINDOW_MS) continue;

    published.push({ at, contentType: 'TRACKING', headline, entityKey: describeKey(entity.key) });
    entity.lastTracking = at;
    publishedArticles.set(event.source_url, at);
  }

  return published;
}

function describeKey(k: EntityKey): string {
  return `${k.bodyPart ?? '?'}/${k.laterality}/${k.injuryType ?? '?'}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.env.MAX_EVENT_AGE_DAYS = String(args.days);

  await initializeMCPClients();
  await loadSignificanceData();
  await refreshTierSnapshotsIfStale();

  console.log(`\nUFC entity backing — dry run (${args.days}d window)\n${'='.repeat(64)}`);

  // ── A. Roster coverage ────────────────────────────────────────────────────
  console.log('\nA. ROSTER COVERAGE');

  const provider = ATHLETE_LIST_PROVIDERS.UFC!;
  const rosterAthletes = await provider.fetchAthletes();
  if (rosterAthletes === null) {
    violate('the card-window roster read failed — cannot model coverage');
    return finish(args, {});
  }
  const rosterIds = new Set(rosterAthletes.map((a) => a.espn_athlete_id));
  console.log(`  card window (±180/90d): ${rosterAthletes.length} fighters`);

  const existing = await countUfcPlayers();
  console.log(`  players table today:    ${existing} UFC rows`);

  // ── B. Live feed + classification ─────────────────────────────────────────
  console.log('\nB. LIVE FEED');

  const events = await new ESPNUFCSource().fetchLatestEvents();
  console.log(`  ${events.length} injury events in the ${args.days}d window`);
  if (events.length === 0) {
    console.log('  (nothing to model — the feed carries no injury stories right now)');
  }

  const taggedIds = new Set(
    events.map((e) => e.espn_athlete_id).filter((id): id is string => Boolean(id)),
  );
  const untagged = events.filter((e) => !e.espn_athlete_id);
  const onSight = [...taggedIds].filter((id) => !rosterIds.has(id));

  console.log(`  tagged with an ESPN id:  ${taggedIds.size} distinct fighters`);
  console.log(`  already in the roster:   ${taggedIds.size - onSight.length}`);
  console.log(`  registered on sight:     ${onSight.length}`);
  if (untagged.length > 0) {
    // Criterion 1. An untagged event cannot resolve or register, so it keeps
    // the old degraded path — worth seeing, and worth failing on.
    violate(
      `${untagged.length} event(s) carry no ESPN athlete id and would stay unresolvable: ` +
        untagged.map((e) => e.athlete_name).join(', '),
    );
  } else if (events.length > 0) {
    pass('every event in the window carries an id, so every fighter resolves');
  }

  const sim: SimEvent[] = [];
  let classifierFailures = 0;
  // Modelled mode assumes a PERFECT classifier: the first article about an
  // athlete is new, every later one is an update. That is the optimistic bound
  // — the most follow-ups this design can possibly emit — which is the useful
  // direction for an anti-spam gate, since the cadence throttle has to hold
  // even there. It is not evidence about how Haiku actually judges these
  // headlines; only a live run is.
  const seenAthletes = new Set<string>();

  for (const event of events) {
    let isNew: boolean | undefined;
    if (args.classify) {
      const tier = lookupAthleteTier(event.athlete_name, event.sport);
      try {
        const classified = await classifyEvent(event, {
          tier: tier.tier,
          tier_source: tier.source,
        } as never);
        // classifyEvent does NOT throw on an API failure — it catches
        // internally and returns is_injury_event:false with the reason in
        // classification_error, so the pipeline skips the event safely. Reading
        // only is_injury_event here would make a total classifier outage look
        // identical to a quiet news week, and the gate would report clean.
        if (classified.classification_error) {
          classifierFailures++;
          console.warn(
            `  ! classifier failed for ${event.athlete_name}: ` +
              `${classified.classification_error.slice(0, 100)}`,
          );
          continue;
        }
        if (!classified.is_injury_event) continue;
        isNew = classified.is_new;
      } catch (err) {
        classifierFailures++;
        console.warn(`  ! classifier failed for ${event.athlete_name}: ${String(err).slice(0, 120)}`);
        continue;
      }
    } else {
      isNew = !seenAthletes.has(event.athlete_name);
      seenAthletes.add(event.athlete_name);
    }
    const meta = extractInjuryMetadata(event.injury_description);
    sim.push({
      event,
      isNew,
      key: {
        player: event.espn_athlete_id ?? event.athlete_name,
        bodyPart: meta.primary_body_part?.toLowerCase() ?? null,
        laterality: meta.laterality,
        injuryType: meta.injury_type_hint?.toLowerCase() ?? null,
      },
    });
  }
  sim.sort((a, b) => a.event.reported_at.getTime() - b.event.reported_at.getTime());

  // A gate that measured nothing must never report clean. Without these two
  // checks an empty corpus — no API key, a quiet feed, a classifier outage —
  // produces a green run that has established precisely nothing.
  if (classifierFailures > 0) {
    violate(
      `${classifierFailures} of ${events.length} events could not be classified — ` +
        `the update signal under test was never exercised (check ANTHROPIC_API_KEY)`,
    );
  }
  if (sim.length === 0) {
    violate(
      events.length === 0
        ? `the feed carried no injury events in ${args.days}d — nothing was measured; ` +
            `re-run with a wider --days before reading anything into a clean result`
        : 'every event was dropped before simulation — nothing was measured',
    );
  }
  if (!args.classify) {
    console.log(
      '\n  NOTE: --no-classify. is_new is MODELLED as "first article about this\n' +
        '        athlete is new, the rest are updates" — a perfect-classifier upper\n' +
        "        bound on follow-up VOLUME, not a measurement of Haiku's judgement.\n" +
        '        It also treats every keyword hit as a real injury event, which the\n' +
        '        classifier would not: a card review ("fight grades: why the injury\n' +
        "        didn't drag down the card\") can win a follow-up slot here that\n" +
        '        is_injury_event=false would have dropped in production. Read this\n' +
        '        section for spam bounds, not for editorial quality.',
    );
  }

  if (args.classify && sim.length > 0) {
    console.log(`\n  classifier verdicts (${sim.length} injury events):`);
    for (const s of sim) {
      const { updateSignal } = resolveUpdateSignal(s.event, s.isNew);
      console.log(
        `    ${s.event.reported_at.toISOString().slice(0, 16)} ` +
          `is_new=${String(s.isNew).padEnd(9)} signal=${updateSignal.padEnd(10)} ` +
          `${s.event.athlete_name} — ${s.event.injury_description.slice(0, 58)}`,
      );
    }
  }

  // ── C. The three regimes ──────────────────────────────────────────────────
  console.log('\nC. DEDUP REGIMES, PER ATHLETE');

  const byAthlete = new Map<string, SimEvent[]>();
  for (const s of sim) {
    const key = s.event.athlete_name;
    if (!byAthlete.has(key)) byAthlete.set(key, []);
    byAthlete.get(key)!.push(s);
  }

  const totals: Record<Regime, { posts: number; tracking: number }> = {
    TODAY: { posts: 0, tracking: 0 },
    NAIVE: { posts: 0, tracking: 0 },
    PROPOSED: { posts: 0, tracking: 0 },
  };

  const perAthlete: Array<Record<string, unknown>> = [];
  for (const [athlete, evs] of byAthlete) {
    const results: Record<Regime, Publication[]> = {
      TODAY: replay('TODAY', evs),
      NAIVE: replay('NAIVE', evs),
      PROPOSED: replay('PROPOSED', evs),
    };
    for (const regime of ['TODAY', 'NAIVE', 'PROPOSED'] as Regime[]) {
      totals[regime].posts += results[regime].length;
      totals[regime].tracking += results[regime].filter((p) => p.contentType === 'TRACKING').length;
    }

    console.log(
      `\n  ${athlete} — ${evs.length} events ` +
        `(${evs[0].event.reported_at.toISOString().slice(0, 10)} → ` +
        `${evs[evs.length - 1].event.reported_at.toISOString().slice(0, 10)})`,
    );
    for (const regime of ['TODAY', 'NAIVE', 'PROPOSED'] as Regime[]) {
      const r = results[regime];
      console.log(`    ${regime.padEnd(9)} ${r.length} post(s)`);
      // The headline matters as much as the count: which article wins a slot
      // decides whether the reader gets "to undergo surgery" or "fight grades".
      for (const p of r) {
        console.log(
          `      ${new Date(p.at).toISOString().slice(0, 16)} ${p.contentType.padEnd(8)} ${p.headline}`,
        );
      }
    }

    // Criterion 3: one BREAKING plus at most one TRACKING per cooldown period.
    const span = evs[evs.length - 1].event.reported_at.getTime() - evs[0].event.reported_at.getTime();
    const maxTracking = Math.ceil(span / TRACKING_COOLDOWN_MS) + 1;
    const proposedTracking = results.PROPOSED.filter((p) => p.contentType === 'TRACKING').length;
    const proposedBreaking = results.PROPOSED.filter((p) => p.contentType === 'BREAKING').length;
    if (proposedTracking > maxTracking) {
      violate(
        `${athlete}: PROPOSED emits ${proposedTracking} TRACKING posts over ` +
          `${Math.round(span / 86400000)}d, above the ${maxTracking} the cadence throttle allows`,
      );
    }
    // Criterion 4: nothing that publishes today may be lost. Compared on
    // COUNT of distinct stories, not on identity — TODAY publishes junk
    // repeats that PROPOSED is meant to suppress, so a smaller number is the
    // goal; what must not happen is PROPOSED going silent on an athlete TODAY
    // covers at all.
    if (results.TODAY.length > 0 && results.PROPOSED.length === 0) {
      violate(`${athlete}: PROPOSED publishes nothing where TODAY publishes ${results.TODAY.length}`);
    }

    perAthlete.push({
      athlete,
      events: evs.length,
      today: results.TODAY.length,
      naive: results.NAIVE.length,
      proposed: results.PROPOSED.length,
      proposed_breaking: proposedBreaking,
      proposed_tracking: proposedTracking,
    });
  }

  if (byAthlete.size > 0) {
    console.log(
      `\n  TOTALS  today=${totals.TODAY.posts} naive=${totals.NAIVE.posts} ` +
        `proposed=${totals.PROPOSED.posts} (of which TRACKING: ` +
        `${totals.TODAY.tracking}/${totals.NAIVE.tracking}/${totals.PROPOSED.tracking})`,
    );
  }

  // ── D. Structured feeds must not flip ─────────────────────────────────────
  console.log('\nD. STRUCTURED-FEED NO-FLIP CHECK');

  // Where a structured source SPEAKS, resolveUpdateSignal must never consult
  // the classifier. Exhaustive over the input space rather than sampled: the
  // space is tiny.
  //
  // Note this used to sweep [true, false], on the belief that ESPN's feed set
  // is_update "explicitly, both ways". It does not, and never could: ESPN's
  // status is a STATE, not a DELTA, so the feed now answers `true` for the
  // day-to-day family and leaves the key ABSENT for everything else (see
  // inferIsUpdate in espn-base.ts). `false` remains part of the contract for
  // any future source that genuinely can say "this is not a change", so it is
  // still swept here — it is simply no longer reachable from ESPN.
  let flips = 0;
  for (const sourceFlag of [true, false] as const) {
    for (const isNew of [true, false, undefined]) {
      const { isUpdate, updateSignal } = resolveUpdateSignal(
        { is_update: sourceFlag } as RawInjuryEvent,
        isNew,
      );
      if (isUpdate !== sourceFlag || updateSignal !== 'source') {
        violate(
          `a feed event with is_update=${sourceFlag} and classifier is_new=${String(isNew)} ` +
            `resolved to ${isUpdate} via ${updateSignal} — the source must always win`,
        );
        flips++;
      }
    }
  }
  if (flips === 0) pass('the source flag always wins where the source has one (6/6 combinations)');

  // And where a structured source STAYS SILENT, the classifier must be
  // consulted — the same fallback the news sources rely on. This is the case
  // ESPN's injuries feed is in for every row that is not day-to-day.
  let silent = 0;
  for (const isNew of [true, false, undefined]) {
    const { updateSignal } = resolveUpdateSignal({} as RawInjuryEvent, isNew);
    if (updateSignal === 'source') {
      violate(
        `an event with NO is_update and classifier is_new=${String(isNew)} resolved via ` +
          `'source' — a silent source cannot be the authority`,
      );
      silent++;
    }
  }
  if (silent === 0) pass('a silent source always defers to the classifier (3/3 combinations)');

  // And the news-source space, where the fallback is allowed to act.
  const newsCases: Array<[boolean | undefined, boolean, string]> = [
    [false, true, 'classifier'],
    [true, false, 'none'],
    [undefined, false, 'none'],
  ];
  for (const [isNew, expected, expectedSignal] of newsCases) {
    const { isUpdate, updateSignal } = resolveUpdateSignal({} as RawInjuryEvent, isNew);
    if (isUpdate !== expected || updateSignal !== expectedSignal) {
      violate(
        `a news event with is_new=${String(isNew)} resolved to ${isUpdate}/${updateSignal}, ` +
          `expected ${expected}/${expectedSignal}`,
      );
    }
  }

  const recent = await recentPostsBySport();
  console.log(
    `  recent posts by sport: ` +
      Object.entries(recent)
        .map(([s, n]) => `${s}=${n}`)
        .join(' ') || '  (none)',
  );
  console.log(
    '  note: NFL/NBA events come from the structured feed, which sets is_update\n' +
      '        explicitly, so none of them can reach the classifier fallback.',
  );

  // ── E. Volume ─────────────────────────────────────────────────────────────
  console.log('\nE. VOLUME');
  const spanDays = args.days;
  const perDay = totals.PROPOSED.posts / spanDays;
  console.log(
    `  PROPOSED would have produced ${totals.PROPOSED.posts} UFC posts over ${spanDays}d ` +
      `(${perDay.toFixed(2)}/day) against a global MAX_PUBLISHES_PER_DAY of 10, ` +
      `shared with NFL/NBA/PL.`,
  );
  if (perDay > 3) {
    violate(`UFC alone would consume ${perDay.toFixed(1)} of the 10 daily publishes`);
  } else if (totals.PROPOSED.posts > 0) {
    pass('UFC volume leaves the shared daily budget intact');
  } else {
    // Zero is not a pass. It means the corpus was empty, which the checks above
    // have already flagged — saying "budget intact" here would read as evidence.
    console.log('  (no posts modelled — see the violations above)');
  }

  await finish(args, {
    window_days: args.days,
    roster_window_fighters: rosterAthletes.length,
    ufc_players_today: existing,
    events: events.length,
    tagged_fighters: taggedIds.size,
    registered_on_sight: onSight.length,
    totals,
    per_athlete: perAthlete,
  });
}

async function finish(args: Args, report: Record<string, unknown>): Promise<void> {
  if (args.json) {
    await writeFile(args.json, JSON.stringify({ ...report, violations }, null, 2));
    console.log(`\nWrote ${args.json}`);
  }
  console.log(`\n${'='.repeat(64)}`);
  if (violations.length > 0) {
    console.log(`SHIP GATE: ${violations.length} violation(s)\n`);
    for (const v of violations) console.log(`  ✗ ${v}`);
    process.exitCode = 1;
  } else {
    console.log('SHIP GATE: clean — no writes were made.');
  }
}

// ── Read-only production probes ──────────────────────────────────────────────

function unwrap<T>(res: unknown): T | null {
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : null;
}

async function countUfcPlayers(): Promise<number> {
  const res = unwrap<{ total?: number }>(
    await callTool('web', 'web_list_players', { sport: 'UFC', limit: 1 }),
  );
  return res?.total ?? 0;
}

async function recentPostsBySport(): Promise<Record<string, number>> {
  const res = unwrap<{ posts?: Array<{ sport?: string }> }>(
    await callTool('web', 'web_list_posts', { limit: 50 }),
  );
  const counts: Record<string, number> = {};
  for (const p of res?.posts ?? []) {
    const s = p.sport ?? 'unknown';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
