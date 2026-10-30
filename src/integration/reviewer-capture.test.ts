import { describe, expect, it } from 'vitest';
import { ReviewerCaptureController, ReviewerCaptureError } from './reviewer-capture.js';
import {
  CAPTURE_MODEL,
  CAPTURE_ATTEMPT,
  CAPTURE_OBLIGATION,
  observedPrompt,
  reviewerInputFixture,
} from './reviewer-capture-test-helpers.js';

function fixture() {
  const controller = new ReviewerCaptureController();
  controller.begin('child', CAPTURE_MODEL, {
    attemptId: CAPTURE_ATTEMPT,
    obligationId: CAPTURE_OBLIGATION,
  });
  const text = 'serialize';
  const messageID = controller.request('child', text);
  const opts = {
    path: { id: 'child' },
    body: {
      messageID,
      model: CAPTURE_MODEL,
      variant: CAPTURE_MODEL.variant,
      agent: 'flowguard-reviewer',
      parts: [{ type: 'text', text }],
    },
  };
  const payload = JSON.stringify(reviewerInputFixture());
  return { controller, opts, payload };
}

describe('synchronous reviewer capture fence', () => {
  it('binds exact request, child, model and raw payload', () => {
    const { controller, opts, payload } = fixture();
    const result = observedPrompt(controller, opts, payload);
    expect(controller.verify('child', result.data, payload)).toMatchObject({
      requestMessageId: opts.body.messageID,
      childSessionId: 'child',
      model: CAPTURE_MODEL,
      obligationId: CAPTURE_OBLIGATION,
      attemptId: CAPTURE_ATTEMPT,
    });
  });
  it.each(['parentID', 'sessionID', 'modelID', 'providerID', 'variant', 'finish', 'agent'])(
    'rejects wrong response %s',
    (field) => {
      const { controller, opts, payload } = fixture();
      const result = observedPrompt(controller, opts, payload);
      const info = { ...result.data.info, [field]: 'wrong' };
      expect(() => controller.verify('child', { ...result.data, info }, payload)).toThrow(
        ReviewerCaptureError,
      );
    },
  );
  it.each(['read', 'flowguard_observe_repository', 'mcp_read', 'task', 'custom'])(
    'blocks %s before execution and never clears the violation for valid JSON',
    (tool) => {
      const { controller, opts, payload } = fixture();
      const result = observedPrompt(controller, opts, payload);
      expect(() => controller.beforeTool({ sessionID: 'child', tool })).toThrow();
      expect(() => controller.verify('child', result.data, payload)).toThrow();
      expect(controller.isSafe('child')).toBe(false);
    },
  );
  it('rejects a provider-executed tool in the final response', () => {
    const { controller, opts, payload } = fixture();
    const result = observedPrompt(controller, opts, payload);
    expect(() =>
      controller.verify(
        'child',
        {
          ...result.data,
          parts: [{ type: 'tool', metadata: { providerExecuted: true } }, ...result.data.parts],
        },
        payload,
      ),
    ).toThrow();
  });
  it('rejects a second model step and foreign messages', () => {
    const { controller, opts, payload } = fixture();
    observedPrompt(controller, opts, payload);
    expect(() =>
      controller.onMessages({
        messages: [{ info: { sessionID: 'child', id: opts.body.messageID } }],
      }),
    ).toThrow();
  });
  it('fails closed on missing or mixed transform identity', () => {
    const { controller } = fixture();
    expect(() => controller.onMessages({ messages: [] })).toThrow();
    expect(controller.isSafe('child')).toBe(false);
  });
  it('does not mistake unrelated host work for this child', () => {
    const { controller } = fixture();
    controller.onMessages({ messages: [{ info: { sessionID: 'another-child' } }] });
    controller.beforeTool({ sessionID: 'another-child', tool: 'read' });
    expect(controller.isSafe('child')).toBe(true);
  });
  it('releases only the owner lease and never a concurrent operation', () => {
    const controller = new ReviewerCaptureController();
    const lease = controller.begin('child', CAPTURE_MODEL, {
      attemptId: CAPTURE_ATTEMPT,
      obligationId: CAPTURE_OBLIGATION,
    });
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).toThrow();
    controller.release('child', 'foreign-lease');
    expect(controller.isSafe('child')).toBe(true);
    controller.release('child', lease);
    expect(controller.isSafe('child')).toBe(false);
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).not.toThrow();
  });
  it('retains an unknown-outcome fence after cleanup', () => {
    const { controller } = fixture();
    controller.quarantine('child');
    controller.release('child');
    expect(() =>
      controller.begin('child', CAPTURE_MODEL, {
        attemptId: CAPTURE_ATTEMPT,
        obligationId: CAPTURE_OBLIGATION,
      }),
    ).toThrow();
    expect(() => controller.beforeTool({ sessionID: 'child', tool: 'read' })).toThrow();
  });
});
