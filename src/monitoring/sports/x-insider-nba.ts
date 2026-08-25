import { XInsiderSource } from './x-insider-base.js';
import type { SportKey } from '../../types.js';
import type { XInsider } from '../../config/x-insiders.js';
import { X_INSIDER_ALLOWLIST } from '../../config/x-insiders.js';
import { buildNameFilter } from './text-extraction.js';

// Full team names for extractTeam() — short nicknames only, case-sensitive.
export const NBA_TEAM_NAMES = [
  'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets',
  'Pistons', 'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat',
  'Bucks', 'Timberwolves', 'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns',
  'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards',
];

/**
 * The city/place half of each NBA team's name, from
 * .../basketball/nba/teams on 2026-08-24. These feed `teamTokens` only —
 * never the blocklist — because 'Orlando' and 'Dallas' are also real first
 * names. See buildNameFilter.
 */
export const NBA_TEAM_LOCATIONS = [
  'Atlanta', 'Boston', 'Brooklyn', 'Charlotte', 'Chicago', 'Cleveland', 'Dallas',
  'Denver', 'Detroit', 'Golden State', 'Houston', 'Indiana', 'Los Angeles',
  'Memphis', 'Miami', 'Milwaukee', 'Minnesota', 'New Orleans', 'New York',
  'Oklahoma City', 'Orlando', 'Philadelphia', 'Phoenix', 'Portland', 'Sacramento',
  'San Antonio', 'Toronto', 'Utah', 'Washington',
];

export const NBA_NAME_FILTER = buildNameFilter({
  teamNames: NBA_TEAM_NAMES,
  locations: NBA_TEAM_LOCATIONS,
  extraBlocklist: ['NBA'],
});

export class XInsiderNBASource extends XInsiderSource {
  readonly name = 'x-insider-nba';
  protected readonly sport: SportKey = 'NBA';
  protected readonly insiders: XInsider[] = X_INSIDER_ALLOWLIST.NBA;
  protected readonly teamNames = NBA_TEAM_NAMES;
  protected readonly nameFilter = NBA_NAME_FILTER;
}
