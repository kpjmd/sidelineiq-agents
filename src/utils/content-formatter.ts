import type { InjuryPostContent } from '../types.js';

const FARCASTER_CHAR_LIMIT = 320;
const TWITTER_CHAR_LIMIT = 280;

const ORTHOIQ_REFERRAL_URL = process.env.ORTHOIQ_REFERRAL_URL || 'https://orthoiq.com?ref=sidelineiq';
const ORTHOIQ_CTA = `\n\nDealing with a similar injury? Get a personalized consultation at OrthoIQ. ${ORTHOIQ_REFERRAL_URL}`;

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

function buildBreakingCast(content: InjuryPostContent, charLimit: number): string {
  const rtp = content.return_to_play;
  const rtpLine = `RTP: ${rtp.min_weeks}-${rtp.max_weeks} weeks (${Math.round(rtp.probability_week_4 * 100)}% by wk 4)`;
  const parts = [
    `🚨 ${content.headline}`,
    '',
    content.clinical_summary,
    '',
    rtpLine,
  ];
  return truncateWithEllipsis(parts.join('\n'), charLimit);
}

function buildTrackingCast(content: InjuryPostContent, charLimit: number): string {
  const rtp = content.return_to_play;
  const rtpLine = `RTP: ${rtp.min_weeks}-${rtp.max_weeks} weeks (${Math.round(rtp.probability_week_4 * 100)}% by wk 4)`;
  const parts = [
    `📋 UPDATE: ${content.headline}`,
    '',
    content.clinical_summary,
    '',
    rtpLine,
  ];
  return truncateWithEllipsis(parts.join('\n'), charLimit);
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

  // Final cast: OrthoIQ reference
  casts.push(truncateWithEllipsis(ORTHOIQ_CTA.trim(), charLimit));

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

function buildConflictCast(content: InjuryPostContent, charLimit: number): string {
  const reason = content.conflict_reason ?? 'Conflicting reports from multiple sources';
  const rtp = content.return_to_play;
  const parts = [
    `⚠️ CONFLICT: ${content.headline}`,
    '',
    reason,
    '',
    content.clinical_summary,
    '',
    `RTP range: ${rtp.min_weeks}-${rtp.max_weeks} weeks (conflicting — monitor for updates)`,
  ];
  return truncateWithEllipsis(parts.join('\n'), charLimit);
}

export function formatForFarcaster(content: InjuryPostContent): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return [buildBreakingCast(content, FARCASTER_CHAR_LIMIT)];
    case 'TRACKING':
      return [buildTrackingCast(content, FARCASTER_CHAR_LIMIT)];
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, FARCASTER_CHAR_LIMIT);
    case 'CONFLICT_FLAG':
      return [buildConflictCast(content, FARCASTER_CHAR_LIMIT)];
  }
}

export function formatForTwitter(content: InjuryPostContent): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return [buildBreakingCast(content, TWITTER_CHAR_LIMIT)];
    case 'TRACKING':
      return [buildTrackingCast(content, TWITTER_CHAR_LIMIT)];
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, TWITTER_CHAR_LIMIT);
    case 'CONFLICT_FLAG':
      return [buildConflictCast(content, TWITTER_CHAR_LIMIT)];
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
    confidence: content.confidence,
    status,
  };
}
