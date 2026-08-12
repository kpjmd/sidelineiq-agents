import { ESPNInjurySource } from './espn-base.js';
import type { SportKey } from '../../types.js';

export class ESPNNFLSource extends ESPNInjurySource {
  readonly name = 'espn-nfl';
  protected readonly sport: SportKey = 'NFL';
  protected readonly url =
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
  protected readonly leaguePath = 'football/nfl';
  // 32 franchises, fixed by the CBA. 30 leaves headroom without admitting a
  // truncated response.
  readonly expectedMinTeams = 30;
}
