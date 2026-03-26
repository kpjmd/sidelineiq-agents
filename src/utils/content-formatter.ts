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
  const rtpLine = `RTP: ${content.return_to_play.timeline} (${Math.round(content.return_to_play.probability * 100)}%)`;
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
  const rtpLine = `RTP: ${content.return_to_play.timeline} (${Math.round(content.return_to_play.probability * 100)}%)`;
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
  const rtpFactors = content.return_to_play.factors.join(', ');
  casts.push(truncateWithEllipsis(
    `⏱️ Return to Play: ${content.return_to_play.timeline}\nProbability: ${Math.round(content.return_to_play.probability * 100)}%\nKey factors: ${rtpFactors}`,
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

export function formatForFarcaster(content: InjuryPostContent): string[] {
  switch (content.content_type) {
    case 'BREAKING':
      return [buildBreakingCast(content, FARCASTER_CHAR_LIMIT)];
    case 'TRACKING':
      return [buildTrackingCast(content, FARCASTER_CHAR_LIMIT)];
    case 'DEEP_DIVE':
      return buildDeepDiveThread(content, FARCASTER_CHAR_LIMIT);
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
    return_to_play_timeline: content.return_to_play.timeline,
    return_to_play_probability: content.return_to_play.probability,
    return_to_play_factors: content.return_to_play.factors,
    source_url: content.source_url ?? null,
    confidence: content.confidence,
    status,
  };
}
