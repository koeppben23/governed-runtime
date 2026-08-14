import { createHash } from 'node:crypto';
import { CANONICAL_PROMPT_APPEND_MARKER } from './types.js';

export function canonicalPromptAnchorOf(parsed: Record<string, unknown>): string | null {
  const prompt = parsed.reviewerTaskPrompt;
  if (typeof prompt !== 'string') return null;
  const lines = prompt.split('\n');
  return lines.reverse().find((line) => line.startsWith(CANONICAL_PROMPT_APPEND_MARKER)) ?? null;
}

export function canonicalPromptOf(parsed: Record<string, unknown>): string | null {
  const prompt = parsed.reviewerTaskPrompt;
  return typeof prompt === 'string' ? prompt : null;
}

export function canonicalPromptDigestOf(parsed: Record<string, unknown>): string | null {
  const prompt = canonicalPromptOf(parsed);
  return prompt !== null ? createHash('sha256').update(prompt, 'utf8').digest('hex') : null;
}
