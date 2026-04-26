import 'dotenv/config';
import express from 'express';
import { initializeMCPClients, disconnectAll, getServerStatus, callTool, isServerAvailable } from './utils/mcp-client-manager.js';
import { publishInjuryPost, publishApprovedDeepDive } from './utils/publishing-pipeline.js';
import { startPolling, stopPolling, pollSport } from './monitoring/poller.js';
import { processInjuryEvent } from './agents/injury-intelligence/agent.js';
import { startDeepDiveScheduler, stopDeepDiveScheduler } from './monitoring/deep-dive-scheduler.js';
import { startMentionMonitor, stopMentionMonitor } from './agents/social/mention-monitor-loop.js';
import type { InjuryPostContent, InjurySeverity, SportKey, RawInjuryEvent, ClassificationResult } from './types.js';

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    servers: getServerStatus(),
  });
});

app.post('/test/publish', async (_req, res) => {
  const mockContent: InjuryPostContent = {
    athlete_name: '[E2E TEST] Mock Athlete',
    sport: 'NFL',
    team: 'Test Team',
    injury_type: 'Ankle sprain',
    injury_severity: 'MINOR',
    content_type: 'BREAKING',
    headline: '[E2E TEST] Mock athlete reports mild ankle sprain in practice',
    clinical_summary:
      'This is an automated end-to-end test post from sidelineiq-agents. A Grade 1 lateral ankle sprain was reported during practice. ATFL involvement suspected. Ice, compression, and rest recommended.',
    return_to_play: {
      min_weeks: 1,
      max_weeks: 2,
      probability_week_2: 0.90,
      probability_week_4: 0.98,
      probability_week_8: 0.99,
      confidence: 0.90,
    },
    confidence: 0.90,
  };

  try {
    const result = await publishInjuryPost(mockContent);
    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

app.post('/test/deep-dive', async (req, res) => {
  const { athlete_name, sport, team, injury_type, injury_description } = req.body as Record<string, string>;

  if (!athlete_name || !sport || !team || !injury_type || !injury_description) {
    res.status(400).json({
      success: false,
      error: 'Required fields: athlete_name, sport, team, injury_type, injury_description',
    });
    return;
  }

  const sportKey = sport.toUpperCase().replace(/-/g, '_') as SportKey;

  const rawEvent: RawInjuryEvent = {
    athlete_name,
    sport: sportKey,
    team,
    injury_description: `${injury_type}: ${injury_description}`,
    source_url: 'test://deep-dive-endpoint',
    reported_at: new Date(),
  };

  const classified: ClassificationResult = {
    is_injury_event: true,
    confidence: 0.95,
    sport: sportKey,
    athlete_name,
    team,
    injury_description: `${injury_type}: ${injury_description}`,
    content_type: 'DEEP_DIVE',
    is_new: true,
    raw_event: rawEvent,
  };

  try {
    const post = await processInjuryEvent(classified);
    if (!post) {
      res.status(500).json({ success: false, error: 'Agent returned null — check server logs' });
      return;
    }
    // Force content_type to DEEP_DIVE in case agent overrode it
    post.content_type = 'DEEP_DIVE';
    const result = await publishInjuryPost(post);
    res.json({ success: true, post, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * Called by the frontend admin approve route after web_approve_injury_post succeeds.
 * Receives the full post row returned by the MCP tool and handles social publishing.
 *
 * Flow:
 *   Frontend: web_approve_injury_post(post_id) → fire-and-forget POST here
 *   Agents: reconstruct InjuryPostContent → publish Farcaster + X → write hashes back
 */
app.post('/admin/approve/:post_id', async (req, res) => {
  const { post_id } = req.params;
  const body = req.body as Record<string, unknown>;
  const post = body.post as Record<string, unknown> | undefined;

  if (!post) {
    res.status(400).json({
      success: false,
      error: 'Request body must include { post: <approved post object from web_approve_injury_post> }',
    });
    return;
  }

  // Reconstruct RTP from whichever shape the MCP tool returns:
  //   web_create_injury_post / seed → nested return_to_play_estimate object
  //   web_approve_injury_post       → flat DB columns (return_to_play_min_weeks, etc.)
  const rtpNested = post.return_to_play_estimate as Record<string, unknown> | undefined;
  const rtpRaw: Record<string, unknown> = rtpNested ?? {
    min_weeks:          post.return_to_play_min_weeks,
    max_weeks:          post.return_to_play_max_weeks,
    probability_week_2: post.return_to_play_probability_week_2,
    probability_week_4: post.return_to_play_probability_week_4,
    probability_week_8: post.return_to_play_probability_week_8,
    confidence:         post.return_to_play_confidence ?? post.confidence,
  };

  if (rtpRaw.min_weeks === undefined || rtpRaw.min_weeks === null) {
    res.status(400).json({ success: false, error: 'Post missing RTP data' });
    return;
  }

  const content: InjuryPostContent = {
    athlete_name: String(post.athlete_name ?? ''),
    sport: String(post.sport ?? ''),
    team: String(post.team ?? ''),
    injury_type: String(post.injury_type ?? ''),
    injury_severity: (post.injury_severity as InjurySeverity) ?? 'UNKNOWN',
    content_type: (post.content_type as InjuryPostContent['content_type']) ?? 'DEEP_DIVE',
    headline: String(post.headline ?? ''),
    clinical_summary: String(post.clinical_summary ?? ''),
    return_to_play: {
      min_weeks: Number(rtpRaw.min_weeks ?? 0),
      max_weeks: Number(rtpRaw.max_weeks ?? 0),
      probability_week_2: Number(rtpRaw.probability_week_2 ?? 0),
      probability_week_4: Number(rtpRaw.probability_week_4 ?? 0),
      probability_week_8: Number(rtpRaw.probability_week_8 ?? 0),
      confidence: Number(rtpRaw.confidence ?? 0),
    },
    confidence: Number(post.confidence ?? 0),
    ...(post.conflict_reason ? { conflict_reason: String(post.conflict_reason) } : {}),
    ...(post.team_timeline_weeks !== undefined ? { team_timeline_weeks: Number(post.team_timeline_weeks) } : {}),
    ...(post.parent_post_id ? { parent_post_id: String(post.parent_post_id) } : {}),
  };

  const slug = String(post.slug ?? '');
  const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');
  const postUrl = slug ? `${siteUrl}/post/${slug}` : '';
  const webPostId = String(post.post_id ?? post.id ?? post_id);

  console.log(`[Approve] Social publish triggered for post ${webPostId} (${content.content_type}: ${content.athlete_name})`);

  try {
    const result = await publishApprovedDeepDive(content, postUrl, webPostId);
    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Approve] Social publish failed for post ${webPostId}: ${message}`);
    res.status(500).json({ success: false, error: message });
  }
});

function extractSeedPostId(data: unknown): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = data as any;
    if (raw?.isError === true) {
      const errText = raw?.content?.[0]?.text ?? 'unknown MCP error';
      throw new Error(`MCP error: ${errText}`);
    }
    const text = raw?.content?.[0]?.text;
    if (!text) return null;
    const payload = JSON.parse(text) as Record<string, unknown>;
    const id = payload?.post_id ?? payload?.id;
    return typeof id === 'string' ? id : null;
  } catch (err) {
    throw err;
  }
}

app.post('/seed/test-posts', async (_req, res) => {
  if (!isServerAvailable('web')) {
    res.status(503).json({ success: false, error: 'Web MCP server unavailable' });
    return;
  }

  const results: Record<string, string | null> = {
    breaking_id: null,
    tracking_id: null,
    deep_dive_id: null,
    conflict_flag_id: null,
  };

  try {
    // Post 1 — BREAKING
    const breakingData = await callTool('web', 'web_create_injury_post', {
      athlete_name: '[SEED] Patrick Mahomes',
      sport: 'NFL',
      team: 'Kansas City Chiefs',
      injury_type: 'Ankle sprain',
      injury_severity: 'MINOR',
      content_type: 'BREAKING',
      headline: '[SEED] Mahomes exits practice early with ankle soreness',
      clinical_summary:
        'Patrick Mahomes was seen favoring his right ankle during Wednesday\'s practice and exited early. ' +
        'Lateral ankle mechanism noted on video. Grade 1 ATFL sprain suspected. Ice and compression applied on-field. ' +
        'No imaging confirmed yet. Status officially listed as day-to-day.',
      return_to_play_estimate: {
        min_weeks: 1,
        max_weeks: 2,
        probability_week_2: 0.85,
        probability_week_4: 0.97,
        probability_week_8: 0.99,
        confidence: 0.88,
      },
      confidence: 0.88,
      status: 'PUBLISHED',
    });
    results.breaking_id = extractSeedPostId(breakingData);
    console.log(`[Seed] BREAKING created: ${results.breaking_id}`);

    // Post 2 — TRACKING (parent_post_id links back to BREAKING)
    const trackingData = await callTool('web', 'web_create_injury_post', {
      athlete_name: '[SEED] Patrick Mahomes',
      sport: 'NFL',
      team: 'Kansas City Chiefs',
      injury_type: 'Ankle sprain',
      injury_severity: 'MINOR',
      content_type: 'TRACKING',
      headline: '[SEED] Mahomes ankle update: full practice Wednesday, game status upgraded',
      clinical_summary:
        'Patrick Mahomes returned to full practice two days after the initial ankle soreness report. ' +
        'Coaching staff confirmed no structural concern — ATFL stress reaction, not a full sprain. ' +
        'Game-day status upgraded from questionable to probable. Recovery trajectory consistent with OTM Grade 1 ATFL classification.',
      return_to_play_estimate: {
        min_weeks: 1,
        max_weeks: 2,
        probability_week_2: 0.85,
        probability_week_4: 0.97,
        probability_week_8: 0.99,
        confidence: 0.91,
      },
      parent_post_id: results.breaking_id ?? undefined,
      confidence: 0.91,
      status: 'PUBLISHED',
    });
    results.tracking_id = extractSeedPostId(trackingData);
    console.log(`[Seed] TRACKING created: ${results.tracking_id}`);

    // Post 3 — DEEP_DIVE (all 6 RTP fields + md_review_required)
    const deepDiveData = await callTool('web', 'web_create_injury_post', {
      athlete_name: '[SEED] Ja Morant',
      sport: 'NBA',
      team: 'Memphis Grizzlies',
      injury_type: 'Shoulder labrum tear',
      injury_severity: 'SEVERE',
      content_type: 'DEEP_DIVE',
      headline: '[SEED] Ja Morant shoulder labrum: clinical breakdown and RTP outlook',
      clinical_summary:
        'Ja Morant\'s reported anterior shoulder labral tear represents a significant structural injury with direct implications for his explosive drive-and-finish game. ' +
        'The labrum functions as the primary static stabilizer of the glenohumeral joint — a tear compromises the socket depth and increases subluxation risk under the high-velocity load patterns of NBA play. ' +
        'Three-axis OTM classification: Structural/Moderate-Severe/In-Season. Surgical repair (Bankart procedure) is the standard intervention for athletes with this mechanism and severity. ' +
        'Post-op protocol: 6 weeks immobilization → 12-week progressive ROM and rotator cuff rehab → return-to-sport testing. ' +
        'Recurrence risk without surgery: ~75% in athletes under 25 with this mechanism. Surgical repair reduces recurrence to ~10–15%. ' +
        'Grade CONFIRMED via MRI per team report.',
      return_to_play_estimate: {
        min_weeks: 6,
        max_weeks: 10,
        probability_week_2: 0.05,
        probability_week_4: 0.35,
        probability_week_8: 0.78,
        confidence: 0.71,
      },
      md_review_required: true,
      confidence: 0.71,
      status: 'PENDING_REVIEW',
    });
    results.deep_dive_id = extractSeedPostId(deepDiveData);
    console.log(`[Seed] DEEP_DIVE created: ${results.deep_dive_id}`);

    // Flag the DEEP_DIVE for MD review
    if (results.deep_dive_id) {
      try {
        await callTool('web', 'web_flag_for_md_review', {
          post_id: results.deep_dive_id,
          reason: 'confidence 0.71 below threshold 0.75',
          confidence_score: 0.71,
          flagged_by: 'seed-script',
        });
        console.log('[Seed] DEEP_DIVE flagged for MD review');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Seed] MD review flag failed (non-fatal): ${message}`);
      }
    }

    // Post 4 — CONFLICT_FLAG (team_timeline_weeks: 2 vs OTM min: 6, gap triggers conflict display)
    const conflictData = await callTool('web', 'web_create_injury_post', {
      athlete_name: '[SEED] Erling Haaland',
      sport: 'PREMIER_LEAGUE',
      team: 'Manchester City',
      injury_type: 'MCL sprain',
      injury_severity: 'MODERATE',
      content_type: 'CONFLICT_FLAG',
      headline: '[SEED] OTM 🚩 Haaland MCL: team says 2 weeks, OTM says 6–8',
      clinical_summary:
        'Manchester City\'s medical team has publicly projected a 2-week return timeline for Erling Haaland\'s medial knee injury. ' +
        'OTM three-axis classification of a Grade II MCL sprain with valgus mechanism yields a 6–8 week evidence-based RTP window. ' +
        'The 4-week gap between team projection and OTM estimate exceeds the 2-week conflict threshold. ' +
        'Possible explanations: team projecting optimistic training-room return rather than match fitness, partial-thickness vs full-thickness discrepancy in imaging read, or early return under pain management for high-stakes fixtures. ' +
        'Grade INFERRED — no MRI confirmation in public reports. Monitor for official imaging update.',
      return_to_play_estimate: {
        min_weeks: 6,
        max_weeks: 8,
        probability_week_2: 0.12,
        probability_week_4: 0.38,
        probability_week_8: 0.82,
        confidence: 0.79,
      },
      team_timeline_weeks: 2,
      conflict_reason:
        'Team medical staff report a 2-week return timeline. OTM three-axis classification of a Grade II MCL sprain estimates 6–8 weeks based on valgus mechanism and ligament fiber involvement — a 4-week gap that exceeds the OTM conflict threshold.',
      confidence: 0.79,
      status: 'PUBLISHED',
    });
    results.conflict_flag_id = extractSeedPostId(conflictData);
    console.log(`[Seed] CONFLICT_FLAG created: ${results.conflict_flag_id}`);

    res.json({ success: true, posts: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Seed] Error during seed: ${message}`);
    res.status(500).json({ success: false, error: message, partial: results });
  }
});

const VALID_SPORTS: SportKey[] = ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'];

app.post('/poll/:sport', async (req, res) => {
  const raw = (req.params.sport || '').toUpperCase().replace(/-/g, '_');
  if (!VALID_SPORTS.includes(raw as SportKey)) {
    res.status(400).json({
      success: false,
      error: `Invalid sport '${req.params.sport}'. Expected one of: ${VALID_SPORTS.join(', ')}`,
    });
    return;
  }

  try {
    const summary = await pollSport(raw as SportKey);
    res.json({ success: true, sport: raw, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

async function start(): Promise<void> {
  app.listen(PORT, () => {
    console.log(`[Server] SidelineIQ Agents running on port ${PORT}`);
  });

  console.log('[Server] Initializing MCP clients...');
  await initializeMCPClients();

  if (process.env.POLLING_ENABLED !== 'false') {
    startPolling();
  } else {
    console.log('[Server] POLLING_ENABLED=false — polling loop not started');
  }

  if (process.env.DEEP_DIVE_ENABLED !== 'false') {
    startDeepDiveScheduler();
  } else {
    console.log('[Server] DEEP_DIVE_ENABLED=false — deep-dive scheduler not started');
  }

  if (process.env.SOCIAL_MONITOR_ENABLED !== 'false') {
    startMentionMonitor();
  } else {
    console.log('[Server] SOCIAL_MONITOR_ENABLED=false — mention monitor not started');
  }
}

function shutdown(): void {
  console.log('[Server] Shutting down...');
  stopPolling();
  stopDeepDiveScheduler();
  stopMentionMonitor();
  disconnectAll()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});

export { app };
