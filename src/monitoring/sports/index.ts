import type { SportKey } from '../../types.js';
import { MultiSource } from './multi-source.js';
import { ESPNNFLSource } from './espn-nfl.js';
import { NewsAPINFLSource } from './newsapi-nfl.js';
import { ESPNNBASource } from './espn-nba.js';
import { ESPNPremierLeagueSource } from './espn-premier-league.js';
import { ESPNUFCSource } from './espn-ufc.js';
import { XInsiderNFLSource } from './x-insider-nfl.js';
import { XInsiderNBASource } from './x-insider-nba.js';

/**
 * Sport → data source registry.
 *
 * To add a new upstream source for any sport, append it to the array for
 * that sport. No changes to the poller, deduplicator, or agent are needed.
 */
export const SPORT_SOURCES: Record<SportKey, MultiSource> = {
  NFL: new MultiSource([new ESPNNFLSource(), new NewsAPINFLSource(), new XInsiderNFLSource()]),
  NBA: new MultiSource([new ESPNNBASource(), new XInsiderNBASource()]),
  PREMIER_LEAGUE: new MultiSource([new ESPNPremierLeagueSource()]),
  UFC: new MultiSource([new ESPNUFCSource()]),
};

export { MultiSource } from './multi-source.js';
export type { SportDataSource } from './multi-source.js';
