import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Works from both src/utils/ (dev) and dist/utils/ (compiled)
const SKILLS_DIR = join(__dirname, '../../skills');
const REFERENCES_DIR = join(SKILLS_DIR, 'references');

const SPORT_FILE_MAP: Record<string, string> = {
  NFL: 'nfl-injuries.md',
  NBA: 'nba-injuries.md',
  PREMIER_LEAGUE: 'premier-league-injuries.md',
  UFC: 'ufc-injuries.md',
};

export interface SkillContext {
  core: string;
  rtpTables: string;
  sportReference: string | null;
  allReferences: Record<string, string>;
}

/**
 * Loads the full skill context for an injury processing run.
 * Reads the references/ directory dynamically — adding a new .md file
 * there makes it available without any code changes.
 *
 * @param sport  Optional sport key (NFL | NBA | PREMIER_LEAGUE | UFC).
 *               When provided, the matching sport reference file is
 *               returned in `sportReference`.
 */
export async function loadSkillContext(sport?: string): Promise<SkillContext> {
  const [core, referenceFiles] = await Promise.all([
    readFile(join(SKILLS_DIR, 'SKILL.md'), 'utf-8'),
    readdir(REFERENCES_DIR),
  ]);

  const mdFiles = referenceFiles.filter((f) => f.endsWith('.md'));

  const entries = await Promise.all(
    mdFiles.map(async (file) => {
      const content = await readFile(join(REFERENCES_DIR, file), 'utf-8');
      return [file, content] as [string, string];
    })
  );

  const allReferences = Object.fromEntries(entries);

  const rtpTables = allReferences['rtp-probability-tables.md'] ?? '';

  let sportReference: string | null = null;
  if (sport) {
    const sportFile = SPORT_FILE_MAP[sport.toUpperCase()];
    if (sportFile) {
      sportReference = allReferences[sportFile] ?? null;
      if (!sportReference) {
        console.warn(`[SkillLoader] Sport reference file not found: ${sportFile}`);
      }
    } else {
      console.warn(`[SkillLoader] No reference file mapped for sport: ${sport}`);
    }
  }

  return { core, rtpTables, sportReference, allReferences };
}

/**
 * Returns the names of all currently available reference files.
 * Useful for logging and health checks.
 */
export async function listReferenceFiles(): Promise<string[]> {
  const files = await readdir(REFERENCES_DIR);
  return files.filter((f) => f.endsWith('.md'));
}
