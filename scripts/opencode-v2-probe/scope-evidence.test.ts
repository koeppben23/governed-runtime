import { describe, expect, it } from 'vitest';
import {
  normalAnswer,
  correlatedNativeChild,
  nativeChildReference,
  observationDigest,
  sessionBinding,
  stableSnapshots,
  startScopeTrace,
  unchangedBinding,
  waitForObservation,
} from './lib/scope-evidence.mjs';

const session = { id: 'root', projectID: 'project', location: { directory: '/fixture/project' } };
describe('P0-02-H observation assessment (not product evidence)', () => {
  it('requires complete exact session/project/location identity', () => {
    expect(sessionBinding(session)).toEqual({
      id: 'root',
      parentID: null,
      projectID: 'project',
      directory: '/fixture/project',
    });
    expect(() => sessionBinding({ id: 'root' })).toThrow('Missing session');
    expect(() => sessionBinding({ ...session, parentID: 42 })).toThrow('Invalid parent');
  });
  it.each([
    { id: 'other' },
    { parentID: 'other' },
    { projectID: 'foreign' },
    { location: { directory: '/fixture/other-worktree' } },
  ])('does not collapse a changed identity component %j', (change) => {
    expect(unchangedBinding(session, { ...session, ...change })).toBe(false);
  });
  it('compares context and instruction observations, not just persistent session IDs', () => {
    const before = [
      { session, contextSha256: observationDigest([]), instructionsSha256: observationDigest([]) },
    ];
    expect(stableSnapshots(before, structuredClone(before))).toBe(true);
    expect(stableSnapshots([], [])).toBe(false);
    expect(stableSnapshots(before, [])).toBe(false);
    expect(stableSnapshots([{ session }], [{ session }])).toBe(false);
    expect(
      stableSnapshots(before, [
        { ...before[0], contextSha256: observationDigest(['new history']) },
      ]),
    ).toBe(false);
    expect(
      stableSnapshots(before, [
        { ...before[0], instructionsSha256: observationDigest(['foreign mandates']) },
      ]),
    ).toBe(false);
  });
  it('does not treat idle/admission/length or another answer as normal completion', () => {
    const context = [
      { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'OK' }] },
    ];
    expect(normalAnswer(context, 'OK')).toBe(true);
    expect(normalAnswer(context, 'OTHER')).toBe(false);
    expect(normalAnswer([{ type: 'idle' }], 'OK')).toBe(false);
    expect(normalAnswer([{ ...context[0], finish: 'length' }], 'OK')).toBe(false);
  });
  it('fails explicitly on observation timeout instead of inferring a negative capability', async () => {
    await expect(waitForObservation(() => false, 'missing event', 1)).rejects.toHaveProperty(
      'code',
      'PROBE_OBSERVATION_TIMEOUT',
    );
  });
  it('requires tool metadata, parent, child, location and exact event correlation together', () => {
    const child = { ...session, id: 'child', parentID: session.id };
    const context = [
      {
        id: 'assistant',
        type: 'assistant',
        content: [
          {
            type: 'tool',
            id: 'call',
            name: 'subagent',
            state: { status: 'completed', input: {}, metadata: { sessionID: child.id } },
          },
        ],
      },
    ];
    const created = {
      type: 'session.created',
      durable: { aggregateID: child.id, version: 1, seq: 1 },
      data: { sessionID: child.id, parentID: session.id, location: child.location },
    };
    const completed = {
      type: 'session.tool.success',
      durable: { aggregateID: session.id, version: 2, seq: 10 },
      data: {
        sessionID: session.id,
        assistantMessageID: 'assistant',
        id: 'call',
        metadata: { sessionID: child.id },
      },
    };
    const events = [created, completed];
    expect(nativeChildReference(context)).toEqual({
      sessionID: child.id,
      toolCallID: 'call',
      assistantMessageID: 'assistant',
    });
    expect(() => nativeChildReference([])).toThrow('Missing/ambiguous');
    expect(() => nativeChildReference([...context, ...context])).toThrow('Missing/ambiguous');
    expect(correlatedNativeChild(session, child, context, events)).toBe(true);
    expect(correlatedNativeChild(session, child, [], events)).toBe(false);
    expect(correlatedNativeChild(session, child, context, [created])).toBe(false);
    expect(correlatedNativeChild(session, child, context, [...events, created])).toBe(false);
    expect(
      correlatedNativeChild(session, child, context, [
        created,
        { ...completed, data: { ...completed.data, assistantMessageID: 'stale-assistant' } },
      ]),
    ).toBe(false);
    expect(correlatedNativeChild(session, { ...child, parentID: 'foreign' }, context, events)).toBe(
      false,
    );
    expect(
      correlatedNativeChild(
        session,
        { ...child, location: { directory: '/other' } },
        context,
        events,
      ),
    ).toBe(false);
    const reused = structuredClone(context);
    Object.assign(reused[0]!.content[0]!.state.input, { sessionID: child.id });
    expect(correlatedNativeChild(session, child, reused, events)).toBe(false);
  });
  it('requires an actual live connection marker and preserves stream failure', async () => {
    const failedClient = {
      event: {
        async *subscribe() {
          throw new TypeError('stream failed');
        },
      },
    };
    await expect(startScopeTrace(failedClient)).rejects.toHaveProperty(
      'code',
      'PROBE_EVENT_STREAM_FAILED',
    );
    const emptyClient = { event: { async *subscribe() {} } };
    await expect(startScopeTrace(emptyClient)).rejects.toHaveProperty(
      'code',
      'PROBE_EVENT_STREAM_FAILED',
    );
  });
  it('retains a stream failure after readiness instead of reporting continuous delivery', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      event: {
        async *subscribe() {
          yield { type: 'server.connected' };
          await barrier;
          throw new TypeError('connection lost after ready');
        },
      },
    };
    const trace = await startScopeTrace(client);
    release?.();
    await waitForObservation(() => trace.failure, 'trace failure surfaced');
    expect(trace.failure).toContain('connection lost after ready');
    await trace.stop();
    expect(trace.ended).toBe(true);
  });
});
