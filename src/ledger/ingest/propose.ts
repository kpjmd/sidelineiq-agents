/**
 * Pure: turn published forecast rows, their open resolutions and the fetched
 * public facts into resolution PROPOSALS (spec "Implementation handoff →
 * Automation boundary": "Ingest proposes; the physician confirms").
 *
 * All judgement lives in `src/ledger/rules.ts` (the pre-registered rules). This
 * module only builds the rules' inputs from stored rows, maps each decision onto
 * `web_propose_ledger_resolution`'s input, and reports what it held back and
 * why. It performs no I/O and has no path to a resolution.
 *
 * Identity (preregistration "Identity"): gamebook and injury-report fields need
 * the row's `pfr_id` / `gsis_id`, attached at confirm or afterwards through
 * the physician's linkage tool (mcp migration 028). A row without them is `unresolvable` for those
 * fields and is SURFACED; nothing here looks a player up by name. The one name
 * read in the ingest is the transaction attribution (espn-transactions.ts,
 * decision S3-4), whose sentence travels with the proposal as evidence.
 */
import { LEDGER_FIELDS, type LedgerField } from '../fields.js';
import { type IsoDate, isIsoDate } from '../dates.js';
import {
  type Evidence,
  type FieldDecision,
  type LedgerEntryContext,
  type ResolutionFacts,
  resolveField,
  teamRegularSeasonGames,
} from '../rules.js';

/** Bump when the mapping below (not the rules) changes. Stored on every proposal's evidence. */
export const LEDGER_INGEST_VERSION = 1;

/** A published forecast row as `web_export_ledger` returns it (NUMERIC/DATE may arrive as strings). */
export interface IngestForecastRow {
  id: string;
  entry_id: string;
  version: number | string;
  status?: string;
  published_at: string | Date;
  player: string;
  team: string;
  injury_date: string | Date;
  reported_injury: string;
  base_rate_row: string;
  espn_athlete_id?: string | null;
  gsis_id?: string | null;
  pfr_id?: string | null;
  nflverse_team?: string | null;
  season?: number | string | null;
}

export interface IngestResolutionRow {
  entry_id: string;
  field: string;
  status: 'open' | 'resolved' | 'void' | string;
}

/** Exactly the input of `web_propose_ledger_resolution`. */
export interface ResolutionProposal {
  entry_id: string;
  field: LedgerField;
  proposed_status: 'resolved' | 'void';
  proposed_outcome: number | null;
  outcome_date: IsoDate | null;
  freeze_at: string | null;
  void_reason: string | null;
  evidence_url: string | null;
  evidence: ProposalEvidence;
}

export interface ProposalEvidence {
  urls: string[];
  note: string;
  game_ids?: string[];
  sentence?: string;
  ingest_version: number;
  /** What the decision was computed against. Not part of the decision itself. */
  basis: { today: IsoDate; team: string; team_source: TeamSource; season: number; season_assumed: boolean; pfr_id: string | null; gsis_id: string | null };
}

export interface HeldField {
  entry_id: string;
  field: LedgerField;
  status: 'open' | 'unresolvable';
  reason: string;
  freeze_at: string | null;
}

/** Where the entry's nflverse team code came from (S3-2). */
export type TeamSource = 'nflverse_team' | 'team' | 'team_name' | 'none';

export interface EntryContextResult {
  ok: true;
  ctx: LedgerEntryContext;
  player: string;
  season_assumed: boolean;
  team_source: TeamSource;
}

export interface EntryContextFailure {
  ok: false;
  entry_id: string;
  reason: 'no_v1' | 'bad_injury_date' | 'bad_published_at';
}

// ── Normalisation ──────────────────────────────────────────────────────

function isoDateOf(v: string | Date): IsoDate | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return isIsoDate(s) ? s : null;
}

function instantOf(v: string | Date): string | null {
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const blank = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * The NFL season an injury date belongs to when the row does not say: a season
 * starts in September and runs into early the next year, so March onward is
 * the calendar year and January–February is the previous one (S3-3).
 */
export function seasonForDate(date: IsoDate): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 3 ? y : y - 1;
}

/** First non-null of a column across an entry's versions, newest first (linkage is set on every version, but be lenient). */
function pick<T>(versions: IngestForecastRow[], get: (r: IngestForecastRow) => T | null | undefined): T | null {
  for (const r of [...versions].reverse()) {
    const v = get(r);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * The rules' context for one entry. Keyed on v1: `injury_date`, `team`,
 * `reported_injury` and `base_rate_row` are the published forecast's, and
 * `v1_published_at` decides `forecast_after_freeze`.
 */
export function buildEntryContext(versions: IngestForecastRow[]): EntryContextResult | EntryContextFailure {
  const sorted = [...versions].sort((a, b) => Number(a.version) - Number(b.version));
  const v1 = sorted.find((r) => Number(r.version) === 1);
  const entryId = sorted[0]?.entry_id ?? '';
  if (!v1) return { ok: false, entry_id: entryId, reason: 'no_v1' };
  const injuryDate = isoDateOf(v1.injury_date);
  if (!injuryDate) return { ok: false, entry_id: entryId, reason: 'bad_injury_date' };
  const published = instantOf(v1.published_at);
  if (!published) return { ok: false, entry_id: entryId, reason: 'bad_published_at' };

  const seasonRaw = pick(sorted, (r) => (r.season === null || r.season === undefined ? null : Number(r.season)));
  const season = seasonRaw !== null && Number.isInteger(seasonRaw) ? seasonRaw : seasonForDate(injuryDate);
  const linked = blank(pick(sorted, (r) => blank(r.nflverse_team)));
  const team = (linked ?? blank(v1.team) ?? '').toUpperCase();

  return {
    ok: true,
    player: v1.player,
    season_assumed: seasonRaw === null,
    team_source: linked ? 'nflverse_team' : team ? 'team' : 'none',
    ctx: {
      entry_id: v1.entry_id,
      injury_date: injuryDate,
      team,
      season,
      pfr_id: blank(pick(sorted, (r) => blank(r.pfr_id))),
      gsis_id: blank(pick(sorted, (r) => blank(r.gsis_id))),
      reported_injury: v1.reported_injury,
      base_rate_row: v1.base_rate_row,
      v1_published_at: published,
    },
  };
}

/**
 * Resolve the entry's team to the code games.csv uses (S3-2). A linked
 * `nflverse_team` or a `team` that is already a scheduled code is kept. A team
 * NAME ("Baltimore Ravens") maps through the names ESPN prints for each club —
 * a team, never a player. Anything else stays unresolved, and
 * `proposeForEntry` then holds every field, F1 included.
 */
export function resolveEntryTeam(
  built: EntryContextResult,
  scheduledTeams: ReadonlySet<string>,
  teamNames: ReadonlyMap<string, readonly string[]>,
): EntryContextResult {
  if (scheduledTeams.has(built.ctx.team)) return built;
  const wanted = built.ctx.team.trim().toLowerCase();
  for (const [code, names] of teamNames) {
    if (names.some((n) => n.trim().toLowerCase() === wanted) && scheduledTeams.has(code)) {
      return { ...built, team_source: 'team_name', ctx: { ...built.ctx, team: code } };
    }
  }
  return built;
}

// ── Mapping ────────────────────────────────────────────────────────────

function evidenceOf(e: Evidence, basis: ProposalEvidence['basis']): ProposalEvidence {
  return {
    urls: [...e.urls],
    note: e.note,
    ...(e.game_ids ? { game_ids: [...e.game_ids] } : {}),
    ...(e.sentence ? { sentence: e.sentence } : {}),
    ingest_version: LEDGER_INGEST_VERSION,
    basis,
  };
}

/** One decision → a proposal, or a held field. */
export function toProposal(entryId: string, field: LedgerField, d: FieldDecision, basis: ProposalEvidence['basis']): ResolutionProposal | HeldField {
  switch (d.status) {
    case 'resolved':
      return {
        entry_id: entryId,
        field,
        proposed_status: 'resolved',
        proposed_outcome: d.outcome,
        outcome_date: d.resolved_at,
        freeze_at: d.freeze_at,
        void_reason: null,
        evidence_url: d.evidence.urls[0] ?? null,
        evidence: evidenceOf(d.evidence, basis),
      };
    case 'void':
      return {
        entry_id: entryId,
        field,
        proposed_status: 'void',
        proposed_outcome: null,
        outcome_date: null,
        freeze_at: d.freeze_at,
        void_reason: d.void_reason,
        evidence_url: d.evidence.urls[0] ?? null,
        evidence: evidenceOf(d.evidence, basis),
      };
    case 'open':
      return { entry_id: entryId, field, status: 'open', reason: d.reason, freeze_at: d.freeze_at };
    case 'unresolvable':
      return { entry_id: entryId, field, status: 'unresolvable', reason: d.reason, freeze_at: null };
  }
}

export const isProposal = (x: ResolutionProposal | HeldField): x is ResolutionProposal => 'proposed_status' in x;

export interface EntryProposals {
  entry_id: string;
  proposals: ResolutionProposal[];
  held: HeldField[];
}

/**
 * Apply the rules to the entry's OPEN fields only. A field that is resolved or
 * void in the database is never passed to the rules and can never be proposed.
 */
export function proposeForEntry(
  built: EntryContextResult,
  openFields: readonly LedgerField[],
  facts: ResolutionFacts,
): EntryProposals {
  const { ctx } = built;
  const basis: ProposalEvidence['basis'] = {
    today: facts.today,
    team: ctx.team,
    team_source: built.team_source,
    season: ctx.season,
    season_assumed: built.season_assumed,
    pfr_id: ctx.pfr_id,
    gsis_id: ctx.gsis_id,
  };
  const out: EntryProposals = { entry_id: ctx.entry_id, proposals: [], held: [] };
  // No schedule for the team means the team itself is unknown, and F1's
  // transaction attribution is scoped to it: a 0 there would be "we never
  // looked", not "no IR". Every field is held, F1 included.
  const scheduled = teamIsScheduled(ctx, facts);
  for (const field of LEDGER_FIELDS) {
    if (!openFields.includes(field)) continue;
    if (!scheduled) {
      out.held.push({ entry_id: ctx.entry_id, field, status: 'unresolvable', reason: 'no_schedule_for_team', freeze_at: null });
      continue;
    }
    const mapped = toProposal(ctx.entry_id, field, resolveField(field, ctx, facts), basis);
    if (isProposal(mapped)) out.proposals.push(mapped);
    else out.held.push(mapped);
  }
  return out;
}

/** The entry's open fields, in field order. Anything not literally 'open' is locked. */
export function openFieldsOf(entryId: string, resolutions: readonly IngestResolutionRow[]): LedgerField[] {
  const open = new Set(resolutions.filter((r) => r.entry_id === entryId && r.status === 'open').map((r) => r.field));
  return LEDGER_FIELDS.filter((f) => open.has(f));
}

/** True when the schedule knows the entry's team for its season — otherwise every gamebook field is unresolvable. */
export function teamIsScheduled(ctx: LedgerEntryContext, facts: ResolutionFacts): boolean {
  return teamRegularSeasonGames(facts.schedule, ctx.team, ctx.season).length > 0;
}

// ── The dry run's freeze-evidence gate ─────────────────────────────────

const TRANSACTION_VOIDS = new Set(['traded', 'released', 'retired', 'suspended']);

/**
 * Why a proposal would resolve or void a field without the evidence of the
 * moment it froze. Empty = sound. Gate (a) of ledger-ingest-dryrun.ts.
 *
 *  - every proposal: a parseable freeze_at, at or before `nowIso`, except the
 *    rule voids that have no freeze point by construction;
 *  - resolved: an outcome_date on or before today and at least one evidence URL;
 *  - F1 = 1 and every transaction void: the quoted sentence;
 *  - forecast_after_freeze: the freeze_at it was measured against.
 */
export function freezeEvidenceViolations(p: ResolutionProposal, nowIso: string): string[] {
  const v: string[] = [];
  const noFreezeByRule = p.proposed_status === 'void' && ['concussion_rule', 'no_next_game_this_season', 'no_return_this_season'].includes(p.void_reason ?? '');
  const freezeMs = p.freeze_at ? Date.parse(p.freeze_at) : NaN;
  if (!noFreezeByRule) {
    if (Number.isNaN(freezeMs)) {
      // A transaction void found before the field's freeze point is known (F4/F5 awaiting return) has no freeze_at yet.
      if (!(p.proposed_status === 'void' && TRANSACTION_VOIDS.has(p.void_reason ?? '') && (p.field === 'F4' || p.field === 'F5'))) v.push('no freeze_at');
    } else if (freezeMs > Date.parse(nowIso) && p.proposed_status === 'resolved') {
      v.push(`freeze_at ${p.freeze_at} is in the future`);
    }
  }
  if (p.proposed_status === 'resolved') {
    if (!p.outcome_date) v.push('no outcome_date');
    else if (p.outcome_date > p.evidence.basis.today) v.push(`outcome_date ${p.outcome_date} after today ${p.evidence.basis.today}`);
    if (p.evidence.urls.length === 0) v.push('no evidence url');
    if (p.field === 'F1' && p.proposed_outcome === 1 && !p.evidence.sentence) v.push('F1=1 without the IR sentence');
    if (p.proposed_outcome === null) v.push('no outcome');
  } else {
    if (!p.void_reason) v.push('void without a reason');
    if (TRANSACTION_VOIDS.has(p.void_reason ?? '') && !p.evidence.sentence) v.push(`${p.void_reason} void without the transaction sentence`);
  }
  return v;
}
