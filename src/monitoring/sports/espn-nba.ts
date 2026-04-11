import { ESPNInjurySource } from './espn-base.js';
import type { SportKey } from '../../types.js';

export class ESPNNBASource extends ESPNInjurySource {
  readonly name = 'espn-nba';
  protected readonly sport: SportKey = 'NBA';
  protected readonly url =
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
}
