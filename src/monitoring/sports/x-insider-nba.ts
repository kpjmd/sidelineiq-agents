import { XInsiderSource } from './x-insider-base.js';
import type { SportKey } from '../../types.js';
import type { XInsider } from '../../config/x-insiders.js';
import { X_INSIDER_ALLOWLIST } from '../../config/x-insiders.js';
import { buildBlocklist } from './text-extraction.js';

// Full team names for extractTeam() — short nicknames only, case-sensitive.
export const NBA_TEAM_NAMES = [
  'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets',
  'Pistons', 'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat',
  'Bucks', 'Timberwolves', 'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns',
  'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards',
];

export class XInsiderNBASource extends XInsiderSource {
  readonly name = 'x-insider-nba';
  protected readonly sport: SportKey = 'NBA';
  protected readonly insiders: XInsider[] = X_INSIDER_ALLOWLIST.NBA;
  protected readonly teamNames = NBA_TEAM_NAMES;
  protected readonly blocklist = buildBlocklist([...NBA_TEAM_NAMES, 'NBA']);
}
