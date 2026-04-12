import type { InjuryPostContent } from '../types.js';

const FARCASTER_CHAR_LIMIT = 320;
const TWITTER_CHAR_LIMIT = 280;

const ORTHOIQ_REFERRAL_URL = process.env.ORTHOIQ_REFERRAL_URL || 'https://orthoiq.com?ref=sidelineiq';
const ORTHOIQ_CTA = `\n\nDealing with a similar injury? Get a personalized consultation at OrthoIQ. ${ORTHOIQ_REFERRAL_URL}`;
const OTM_SIGNATURE = '— OrthoTriage Master | AI-generated analysis. Physician-founded.';

function truncateWithEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3).trimEnd() + '...';
}

function splitIntoChunks(text: string, maxLen: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.map((c) => truncateWithEllipsis(c, maxLen));
}

/**
 * Strips markdown formatting from text for social platform output.
 * The agent generates rich web-format clinical summaries; social posts
 * need plain text.
 *
 * Also strips OTM-specific structured annotation that Sonnet embeds in
 * clinical_summary for web rendering:
 *   [CLASSIFICATION: MYO / Grade 2 / LE — ...]
 *   [CONFIDENCE: Grade INFERRED ...]
 *   OTM THREE-AXIS CLASSIFICATION:   (section header lines)
 */
function stripMarkdown(text: string): string {
  return text
    // OTM bracket annotation: [ALL CAPS LABEL: content] — remove entirely
    .replace(/\[[A-Z][A-Z\s/]+:[^\]]*\]/g, '')
    // OTM / all-caps section header lines ending in colon (e.g. "OTM THREE-AXIS CLASSIFICATION:")
    .replace(/^(?:[A-Z][A-Z\s\-]+:)\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold**
    .replace(/\*([^*]+)\*/g, '$1')            // *italic*
    .replace(/#{1,6}\s+/gm, '')               // ## headings
    .replace(/^[-*+]\s+/gm, '')               // bullet points
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url)
    .replace(/`([^`]+)`/g, '$1')             // `code`
    .replace(/\n{3,}/g, '\n\n')              // collapse extra blank lines
    .trim();
}

/**
 * Extracts a short clinical anchor from the full summary.
 * Finds the last complete sentence that fits within maxChars.
 * Falls back to hard-truncation if no sentence boundary found.
 */
function shortClinicalAnchor(text: string, maxChars: number): string {
  const plain = stripMarkdown(text);
  if (plain.length <= maxChars) return plain;
  const window = plain.slice(0, maxChars);
  const lastEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? ')
  );
  if (lastEnd > maxChars * 0.4) return plain.slice(0, lastEnd + 1).trim();
  return window.trimEnd() + '...';
}

/**
 * BREAKING — 2-post thread.
 *
 * Post 1: headline + athlete/team/injury identity (the news hook)
 * Post 2: OTM clinical anchor + RTP range + signature
 *
 * Splitting into a thread ensures the full message is never truncated.
 * charLimit applies independently to each post so both fit within the
 * platform limit (280 chars on X, 320 on Farcaster).
 */
function buildBreakingThread(content: InjuryPostContent, charLimit: number): string[] {
  const rtp = content.return_to_play;

  const post1 = truncateWithEllipsis(
    [
      `🚨 ${content.headline}`,
      '',
      `${content.athlete_name} (${content.team}) — ${content.injury_type}`,
      `Severity: ${content.injury_severity}`,
    ].join('\n'),
    charLimit
  );

  // Reserve space for RTP line + signature + separating newlines (~90 chars)
  const anchorBudget = charLimit - 90;
  const anchor = shortClinicalAnchor(content.clinical_summary, anchorBudget);
  const rtpLine = `RTP: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;

  const post2 = truncateWithEllipsis(
    [anchor, '', rtpLine, '', OTM_SIGNATURE].join('\n'),
    charLimit
  );

  return [post1, post2];
}

/**
 * TRACKING — 2-post thread.
 *
 * Post 1: update headline + athlete
 * Post 2: clinical update anchor + current RTP window + signature
 */
function buildTrackingThread(content: InjuryPostContent, charLimit: number): string[] {
  const rtp = content.return_to_play;

  const post1 = truncateWithEllipsis(
    [
      `📋 UPDATE: ${content.headline}`,
      '',
      `${content.athlete_name} (${content.team})`,
    ].join('\n'),
    charLimit
  );

  const anchorBudget = charLimit - 90;
  const anchor = shortClinicalAnchor(content.clinical_summary, anchorBudget);
  const rtpLine = `RTP window: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;

  const post2 = truncateWithEllipsis(
    [anchor, '', rtpLine, '', OTM_SIGNATURE].join('\n'),
    charLimit
  );

  return [post1, post2];
}

function buildDeepDiveThread(content: InjuryPostContent, charLimit: number): string[] {
  const casts: string[] = [];

  // Cast 1: headline + injury overview
  casts.push(truncateWithEllipsis(
    `🔬 DEEP DIVE: ${content.headline}\n\n${content.athlete_name} (${content.team}) — ${content.injury_type} | Severity: ${content.injury_severity}`,
    charLimit
  ));

  // Cast 2-3: clinical detail (split if needed)
  const clinicalChunks = splitIntoChunks(content.clinical_summary, charLimit);
  for (const chunk of clinicalChunks.slice(0, 2)) {
    casts.push(chunk);
  }

  // Cast 4: RTP breakdown
  const rtp = content.return_to_play;
  casts.push(truncateWithEllipsis(
    `⏱️ Return to Play: ${rtp.min_weeks}-${rtp.max_weeks} weeks\nWk 2: ${Math.round(rtp.probability_week_2 * 100)}% | Wk 4: ${Math.round(rtp.probability_week_4 * 100)}% | Wk 8: ${Math.round(rtp.probability_week_8 * 100)}%`,
    charLimit
  ));

  // Final cast: OrthoIQ reference + OTM signature (required on DEEP_DIVE)
  casts.push(truncateWithEllipsis(`${ORTHOIQ_CTA.trim()}\n\n${OTM_SIGNATURE}`, charLimit));

  // Ensure 3-5 casts
  while (casts.length < 3) {
    casts.splice(casts.length - 1, 0, truncateWithEllipsis(content.clinical_summary, charLimit));
  }
  if (casts.length > 5) {
    // Keep first 4 + final OrthoIQ cast
    const final = casts[casts.length - 1];
    casts.length = 4;
    casts.push(final);
  }

  return casts;
}

// CONFLICT_FLAG — Farcaster: single long-form cast with OTM 🚩 sections
function buildConflictFarcasterCast(content: InjuryPostContent, charLimit: number): string {
  const rtp = content.return_to_play;
  const teamLine = content.team_timeline_weeks != null
    ? `Team timeline: ${content.team_timeline_weeks} weeks`
    : 'Team timeline: not disclosed';
  const otmLine = `OTM read: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;
  const deltaLine = content.team_timeline_weeks != null
    ? `Delta: ${Math.abs(content.team_timeline_weeks - rtp.max_weeks)}+ weeks — conflict threshold met`
    : 'Delta: exceeds 2-week conflict threshold';

  const parts = [
    `OTM 🚩 ${content.athlete_name}`,
    '',
    `${content.team} says ${content.team_timeline_weeks != null ? `${content.team_timeline_weeks} weeks` : 'day-to-day'}. That's not what the biology says.`,
    '',
    'THE INJURY',
    stripMarkdown(content.clinical_summary),
    '',
    'THE GAP',
    teamLine,
    otmLine,
    deltaLine,
    '',
    'WHY IT MATTERS',
    content.conflict_reason ?? 'OTM clinical estimate diverges from team disclosure.',
    '',
    OTM_SIGNATURE,
  ];
  return truncateWithEllipsis(parts.join('\n'), charLimit);
}

// CONFLICT_FLAG — Twitter: 5-post thread
function buildConflictTwitterThread(content: InjuryPostContent, charLimit: number): string[] {
  const rtp = content.return_to_play;
  const teamWeeks = content.team_timeline_weeks;
  const teamDisclosure = teamWeeks != null ? `${teamWeeks} weeks` : 'day-to-day';
  const delta = teamWeeks != null ? Math.abs(teamWeeks - rtp.max_weeks) : null;

  const posts: string[] = [
    // Post 1: hook
    truncateWithEllipsis(
      `OTM 🚩 ${content.athlete_name} — ${content.team}'s timeline doesn't add up.\nThey're saying ${teamDisclosure}. The biology says something different. 🧵`,
      charLimit
    ),
    // Post 2: the gap
    truncateWithEllipsis(
      [
        `The injury: ${content.injury_type}`,
        `Standard recovery: ${rtp.min_weeks}–${rtp.max_weeks} weeks`,
        `Team disclosed: ${teamDisclosure}`,
        delta != null ? `The gap: ${delta}+ weeks` : 'Gap: exceeds 2-week conflict threshold',
      ].join('\n'),
      charLimit
    ),
    // Post 3: clinical basis
    truncateWithEllipsis(
      `Here's why this matters:\n${content.conflict_reason ?? content.clinical_summary}`,
      charLimit
    ),
    // Post 4: RTP + evidence
    truncateWithEllipsis(
      `OTM read: ${rtp.min_weeks}–${rtp.max_weeks} weeks\nWk 2: ${Math.round(rtp.probability_week_2 * 100)}% | Wk 4: ${Math.round(rtp.probability_week_4 * 100)}% | Wk 8: ${Math.round(rtp.probability_week_8 * 100)}%`,
      charLimit
    ),
    // Post 5: watch + signature
    truncateWithEllipsis(
      `Watch for: the signal that resolves this — imaging update, practice shift, or a quiet timeline revision that validates OTM's flag.\n\n${OTM_SIGNATURE}`,
      charLimit
    ),
  ];
  return posts;
}

export function formatForFarcaster(content: InjuryPostContent): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return buildBreakingThread(content, FARCASTER_CHAR_LIMIT);
    case 'TRACKING':
      return buildTrackingThread(content, FARCASTER_CHAR_LIMIT);
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, FARCASTER_CHAR_LIMIT);
    case 'CONFLICT_FLAG':
      return [buildConflictFarcasterCast(content, FARCASTER_CHAR_LIMIT)];
  }
}

export function formatForTwitter(content: InjuryPostContent): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return buildBreakingThread(content, TWITTER_CHAR_LIMIT);
    case 'TRACKING':
      return buildTrackingThread(content, TWITTER_CHAR_LIMIT);
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, TWITTER_CHAR_LIMIT);
    case 'CONFLICT_FLAG':
      return buildConflictTwitterThread(content, TWITTER_CHAR_LIMIT);
  }
}

export function formatForWeb(
  content: InjuryPostContent,
  status: 'PUBLISHED' | 'PENDING_REVIEW' = 'PUBLISHED'
): Record<string, unknown> {
  return {
    athlete_name: content.athlete_name,
    sport: content.sport,
    team: content.team,
    injury_type: content.injury_type,
    injury_severity: content.injury_severity,
    content_type: content.content_type,
    headline: content.headline,
    clinical_summary: content.clinical_summary,
    return_to_play_estimate: { ...content.return_to_play },
    ...(content.source_url !== undefined && { source_url: content.source_url }),
    ...(content.conflict_reason !== undefined && { conflict_reason: content.conflict_reason }),
    ...(content.team_timeline_weeks !== undefined && { team_timeline_weeks: content.team_timeline_weeks }),
    ...(content.parent_post_id !== undefined && { parent_post_id: content.parent_post_id }),
    confidence: content.confidence,
    status,
  };
}
