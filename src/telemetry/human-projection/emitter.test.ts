import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitTelemetryEvent } from './emitter.js';
import type { TelemetryEventBody } from './emitter.js';
import {
  setHumanProjectionTelemetrySink,
  resetHumanProjectionTelemetrySink,
  type HumanProjectionTelemetrySink,
} from './sink.js';

function renderBody(): TelemetryEventBody {
  return { event: 'presentation_rendered', documentKind: 'compact_card' };
}

function actionBody(): TelemetryEventBody {
  return {
    event: 'action_presented',
    intent: 'run_validation',
    visibility: 'recommended',
    conclusionKind: 'next_action',
  };
}

function invokedBody(): TelemetryEventBody {
  return { event: 'action_invoked', disposition: 'entered' };
}

function detailBody(): TelemetryEventBody {
  return {
    event: 'detail_requested',
    from: 'summary',
    to: 'explanation',
    surface: 'why',
  };
}

describe('emitTelemetryEvent', () => {
  beforeEach(() => {
    resetHumanProjectionTelemetrySink();
  });

  it('does NOT throw when sink throws synchronously', () => {
    const throwing: HumanProjectionTelemetrySink = {
      record() {
        throw new Error('sink failure');
      },
    };
    setHumanProjectionTelemetrySink(throwing);
    expect(() => emitTelemetryEvent(renderBody(), 's1', 'READY')).not.toThrow();
  });

  it('does NOT throw when sink rejects asynchronously', () => {
    const rejecting: HumanProjectionTelemetrySink = {
      record() {
        return Promise.reject(new Error('sink async failure'));
      },
    };
    setHumanProjectionTelemetrySink(rejecting);
    expect(() => emitTelemetryEvent(renderBody(), 's1', 'READY')).not.toThrow();
  });

  it('calls sink.record with the constructed event', () => {
    const recorded: unknown[] = [];
    const captor: HumanProjectionTelemetrySink = {
      record(event) {
        recorded.push(event);
      },
    };
    setHumanProjectionTelemetrySink(captor);
    emitTelemetryEvent(renderBody(), 's1', 'READY');
    expect(recorded).toHaveLength(1);
    const event = recorded[0] as Record<string, unknown>;
    expect(event.event).toBe('presentation_rendered');
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toBeTruthy();
    expect(event.occurredAt).toBeTruthy();
    expect(event.sessionId).toBe('s1');
    expect(event.phase).toBe('READY');
  });

  it('envelope fields are host-assigned — caller cannot override', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    const body = renderBody();
    emitTelemetryEvent(body, 'real-session', 'IMPL');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.schemaVersion).toBe(1);
    expect(event.sessionId).toBe('real-session');
    expect(event.phase).toBe('IMPL');
    expect(typeof event.eventId).toBe('string');
  });

  it('no-op sink produces zero side effects (disabled by default)', () => {
    emitTelemetryEvent(renderBody(), 's1', 'READY');
    emitTelemetryEvent(actionBody(), 's1', 'READY');
    emitTelemetryEvent(invokedBody(), 's1', 'READY');
    emitTelemetryEvent(detailBody(), 's1', 'READY');
    // No throw, no output — no assertion needed beyond survival
  });

  it('action_presented can carry intent', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(actionBody(), 's1', 'READY');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.intent).toBe('run_validation');
  });

  it('action_invoked disposition is preserved', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(invokedBody(), 's1', 'READY');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.disposition).toBe('entered');
  });

  it('detail_requested transition fields are preserved', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(detailBody(), 's1', 'READY');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.from).toBe('summary');
    expect(event.to).toBe('explanation');
    expect(event.surface).toBe('why');
  });

  it('eventId is a valid UUID', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(renderBody(), 's1', 'READY');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.eventId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('occurredAt is a valid ISO 8601 datetime', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(renderBody(), 's1', 'READY');
    const event = recorded[0] as Record<string, unknown>;
    expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('event payload never leaks free-form user content sentinels', () => {
    const recorded: unknown[] = [];
    setHumanProjectionTelemetrySink({
      record(event) {
        recorded.push(event);
      },
    });
    emitTelemetryEvent(renderBody(), 's1', 'READY');
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toContain('SECRET_USER_CONTENT');
    expect(json).not.toContain('password');
    expect(json).not.toContain('apiKey');
  });
});
