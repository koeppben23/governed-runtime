import { describe, expect, it } from 'vitest';
import { classifyReviewerProviderError } from './provider-error.js';

describe('trusted SDK/provider error classification', () => {
  it.each([
    new Error('Unsupported reasoning_effort: none'),
    { name: 'APIError', data: { message: 'Invalid reasoning mode' } },
    {
      responseBody: JSON.stringify({
        error: { message: 'Thinking mode does not support tool_choice' },
      }),
    },
    {
      data: {
        responseBody: JSON.stringify({ error: { message: 'reasoning.effort is not allowed' } }),
      },
    },
  ])('classifies explicit deterministic reasoning rejection as terminal: %j', (error) => {
    expect(classifyReviewerProviderError(error)?.code).toBe(
      'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
    );
  });
  it.each([
    'tools are not supported',
    'unsupported function calling',
    'tool_choice does not support this request',
  ])('classifies a required agent capability rejection: %s', (message) => {
    expect(classifyReviewerProviderError({ data: { message } })?.code).toBe(
      'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    );
  });
  it.each(['Expected OutputFormatJsonSchema, got object', 'Expected OutputFormatText, got object'])(
    'diagnoses host encoding independently of model capabilities: %s',
    (message) => {
      expect(classifyReviewerProviderError({ data: { message } })?.code).toBe(
        'REVIEWER_HOST_MESSAGE_ENCODING_FAILED',
      );
    },
  );
  it.each([
    null,
    undefined,
    'Unsupported reasoning_effort',
    {},
    { data: 'unknown' },
    { message: 'connection reset' },
    { message: 'tools are slow' },
    { message: 'reasoning_effort: high' },
    { responseBody: 'opaque unsupported tools' },
  ])('does not invent a deterministic classification for %j', (error) => {
    expect(classifyReviewerProviderError(error)).toBeNull();
  });
  it('bounds and redacts the error signal and never echoes opaque response bodies', () => {
    const result = classifyReviewerProviderError({
      message:
        'Unsupported reasoning_effort Bearer secret-value token=private-value sk-private-token\n' +
        'x'.repeat(500),
      responseBody: 'DO_NOT_ECHO_OPAQUE_BODY',
    });
    expect(result?.reason).toContain('[redacted]');
    expect(result?.reason).not.toMatch(
      /secret-value|private-value|sk-private-token|DO_NOT_ECHO|\n/,
    );
    expect(result?.reason.length).toBeLessThan(330);
  });
});
