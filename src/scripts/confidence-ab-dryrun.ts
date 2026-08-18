// Measures what the emit_injury_post confidence fields actually produce, on
// real Sonnet calls, against a fixed set of events chosen to span the range
// the rubric is supposed to separate.
//
// This exists because the confidence rubric is a PROMPT change, and a prompt
// change is only as good as the distribution it produces. Over 439 stored posts
// the unanchored return_to_play.confidence collapsed onto one modal value
// (0.62, 20% of rows) and in every August row the two confidence fields were
// byte-identical — the model could not tell them apart. Whether the rubric
// fixes that is an empirical question, not a review question.
//
// READ-ONLY. It calls processInjuryEvent, which returns InjuryPostContent and
// does NOT publish — publishing is the caller's job (poller -> publishInjuryPost).
// Nothing is written to the database and nothing is cast.
//
// It needs ANTHROPIC_API_KEY, which is set in Railway and empty in the repo's
// .env, so run it in-container:
//
//   railway ssh -s sidelineiq-agents
//   npx tsx src/scripts/confidence-ab-dryrun.ts
//
// What to look for:
//   - post-level confidence should SPREAD. The two well-sourced, confirmed
//     events should land high (~0.85+); the unnamed-source and undisclosed-grade
//     events should land clearly lower. A flat column means the rubric did not
//     land.
//   - the two confidence columns should DIVERGE. `identical` counts rows where
//     the model emitted one number twice, which is the failure this replaces.
//   - `would_route` reflects the enforced MD_REVIEW_CONFIDENCE_THRESHOLD, plus
//     the independent SEVERE rule. A SEVERE event routes regardless of
//     confidence, so those rows say nothing about the rubric.

import 'dotenv/config';
import { processInjuryEvent } from '../agents/injury-intelligence/agent.js';
import { getMDReviewThreshold } from '../utils/publishing-pipeline.js';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import type { ClassificationResult, ContentType, SportKey } from '../types.js';

/**
 * Chosen so the post-level rubric has something to discriminate on: two
 * confirmed-and-unambiguous, two inferred-or-single-source, one undisclosed
 * grade, one routine confirmed minor. Severity is deliberately mixed so the
 * SEVERE routing rule can be told apart from the confidence rule.
 */
const EVENTS: Array<{
  athlete_name: string;
  sport: SportKey;
  team: string;
  injury_description: string;
  content_type: ContentType;
  /** What the post-level confidence SHOULD reflect, per the rubric. */
  expect: string;
}> = [
  {
    athlete_name: 'Jaylen Harrell',
    sport: 'NFL',
    team: 'Tennessee Titans',
    injury_description:
      'Torn ACL confirmed by MRI; placed on injured reserve, out for the season.',
    content_type: 'BREAKING',
    expect: 'high — confirmed by imaging, team statement, unambiguous',
  },
  {
    athlete_name: 'Sione Vaki',
    sport: 'NFL',
    team: 'Detroit Lions',
    injury_description:
      'Grade 1 ankle sprain confirmed by the team; expected back within two weeks.',
    content_type: 'BREAKING',
    expect: 'high — grade stated, team confirmed',
  },
  {
    athlete_name: 'Graham Mertz',
    sport: 'NFL',
    team: 'Houston Texans',
    injury_description:
      'Suspected ACL tear per an unnamed source; additional imaging pending, team has not confirmed.',
    content_type: 'BREAKING',
    expect: 'low — single anonymous source, diagnosis unconfirmed',
  },
  {
    athlete_name: 'Chase Bisontis',
    sport: 'NFL',
    team: 'Arizona Cardinals',
    injury_description: 'MCL tear in a preseason game, grade not disclosed by the team.',
    content_type: 'BREAKING',
    expect: 'mid — diagnosis named, grade inferred',
  },
  {
    athlete_name: 'Marcus Mariota',
    sport: 'NFL',
    team: 'Washington Commanders',
    injury_description:
      'Calf strain sustained in practice; team says day-to-day. Side not specified in the report.',
    content_type: 'BREAKING',
    expect: 'mid — confirmed but laterality unknown',
  },
  {
    athlete_name: 'Breece Hall',
    sport: 'NFL',
    team: 'New York Jets',
    injury_description:
      'One outlet reports a hamstring strain, another reports general soreness; no imaging announced.',
    content_type: 'BREAKING',
    expect: 'low — sources conflict on the diagnosis',
  },
];

function classify(e: (typeof EVENTS)[number]): ClassificationResult {
  return {
    is_injury_event: true,
    confidence: 0.9, // the CLASSIFIER's confidence — unrelated to the post's
    sport: e.sport,
    athlete_name: e.athlete_name,
    team: e.team,
    injury_description: e.injury_description,
    content_type: e.content_type,
    is_new: true,
    raw_event: {
      athlete_name: e.athlete_name,
      sport: e.sport,
      team: e.team,
      injury_description: e.injury_description,
      source_url: 'https://example.invalid/confidence-ab-dryrun',
      reported_at: new Date(),
    },
  };
}

async function main(): Promise<void> {
  await initializeMCPClients();
  const threshold = getMDReviewThreshold();
  console.log(`[ab] MD_REVIEW_CONFIDENCE_THRESHOLD = ${threshold}\n`);

  const rows: Array<Record<string, unknown>> = [];

  for (const e of EVENTS) {
    let post = null;
    try {
      post = await processInjuryEvent(classify(e));
    } catch (err) {
      console.error(`[ab] ${e.athlete_name}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const conf = post?.confidence ?? null;
    const rtpConf = post?.return_to_play?.confidence ?? null;
    const severity = post?.injury_severity ?? null;

    rows.push({
      athlete: e.athlete_name,
      expect: e.expect,
      confidence: conf,
      rtp_confidence: rtpConf,
      identical: conf != null && conf === rtpConf,
      severity,
      would_route:
        conf == null
          ? 'n/a'
          : severity === 'SEVERE'
            ? 'yes (SEVERE — independent of confidence)'
            : conf < threshold
              ? `yes (confidence ${conf} < ${threshold})`
              : 'no',
    });
  }

  console.log('athlete          conf   rtp    same   severity  routes');
  for (const r of rows) {
    console.log(
      String(r.athlete).padEnd(16),
      String(r.confidence ?? '—').padEnd(6),
      String(r.rtp_confidence ?? '—').padEnd(6),
      String(r.identical ? 'YES' : '-').padEnd(6),
      String(r.severity ?? '—').padEnd(9),
      r.would_route,
    );
  }

  const scored = rows.filter((r) => r.confidence != null);
  const identical = scored.filter((r) => r.identical).length;
  const values = scored.map((r) => Number(r.confidence));
  const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;

  console.log(`\n[ab] scored ${scored.length}/${EVENTS.length}`);
  console.log(`[ab] emitted the same number for both fields: ${identical}/${scored.length}`);
  console.log(`[ab] post-level confidence spread: ${spread.toFixed(2)}`);
  console.log(
    identical === scored.length
      ? '[ab] FAIL — the two fields are still indistinguishable to the model.'
      : spread < 0.15
        ? '[ab] WEAK — confidence barely varies across clearly different sourcing.'
        : '[ab] OK — the fields diverge and confidence tracks sourcing quality.',
  );
  console.log('\n[ab] Detail per event:');
  for (const r of rows) console.log(`  ${r.athlete}: expected ${r.expect}, got ${r.confidence}`);

  await disconnectAll();
}

main().catch((err) => {
  console.error('[ab] failed:', err);
  process.exit(1);
});
