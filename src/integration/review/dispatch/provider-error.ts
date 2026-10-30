/** Classify ONLY SDK/host error channels. Reviewer output must never enter this function. */
import type { StructuredFollowupFailureCode } from './native-task-review-types.js';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  const value = object(error);
  const data = object(value.data);
  const messages = [value.message, data.message];
  const body = data.responseBody ?? value.responseBody;
  if (typeof body === 'string') {
    try {
      messages.push(object(object(JSON.parse(body)).error).message);
    } catch {
      // Opaque response bodies are never echoed as diagnostics or model evidence.
    }
  }
  return messages.filter((part): part is string => typeof part === 'string').join(' ');
}

export function classifyReviewerProviderError(error: unknown): {
  readonly kind: 'blocked';
  readonly code: StructuredFollowupFailureCode;
  readonly reason: string;
} | null {
  const raw = errorMessage(error);
  const text = raw.toLowerCase();
  const diagnostic = raw
    .replace(/Bearer\s+\S+|(?:sk-|key-)[\w-]+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|token)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 240);
  if (/expected outputformat(?:jsonschema|text)/i.test(text)) {
    return {
      kind: 'blocked',
      code: 'REVIEWER_HOST_MESSAGE_ENCODING_FAILED',
      reason:
        'OpenCode cannot encode a persisted formatted message. Use an official corrected host; FlowGuard does not rewrite session history.',
    };
  }
  if (
    /reasoning[_. -]?(?:effort|mode)|thinking mode/.test(text) &&
    /unsupported|not support|invalid|not allowed|only support/.test(text)
  ) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
      reason: `The host/provider rejected the selected reviewer execution mode: ${diagnostic}`,
    };
  }
  if (
    /does not support|not supported|unsupported/.test(text) &&
    /tool_choice|tools|function calling|structured output/.test(text)
  ) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reason: `The host/provider rejected an agent capability: ${diagnostic}`,
    };
  }
  return null;
}
