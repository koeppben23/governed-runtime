import { describe, expect, it } from 'vitest';
import { classifyReviewerProviderError } from './provider-error.js';

describe('native host/provider error classification', () => {
  it.each([
    new Error('Unsupported reasoning_effort: none'),
    { type: 'provider', message: 'Invalid reasoning mode' },
    {
      type: 'provider',
      message: 'request failed',
      response: {
        body: JSON.stringify({ error: { message: 'Thinking mode does not support tool_choice' } }),
      },
    },
    {
      response: { body: JSON.stringify({ error: { message: 'reasoning.effort is not allowed' } }) },
    },
  ])('classifies deterministic native reasoning rejection as terminal: %j', (error) => {
    expect(classifyReviewerProviderError(error)?.code).toBe(
      'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
    );
  });

  it.each([
    'tools are not supported',
    'unsupported function calling',
    'tool_choice does not support this request',
  ])('classifies a required capability rejection: %s', (message) => {
    expect(classifyReviewerProviderError({ type: 'provider', message })?.code).toBe(
      'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    );
  });

  it.each(['Expected OutputFormatJsonSchema, got object', 'Expected OutputFormatText, got object'])(
    'diagnoses a host encoding failure without rewriting history: %s',
    (message) => {
      expect(classifyReviewerProviderError({ type: 'encoding', message })?.code).toBe(
        'REVIEWER_HOST_MESSAGE_ENCODING_FAILED',
      );
    },
  );

  it.each([
    null,
    undefined,
    'Unsupported reasoning_effort',
    {},
    { message: 'connection reset' },
    { message: 'tools are slow' },
    { message: 'reasoning_effort: high' },
    { response: { body: 'opaque unsupported tools' } },
    { name: 'APIError', data: { message: 'Unsupported reasoning_effort' } },
    { responseBody: JSON.stringify({ error: { message: 'Unsupported reasoning_effort' } }) },
  ])('does not classify ambiguity or accept removed SDK error envelopes: %j', (error) => {
    expect(classifyReviewerProviderError(error)).toBeNull();
  });

  it('bounds/redacts diagnostics and never echoes opaque provider bodies', () => {
    const result = classifyReviewerProviderError({
      type: 'provider',
      message:
        'Unsupported reasoning_effort Bearer secret-value token=private-value sk-private-token\n' +
        'x'.repeat(500),
      response: { body: 'DO_NOT_ECHO_OPAQUE_BODY' },
    });
    expect(result?.reason).toContain('[redacted]');
    expect(result?.reason).not.toMatch(
      /secret-value|private-value|sk-private-token|DO_NOT_ECHO|\n/,
    );
    expect(result?.reason.length).toBeLessThan(330);
  });
});
