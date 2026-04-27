import type { InjuryPostContent } from '../types.js';

const FARCASTER_CHAR_LIMIT = 320;
const TWITTER_CHAR_LIMIT = Number(process.env.TWITTER_CHAR_LIMIT) || 280;
// Premium account (25K chars) enables long-form single posts instead of threads.
// Free/Basic accounts (≤500 chars) use the original thread builders.
const TWITTER_LONG_FORM = TWITTER_CHAR_LIMIT > 500;

// Twitter replaces every URL with a 23-char t.co link regardless of actual length.
// See https://developer.x.com/en/docs/counting-characters
const TWITTER_TCO_LENGTH = 23;
const URL_REGEX = /https?:\/\/\S+/g;

const ORTHOIQ_REFERRAL_URL = process.env.ORTHOIQ_REFERRAL_URL || 'https://orthoiq.com?ref=sidelineiq';
const ORTHOIQ_CTA = `\n\nDealing with a similar injury? Get a personalized consultation at OrthoIQ. ${ORTHOIQ_REFERRAL_URL}`;
const OTM_SIGNATURE = '— OrthoTriage Master | AI-generated analysis. Physician-founded.';

function truncateWithEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3).trimEnd() + '...';
}

/**
 * Effective post length on X/Twitter, counting each URL as 23 chars (t.co shortening).
 * Use this for casts that include URLs to avoid pre-truncating text that Twitter will
 * render within the 280-char limit after shortening.
 */
function twitterEffectiveLength(text: string): number {
  const urls = text.match(URL_REGEX) ?? [];
  const rawUrlChars = urls.reduce((sum, u) => sum + u.length, 0);
  return text.length - rawUrlChars + urls.length * TWITTER_TCO_LENGTH;
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
/**
 * Strips internal OTM framework taxonomy labels from text.
 * These labels should never appear in public-facing content but can leak
 * from the agent's clinical_summary if the model ignores prompt guardrails.
 * Applied as a safety net on both social and web content.
 */
function stripFrameworkLabels(text: string): string {
  return text
    // "Axis N — ..." header lines (e.g. "Axis 1 — Tissue: NRV")
    .replace(/^Axis\s+\d+\s*[—\-][^\n]*$/gim, '')
    // "per SKILL.md ..." inline phrases
    .replace(/\bper\s+SKILL\.md[^.!\n]*/gi, '')
    // "per OTM protocol ..." inline phrases
    .replace(/\bper\s+OTM\s+protocol[^.!\n]*/gi, '')
    // "MD review flagged ..." standalone lines
    .replace(/^MD\s+review\s+flagged[^\n]*\.?\s*$/gim, '')
    // "Evidence Tier: T1 ..." standalone lines
    .replace(/^Evidence\s+Tier:\s+T[1-4][^\n]*\.?\s*$/gim, '')
    // "Flag: ESCALATION ..." standalone lines
    .replace(/^Flag:\s+ESCALATION[^\n]*\.?\s*$/gim, '')
    // "ESCALATION — ..." standalone lines
    .replace(/^ESCALATION\s*—[^\n]*\.?\s*$/gim, '')
    // Collapse any blank lines left behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripMarkdown(text: string): string {
  return stripFrameworkLabels(text)
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
 * Strips internal OTM framework labels from clinical_summary before web storage.
 * Unlike stripMarkdown(), this preserves markdown formatting — the web uses full
 * markdown rendering. It only removes content that should never be public-facing.
 */
function sanitizeClinicalSummary(text: string): string {
  return stripFrameworkLabels(text);
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

  const rtpLine = `RTP: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;
  // Compute exact overhead so the anchor budget is never too large and the
  // assembled post2 never exceeds charLimit (which would clip OTM_SIGNATURE).
  const post2Overhead = 2 + rtpLine.length + 2 + OTM_SIGNATURE.length; // \n\n + rtp + \n\n + sig
  const anchorBudget = charLimit - post2Overhead;
  const anchor = shortClinicalAnchor(content.clinical_summary, anchorBudget);

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

  const rtpLine = `RTP window: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;
  const post2Overhead = 2 + rtpLine.length + 2 + OTM_SIGNATURE.length; // \n\n + rtp + \n\n + sig
  const anchorBudget = charLimit - post2Overhead;
  const anchor = shortClinicalAnchor(content.clinical_summary, anchorBudget);

  const post2 = truncateWithEllipsis(
    [anchor, '', rtpLine, '', OTM_SIGNATURE].join('\n'),
    charLimit
  );

  return [post1, post2];
}

function buildDeepDiveThread(
  content: InjuryPostContent,
  charLimit: number,
  postUrl?: string,
  platform: 'farcaster' | 'twitter' = 'farcaster'
): string[] {
  const casts: string[] = [];

  // Cast 1: headline + injury overview
  casts.push(truncateWithEllipsis(
    `🔬 DEEP DIVE: ${content.headline}\n\n${content.athlete_name} (${content.team}) — ${content.injury_type} | Severity: ${content.injury_severity}`,
    charLimit
  ));

  // Cast 2-3: clinical detail (split if needed)
  const clinicalChunks = splitIntoChunks(stripMarkdown(content.clinical_summary), charLimit);
  for (const chunk of clinicalChunks.slice(0, 2)) {
    casts.push(chunk);
  }

  // Cast 4: RTP breakdown
  const rtp = content.return_to_play;
  casts.push(truncateWithEllipsis(
    `⏱️ Return to Play: ${rtp.min_weeks}-${rtp.max_weeks} weeks\nWk 2: ${Math.round(rtp.probability_week_2 * 100)}% | Wk 4: ${Math.round(rtp.probability_week_4 * 100)}% | Wk 8: ${Math.round(rtp.probability_week_8 * 100)}%`,
    charLimit
  ));

  // Final cast: web link (drives traffic) + OrthoIQ CTA + OTM signature.
  // On Twitter this cast contains up to two URLs; the t.co shortener makes the
  // rendered length ~45 chars shorter than raw. Using raw-length truncation
  // here would clip OTM_SIGNATURE even though the actual tweet fits 280 chars.
  const webLine = postUrl ? `Full clinical breakdown → ${postUrl}\n\n` : '';
  const finalText = `${webLine}${ORTHOIQ_CTA.trim()}\n\n${OTM_SIGNATURE}`;
  const effectiveLen = platform === 'twitter' ? twitterEffectiveLength(finalText) : finalText.length;
  casts.push(effectiveLen <= charLimit ? finalText : truncateWithEllipsis(finalText, charLimit));

  // Ensure 3-5 casts
  while (casts.length < 3) {
    casts.splice(casts.length - 1, 0, truncateWithEllipsis(stripMarkdown(content.clinical_summary), charLimit));
  }
  if (casts.length > 5) {
    // Keep first 4 + final cast
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

// ─── Long-form builders (Premium account, TWITTER_CHAR_LIMIT > 500) ───────────
// These produce single rich posts or 2-post threads rather than splitting
// content across 2-5 tweets to fit within the free-account 280-char limit.

/**
 * Long-form BREAKING or TRACKING — single post.
 * Full clinical summary, RTP, and OTM signature in one tweet.
 */
function buildLongFormBreakingOrTracking(content: InjuryPostContent): string[] {
  const rtp = content.return_to_play;
  const isTracking = content.content_type === 'TRACKING';
  const prefix = isTracking ? '📋 UPDATE: ' : '🚨 ';
  const rtpLine = isTracking
    ? `RTP window: ${rtp.min_weeks}–${rtp.max_weeks} weeks`
    : `RTP: ${rtp.min_weeks}–${rtp.max_weeks} weeks`;

  const post = [
    `${prefix}${content.headline}`,
    '',
    `${content.athlete_name} (${content.team}) — ${content.injury_type}`,
    `Severity: ${content.injury_severity}`,
    '',
    stripMarkdown(content.clinical_summary),
    '',
    rtpLine,
    '',
    OTM_SIGNATURE,
  ].join('\n');

  return [post];
}

/**
 * Long-form DEEP_DIVE — 1 or 2 posts.
 * Post 1: full clinical content + RTP + signature.
 * Post 2 (only when postUrl provided): web link + OrthoIQ CTA.
 * OrthoIQ CTA appears on final post only, per CLAUDE.md rule.
 */
function buildLongFormDeepDive(content: InjuryPostContent, postUrl?: string): string[] {
  const rtp = content.return_to_play;

  const post1 = [
    `🔬 DEEP DIVE: ${content.headline}`,
    '',
    `${content.athlete_name} (${content.team}) — ${content.injury_type} | Severity: ${content.injury_severity}`,
    '',
    stripMarkdown(content.clinical_summary),
    '',
    `⏱️ Return to Play: ${rtp.min_weeks}–${rtp.max_weeks} weeks`,
    `Wk 2: ${Math.round(rtp.probability_week_2 * 100)}% | Wk 4: ${Math.round(rtp.probability_week_4 * 100)}% | Wk 8: ${Math.round(rtp.probability_week_8 * 100)}%`,
    '',
    OTM_SIGNATURE,
  ].join('\n');

  if (!postUrl) return [post1];

  const post2 = [
    `Full clinical breakdown → ${postUrl}`,
    '',
    ORTHOIQ_CTA.trim(),
  ].join('\n');

  return [post1, post2];
}

/**
 * Long-form CONFLICT_FLAG — 2-post thread.
 * Post 1: hook + injury + full clinical context + team vs OTM gap.
 * Post 2: watch-for signal + OTM signature.
 */
function buildLongFormConflict(content: InjuryPostContent): string[] {
  const rtp = content.return_to_play;
  const teamWeeks = content.team_timeline_weeks;
  const teamDisclosure = teamWeeks != null ? `${teamWeeks} weeks` : 'day-to-day';
  const delta = teamWeeks != null ? Math.abs(teamWeeks - rtp.max_weeks) : null;

  const post1 = [
    `OTM 🚩 ${content.athlete_name} — ${content.team}'s timeline doesn't add up.`,
    '',
    `The injury: ${content.injury_type} | Severity: ${content.injury_severity}`,
    '',
    stripMarkdown(content.clinical_summary),
    '',
    'The gap:',
    `Team disclosed: ${teamDisclosure}`,
    `OTM read: ${rtp.min_weeks}–${rtp.max_weeks} weeks`,
    delta != null ? `Delta: ${delta}+ weeks — conflict threshold met` : 'Delta: exceeds 2-week conflict threshold',
    ...(content.conflict_reason ? ['', content.conflict_reason] : []),
  ].join('\n');

  const post2 = [
    'Watch for: the signal that resolves this — imaging update, practice shift, or a quiet timeline revision that validates OTM\'s flag.',
    '',
    OTM_SIGNATURE,
  ].join('\n');

  return [post1, post2];
}

/**
 * Launch announcement — single cast/tweet introducing SidelineIQ.
 * Fires alongside the launch deep dive approval when LAUNCH_ANNOUNCEMENT=true.
 * Fits within 280 effective Twitter chars (URL counts as 23 via t.co).
 */
export function buildLaunchAnnouncement(postUrl: string): string {
  return [
    '🏥 Introducing SidelineIQ — AI sports injury intelligence, physician-founded.',
    '',
    'We analyze injuries the way team docs do: three-axis classification, evidence-based RTP estimates, and no spin.',
    '',
    `Launching with our Moses Moody deep dive:\n${postUrl}`,
    '',
    '— OrthoTriage Master',
  ].join('\n');
}

export function formatForFarcaster(content: InjuryPostContent, postUrl?: string): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return buildBreakingThread(content, FARCASTER_CHAR_LIMIT);
    case 'TRACKING':
      return buildTrackingThread(content, FARCASTER_CHAR_LIMIT);
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, FARCASTER_CHAR_LIMIT, postUrl, 'farcaster');
    case 'CONFLICT_FLAG':
      return [buildConflictFarcasterCast(content, FARCASTER_CHAR_LIMIT)];
  }
}

export function formatForTwitter(content: InjuryPostContent, postUrl?: string): string[] {
  // Read env var at call time so tests (and Railway config changes) take effect
  // without a module reload.
  const charLimit = Number(process.env.TWITTER_CHAR_LIMIT) || 280;
  const longForm = charLimit > 500;

  switch (content.content_type) {
    case 'BREAKING':
      return longForm
        ? buildLongFormBreakingOrTracking(content)
        : buildBreakingThread(content, charLimit);
    case 'TRACKING':
      return longForm
        ? buildLongFormBreakingOrTracking(content)
        : buildTrackingThread(content, charLimit);
    case 'DEEP_DIVE':
      return longForm
        ? buildLongFormDeepDive(content, postUrl)
        : buildDeepDiveThread(content, charLimit, postUrl, 'twitter');
    case 'CONFLICT_FLAG':
      return longForm
        ? buildLongFormConflict(content)
        : buildConflictTwitterThread(content, charLimit);
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
    clinical_summary: sanitizeClinicalSummary(content.clinical_summary),
    return_to_play_estimate: { ...content.return_to_play },
    ...(content.source_url !== undefined && { source_url: content.source_url }),
    ...(content.conflict_reason !== undefined && { conflict_reason: content.conflict_reason }),
    ...(content.team_timeline_weeks !== undefined && { team_timeline_weeks: content.team_timeline_weeks }),
    ...(content.parent_post_id !== undefined && { parent_post_id: content.parent_post_id }),
    ...(content.injury_date !== undefined && { injury_date: content.injury_date }),
    confidence: content.confidence,
    status,
  };
}
