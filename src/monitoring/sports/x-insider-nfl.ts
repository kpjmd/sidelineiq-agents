import { XInsiderSource } from './x-insider-base.js';
import type { SportKey } from '../../types.js';
import type { XInsider } from '../../config/x-insiders.js';
import { X_INSIDER_ALLOWLIST } from '../../config/x-insiders.js';
import { NFL_TEAM_NAMES } from './newsapi-nfl.js';
import { buildBlocklist } from './text-extraction.js';

export class XInsiderNFLSource extends XInsiderSource {
  readonly name = 'x-insider-nfl';
  protected readonly sport: SportKey = 'NFL';
  protected readonly insiders: XInsider[] = X_INSIDER_ALLOWLIST.NFL;
  protected readonly teamNames = NFL_TEAM_NAMES;
  protected readonly blocklist = buildBlocklist([...NFL_TEAM_NAMES, 'NFL']);
}
