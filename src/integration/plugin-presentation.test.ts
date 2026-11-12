/** Ephemeral presentation is never audit, workflow, model or approval evidence. */
import { describe, expect, it, vi } from 'vitest';
import {
  createPresentationStore,
  recordPresentation,
  recordValidationProgress,
} from './plugin-presentation.js';

describe('ephemeral host presentation', () => {
  it('publishes only baseline progress, never implementation validation or other phases', () => {
    const store = createPresentationStore();
    for (const phase of ['READY', 'IMPLEMENTATION', 'IMPL_VALIDATION'] as const)
      recordValidationProgress(store, 'root', { phase, checks: ['build'], stage: 'starting' });
    expect(store.read('root').events).toEqual([]);
    recordValidationProgress(store, 'root', {
      phase: 'VALIDATION',
      checks: ['build'],
      stage: 'starting',
    });
    expect(store.read('root').events).toMatchObject([{ kind: 'validation', phase: 'VALIDATION' }]);
  });
  it('keeps events scoped to their exact session and supports cursor reads', () => {
    const store = createPresentationStore();
    store.record('root', { kind: 'validation', message: 'running build', checks: ['build'] });
    store.record('root', { kind: 'validation', message: 'preparing test' });
    store.record('other', { kind: 'validation', message: 'other session' });

    const first = store.read('root');
    expect(first.events).toHaveLength(2);
    expect(first.events.map((event) => event.kind)).toEqual(['validation', 'validation']);
    expect(first.cursor).toBe(first.events[1]!.id);

    const afterFirst = store.read('root', first.events[0]!.id);
    expect(afterFirst.events).toHaveLength(1);
    expect(afterFirst.events[0]!.message).toBe('preparing test');
    expect(store.read('other').events).toHaveLength(1);
    expect(store.read('missing')).toEqual({ events: [], cursor: null });
  });

  it('returns all current events for an unknown cursor so the UI can deduplicate', () => {
    const store = createPresentationStore();
    store.record('root', { kind: 'validation', message: 'one' });
    store.record('root', { kind: 'validation', message: 'two' });
    expect(store.read('root', 'unknown').events.map((event) => event.message)).toEqual([
      'one',
      'two',
    ]);
  });

  it('bounds events per session and keeps the newest cursor', () => {
    const store = createPresentationStore({ maxEventsPerSession: 2 });
    store.record('root', { kind: 'validation', message: 'one' });
    store.record('root', { kind: 'validation', message: 'two' });
    store.record('root', { kind: 'validation', message: 'three' });
    const page = store.read('root');
    expect(page.events.map((event) => event.message)).toEqual(['two', 'three']);
    expect(page.cursor).toBe(page.events[1]!.id);
  });

  it('bounds the session count and drops the oldest session', () => {
    const store = createPresentationStore({ maxSessions: 2 });
    store.record('one', { kind: 'validation', message: 'one' });
    store.record('two', { kind: 'validation', message: 'two' });
    store.record('one', { kind: 'validation', message: 'one-new' });
    store.record('three', { kind: 'validation', message: 'three' });
    expect(store.read('two').events).toEqual([]);
    expect(store.read('one').events).toHaveLength(2);
    expect(store.read('three').events).toHaveLength(1);
  });

  it('clears only the requested session', () => {
    const store = createPresentationStore();
    store.record('root', { kind: 'validation', message: 'root' });
    store.record('child', { kind: 'validation', message: 'child' });
    store.clear('root');
    expect(store.read('root').events).toEqual([]);
    expect(store.read('child').events).toHaveLength(1);
  });

  it('bounds messages, checks and omitted optional fields', () => {
    const store = createPresentationStore({ maxMessageLength: 32 });
    store.record('root', {
      kind: 'validation',
      message: '0123456789'.repeat(4),
      phase: 'VALIDATION',
      checks: Array.from({ length: 40 }, (_, index) => `check-${index}`),
    });
    const event = store.read('root').events[0]!;
    expect(event.message).toHaveLength(32);
    expect(event.message).toMatch(/^0123456789/);
    expect(event.message).toMatch(/\n\n\[truncated\]$/);
    expect(event.phase).toBe('VALIDATION');
    expect(event.checks).toHaveLength(32);
    expect(event).not.toHaveProperty('unknown');
  });

  it('distinguishes exact-capacity text from truncation at and below the suffix boundary', () => {
    const exact = createPresentationStore({ maxMessageLength: 32 });
    exact.record('root', { kind: 'validation', message: '12345678901234567890123456789012' });
    expect(exact.read('root').events[0]!.message).toBe('12345678901234567890123456789012');

    const suffixBoundary = createPresentationStore({ maxMessageLength: 13 });
    suffixBoundary.record('root', { kind: 'validation', message: '01234567890123456789' });
    expect(suffixBoundary.read('root').events[0]!.message).toBe('0123456789012');
  });

  it('diagnoses a failed record without promoting it to governance failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = {
        record: () => {
          throw new Error('presentation down');
        },
      };
      expect(() =>
        recordPresentation(store, 'root', { kind: 'validation', message: 'status' }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Presentation delivery failed'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('treats an absent store as a lost presentation, not a failure', () => {
    expect(() =>
      recordPresentation(undefined, 'root', { kind: 'validation', message: 'status' }),
    ).not.toThrow();
  });

  it('keeps an exact-boundary message unchanged and handles a max below the suffix', () => {
    const exact = createPresentationStore({ maxMessageLength: 12 });
    exact.record('root', { kind: 'validation', message: '123456789012' });
    expect(exact.read('root').events[0]!.message).toBe('123456789012');

    const short = createPresentationStore({ maxMessageLength: 8 });
    short.record('root', { kind: 'validation', message: '0123456789' });
    expect(short.read('root').events[0]!.message).toBe('01234567');
  });

  it('ignores an empty session identity instead of creating an anonymous page', () => {
    const store = createPresentationStore();
    store.record('', { kind: 'validation', message: 'must not exist' });
    expect(store.read('')).toEqual({ events: [], cursor: null });
  });

  it('returns no events after the last cursor and paginates a middle cursor', () => {
    const store = createPresentationStore();
    store.record('root', { kind: 'validation', message: 'one' });
    store.record('root', { kind: 'validation', message: 'two' });
    store.record('root', { kind: 'validation', message: 'three' });
    const all = store.read('root').events;
    expect(store.read('root', all[1]!.id).events.map((event) => event.message)).toEqual(['three']);
    expect(store.read('root', all[2]!.id)).toEqual({ events: [], cursor: all[2]!.id });
  });

  it('touches a read session before evicting the least-recently-used session', () => {
    const store = createPresentationStore({ maxSessions: 2 });
    store.record('one', { kind: 'validation', message: 'one' });
    store.record('two', { kind: 'validation', message: 'two' });
    store.read('one');
    store.record('three', { kind: 'validation', message: 'three' });
    expect(store.read('two').events).toEqual([]);
    expect(store.read('one').events).toHaveLength(1);
  });

  it('clears an already-absent session without disturbing the live LRU order', () => {
    const store = createPresentationStore({ maxSessions: 2 });
    store.record('one', { kind: 'validation', message: 'one' });
    store.record('two', { kind: 'validation', message: 'two' });
    store.clear('missing');
    store.record('three', { kind: 'validation', message: 'three' });
    expect(store.read('one').events).toEqual([]);
    expect(store.read('two').events).toHaveLength(1);
    expect(store.read('three').events).toHaveLength(1);
  });
});
