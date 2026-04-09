import 'dotenv/config';
import express from 'express';
import { initializeMCPClients, disconnectAll, getServerStatus, callTool, isServerAvailable } from './utils/mcp-client-manager.js';
import { publishInjuryPost } from './utils/publishing-pipeline.js';
import type { InjuryPostContent } from './types.js';

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

async function start(): Promise<void> {
  app.listen(PORT, () => {
    console.log(`[Server] SidelineIQ Agents running on port ${PORT}`);
  });

  console.log('[Server] Initializing MCP clients...');
  await initializeMCPClients();
}

function shutdown(): void {
  console.log('[Server] Shutting down...');
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
