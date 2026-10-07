/**
 * Text for the weekly resolution card and the monthly scoreboard card (spec
 * "Card content spec → Resolution and scoreboard cards", "Publication",
 * "Voice and social integration → No prediction without an entry ID").
 *
 * TEXT ONLY, for the physician to post by hand through the same confirm step
 * (decision S3-6). Nothing here posts, and nothing here may: the social grep in
 * tests/ledger-publish.test.ts covers this file. Every number comes from a
 * confirmed resolution row and the scoring helper; every fixed string comes
 * from copy.ts.
 */
import { LEDGER_COPY } from './copy.js';
import { LEDGER_FIELD_SPECS, type LedgerField } from './fields.js';
import {
  BRIER_FIELDS,
  scoreboardLine,
  summarizeLedger,
  type ScoreboardSummary,
  type ScoringForecastRow,
  type ScoringResolutionRow,
} from './scoring.js';

export interface CardResolutionRow extends ScoringResolutionRow {
  outcome_date?: string | Date | null;
  confirmed_at?: string | Date | null;
  evidence_url?: string | null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const dateOf = (v: string | Date | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};

/** The actual, in words. */
export function outcomeWords(field: LedgerField, outcome: number): string {
  switch (field) {
    case 'F1':
      return outcome === 1 ? 'placed on IR' : 'not placed on IR';
    case 'F2':
    case 'F3':
      return outcome === 1 ? 'played' : 'did not play';
    case 'F4':
      return `${outcome} game${outcome === 1 ? '' : 's'} missed`;
    case 'F5':
      return outcome === 1 ? 'same-site re-injury with a game missed' : 'no qualifying re-injury';
  }
}

function staticFooter(): string[] {
  return [LEDGER_COPY.credit, LEDGER_COPY.publisher, LEDGER_COPY.ai_disclosure, LEDGER_COPY.card_disclaimer];
}

/**
 * Resolutions confirmed on or after `since` (YYYY-MM-DD, by confirmed_at),
 * each as "entry · field · forecast · actual". The forecast printed is v1 —
 * the headline board — with the latest-before-freeze revision beside it when
 * one counted and differs.
 */
export function buildResolutionCardText(forecasts: ScoringForecastRow[], resolutions: CardResolutionRow[], since: string): string {
  const summary = summarizeLedger(forecasts, resolutions);
  const obs = new Map(summary.observations.map((o) => [`${o.entry_id}|${o.field}`, o]));
  const inWindow = resolutions
    .filter((r) => r.status === 'resolved' || r.status === 'void')
    .filter((r) => (dateOf(r.confirmed_at) ?? '') >= since)
    .sort((a, b) => a.entry_id.localeCompare(b.entry_id) || a.field.localeCompare(b.field));

  const lines: string[] = [`${LEDGER_COPY.resolution_card_heading} (since ${since})`, ''];
  if (inWindow.length === 0) lines.push('No fields resolved in this window.');
  for (const r of inWindow) {
    const label = `${r.entry_id} · ${r.field} ${LEDGER_FIELD_SPECS[r.field].label}`;
    if (r.status === 'void') {
      lines.push(`${label} · ${LEDGER_COPY.void_label.toLowerCase()}: ${r.void_reason ?? 'unspecified'}`);
      continue;
    }
    const o = obs.get(`${r.entry_id}|${r.field}`);
    if (!o) {
      const ex = summary.exclusions.find((e) => e.entry_id === r.entry_id && e.field === r.field);
      lines.push(`${label} · excluded: ${ex?.reason ?? 'not scoreable'}`);
      continue;
    }
    let forecast: string;
    if (r.field === 'F4') {
      const a = o.initial_f4!;
      forecast = `${a.point} (${a.low}–${a.high})`;
      const b = o.latest_f4!;
      if (o.latest_version !== o.initial_version && (b.point !== a.point || b.low !== a.low || b.high !== a.high)) forecast += `; v${o.latest_version} ${b.point} (${b.low}–${b.high})`;
    } else {
      forecast = pct(o.initial_p!);
      if (o.latest_version !== o.initial_version && o.latest_p !== o.initial_p) forecast += `; v${o.latest_version} ${pct(o.latest_p!)}`;
    }
    lines.push(`${label} · forecast ${forecast} · actual: ${outcomeWords(r.field, o.outcome)}`);
  }
  lines.push('', ...staticFooter());
  return lines.join('\n');
}

function boardLines(summary: ScoreboardSummary, kind: 'initial' | 'latest'): string[] {
  const b = summary[kind];
  const out = BRIER_FIELDS.map((f) => {
    const c = b.brier[f];
    return `${f} ${LEDGER_FIELD_SPECS[f].label}: Brier ${c.brier === null ? '—' : c.brier.toFixed(3)} (n=${c.n})`;
  });
  out.push(
    `F4 ${LEDGER_FIELD_SPECS.F4.label}: MAE ${b.f4.mae === null ? '—' : b.f4.mae.toFixed(2)} games, 80% interval hit ${b.f4.coverage === null ? '—' : pct(b.f4.coverage)} (n=${b.f4.n})`,
  );
  return out;
}

/** Both boards over the same n, the revision delta, voids and exclusions. */
export function buildScoreboardCardText(summary: ScoreboardSummary, asOf: string): string {
  const d = summary.revision_delta;
  const delta = BRIER_FIELDS.map((f) => `${f} ${d.brier[f] === null ? '—' : (d.brier[f]! > 0 ? '+' : '') + d.brier[f]!.toFixed(3)}`).join(' · ');
  const lines = [
    `${LEDGER_COPY.scoreboard_card_heading} (as of ${asOf})`,
    '',
    `Entries scored: ${summary.entries_scored} · open fields: ${summary.open_fields}`,
    '',
    `${LEDGER_COPY.initial_board_label}:`,
    ...boardLines(summary, 'initial'),
    '',
    `${LEDGER_COPY.latest_board_label}:`,
    ...boardLines(summary, 'latest'),
    '',
    `${LEDGER_COPY.revision_delta_label}: ${delta} · F4 MAE ${d.f4_mae === null ? '—' : (d.f4_mae > 0 ? '+' : '') + d.f4_mae.toFixed(2)}`,
  ];
  if (summary.voids.length > 0) lines.push('', `${LEDGER_COPY.void_label}: ${summary.voids.map((v) => `${v.entry_id} ${v.field} (${v.void_reason})`).join('; ')}`);
  if (summary.exclusions.length > 0) lines.push(`Excluded: ${summary.exclusions.map((e) => `${e.entry_id} ${e.field} (${e.reason})`).join('; ')}`);
  const line = scoreboardLine(summary);
  lines.push('', line ?? LEDGER_COPY.scoreboard_floor_note, LEDGER_COPY.export_note, '', ...staticFooter());
  return lines.join('\n');
}
