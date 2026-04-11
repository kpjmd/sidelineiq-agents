import { ESPNInjurySource } from './espn-base.js';
import type { SportKey } from '../../types.js';

export class ESPNPremierLeagueSource extends ESPNInjurySource {
  readonly name = 'espn-premier-league';
  protected readonly sport: SportKey = 'PREMIER_LEAGUE';
  protected readonly url =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries';
}
