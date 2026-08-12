import { ESPNInjurySource } from './espn-base.js';
import type { SportKey } from '../../types.js';

export class ESPNPremierLeagueSource extends ESPNInjurySource {
  readonly name = 'espn-premier-league';
  protected readonly sport: SportKey = 'PREMIER_LEAGUE';
  protected readonly url =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries';
  protected readonly leaguePath = 'soccer/eng.1';
  // 20 clubs. 18 is the loosest floor that still rejects a truncated feed —
  // three simultaneous relegations (the real case this guard has to survive)
  // still leaves 17 returned clubs plus 3 promoted ones, i.e. 20.
  readonly expectedMinTeams = 18;
}
