import 'dotenv/config';
import express from 'express';
import { initializeMCPClients, disconnectAll, getServerStatus } from './utils/mcp-client-manager.js';
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
    injury_severity: 'MILD',
    content_type: 'BREAKING',
    headline: '[E2E TEST] Mock athlete reports mild ankle sprain in practice',
    clinical_summary:
      'This is an automated end-to-end test post from sidelineiq-agents. A Grade 1 lateral ankle sprain was reported during practice. ATFL involvement suspected. Ice, compression, and rest recommended.',
    return_to_play: {
      timeline: '1-2 weeks',
      probability: 0.95,
      factors: ['Grade 1 sprain', 'No structural damage', 'Good prior conditioning'],
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
