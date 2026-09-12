/**
 * @module integration/sdk-contract-events.test
 * @description Contract guard for the OpenCode event union consumed by plugin-events.ts.
 *
 * The event handler must track the pinned SDK contract:
 * - the event is `session.deleted`, not the API command name `session.delete`
 * - the terminated session id lives at `properties.info.id`
 * - `session.error.properties.error` is the SDK error object union
 *
 * Evidence source: `@opencode-ai/plugin` re-exports the SDK `Event` union
 * through `Hooks['event']`. If the pinned SDK renames an event or changes a
 * payload, the compile-time assertions below stop compiling.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import type { Hooks } from '@opencode-ai/plugin';

import { handleEvent, type EventHandlerDeps, type PluginEvent } from './plugin-events.js';

// ── Compile-time contract derivations ────────────────────────────────────────

type EventHook = NonNullable<Hooks['event']>;
type HostEvent = Parameters<EventHook>[0]['event'];
type SessionDeletedEvent = Extract<HostEvent, { type: 'session.deleted' }>;
type SessionErrorEvent = Extract<HostEvent, { type: 'session.error' }>;
type SessionErrorPayload = NonNullable<SessionErrorEvent['properties']['error']>;

/** Fails compilation when the SDK shape stops satisfying the expected contract. */
type AssertExtends<T extends U, U> = T;
type AssertKeyOf<T, K extends keyof T> = K;

type _deletedType = AssertExtends<SessionDeletedEvent['type'], 'session.deleted'>;
type _deletedInfo = AssertKeyOf<SessionDeletedEvent['properties'], 'info'>;
type _deletedInfoId = AssertKeyOf<SessionDeletedEvent['properties']['info'], 'id'>;
type _deletedInfoIdType = AssertExtends<SessionDeletedEvent['properties']['info']['id'], string>;
type _errorType = AssertExtends<SessionErrorEvent['type'], 'session.error'>;
type _errorSessionId = AssertExtends<
  SessionErrorEvent['properties']['sessionID'],
  string | undefined
>;
type _errorIsObjectUnion = AssertExtends<SessionErrorPayload, { name: string; data: unknown }>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockDeps(): EventHandlerDeps & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    log: {
      info(service, message, extra) {
        calls.push({ method: 'log.info', args: [service, message, extra] });
      },
      warn(service, message, extra) {
        calls.push({ method: 'log.warn', args: [service, message, extra] });
      },
      error(service, message, extra) {
        calls.push({ method: 'log.error', args: [service, message, extra] });
      },
    },
    cleanupSession(sessionId: string) {
      calls.push({ method: 'cleanupSession', args: [sessionId] });
    },
    async emitSessionErrorAudit(sessionId, errorMessage, detail) {
      calls.push({
        method: 'emitSessionErrorAudit',
        args: [sessionId, errorMessage, detail],
      });
    },
  };
}

/**
 * Build the canonical SDK event shape. The cast localizes the gap between the
 * full `Session` object the SDK carries and the `id` the handler consumes.
 */
function sdkDeletedEvent(id: string): PluginEvent {
  const event = {
    type: 'session.deleted',
    properties: { info: { id } },
  } as unknown as SessionDeletedEvent;
  return event;
}

function sdkSessionErrorEvent(error: SessionErrorPayload): PluginEvent {
  const event = {
    type: 'session.error',
    properties: { sessionID: 'sess-1', error },
  } as unknown as SessionErrorEvent;
  return event;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SDK Contract: event union consumed by plugin-events', () => {
  describe('HAPPY', () => {
    it('session.deleted canonical payload resolves info.id and cleans up', async () => {
      const deps = createMockDeps();

      await handleEvent(deps, sdkDeletedEvent('sess-contract'));

      expect(deps.calls.find((c) => c.method === 'cleanupSession')?.args[0]).toBe('sess-contract');
      expect(deps.calls.find((c) => c.method === 'log.info')?.args[2]).toEqual({
        sessionId: 'sess-contract',
      });
    });

    const errorCases: ReadonlyArray<readonly [string, SessionErrorPayload, string]> = [
      ['UnknownError', { name: 'UnknownError', data: { message: 'boom' } }, 'boom'],
      [
        'ProviderAuthError',
        { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'auth failed' } },
        'auth failed',
      ],
      [
        'APIError',
        { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: true } },
        'rate limited',
      ],
      [
        'MessageAbortedError',
        { name: 'MessageAbortedError', data: { message: 'aborted' } },
        'aborted',
      ],
    ];

    it.each(errorCases)(
      'session.error %s object error surfaces its message',
      async (_name, error, expected) => {
        const deps = createMockDeps();

        await handleEvent(deps, sdkSessionErrorEvent(error));

        const audit = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
        expect(audit?.args[1]).toBe(expected);
      },
    );
  });

  describe('BAD', () => {
    it('the API command name session.delete is not a host event and stays ignored', async () => {
      const deps = createMockDeps();

      await handleEvent(deps, { type: 'session.delete', properties: { info: { id: 's' } } });

      expect(deps.calls).toHaveLength(0);
    });
  });

  describe('CORNER', () => {
    it('session.error audit records the SDK error discriminant', async () => {
      const deps = createMockDeps();

      await handleEvent(
        deps,
        sdkSessionErrorEvent({
          name: 'APIError',
          data: { message: 'x', isRetryable: false },
        }),
      );

      const audit = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect((audit?.args[2] as Record<string, unknown>).errorName).toBe('APIError');
    });

    it('session.deleted with a Session-shaped info but no id does not clean up', async () => {
      const deps = createMockDeps();

      await handleEvent(deps, { type: 'session.deleted', properties: { info: {} } });

      expect(deps.calls).toHaveLength(0);
    });
  });

  describe('EDGE', () => {
    it('other SDK session events stay ignored', async () => {
      const deps = createMockDeps();

      await handleEvent(deps, { type: 'session.idle' });
      await handleEvent(deps, { type: 'session.created' });

      expect(deps.calls).toHaveLength(0);
    });
  });
});
