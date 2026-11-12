/** The watcher is a convenience bridge; it never blocks or authorizes work. */
import { describe, expect, it, vi } from 'vitest';
import { createPresentationWatcher } from './plugin-presentation-watch.js';
import type { PresentationEvent, PresentationPage } from './plugin-presentation.js';

function event(id: string, sessionID = 'root'): PresentationEvent {
  return {
    id,
    sessionID,
    kind: 'notice',
    message: `message-${id}`,
    occurredAt: '2026-11-12T00:00:00.000Z',
  };
}

function fixture(pages: Array<PresentationPage | Error>, intervalMs = 1_000) {
  const notifications: string[] = [];
  let sessionID: string | null = 'root';
  let alive = true;
  const getPresentation = vi.fn(async () => {
    const next = pages.shift();
    if (next === undefined) return { events: [], cursor: null };
    if (next instanceof Error) throw next;
    return next;
  });
  const watcher = createPresentationWatcher({
    getPresentation,
    currentSessionID: () => sessionID,
    notify: (value) => notifications.push(value.message),
    isAlive: () => alive,
    intervalMs,
  });
  return {
    watcher,
    notifications,
    getPresentation,
    setSession: (value: string | null) => {
      sessionID = value;
    },
    setAlive: (value: boolean) => {
      alive = value;
    },
  };
}

describe('presentation watcher', () => {
  it('announces only the newest baseline event, then each new event once', async () => {
    const f = fixture([
      { events: [event('one'), event('two')], cursor: 'two' },
      { events: [event('two'), event('three')], cursor: 'three' },
    ]);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-two']);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-two', 'message-three']);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-two', 'message-three']);
  });

  it('starts a new baseline after a session switch', async () => {
    const f = fixture([
      { events: [event('root-old')], cursor: 'root-old' },
      { events: [event('child-old', 'child')], cursor: 'child-old' },
      {
        events: [event('child-old', 'child'), event('child-new', 'child')],
        cursor: 'child-new',
      },
    ]);
    await f.watcher.poll();
    f.setSession('child');
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-root-old', 'message-child-old']);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-root-old', 'message-child-old', 'message-child-new']);
  });

  it('ignores transport failures and continues on the next poll', async () => {
    const f = fixture([
      new Error('presentation unavailable'),
      { events: [event('recovered')], cursor: 'recovered' },
    ]);
    await expect(f.watcher.poll()).resolves.toBeUndefined();
    expect(f.notifications).toEqual([]);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-recovered']);
  });

  it('does not read without a current session or when disposed/unavailable', async () => {
    const f = fixture([{ events: [event('one')], cursor: 'one' }]);
    f.setSession(null);
    await f.watcher.poll();
    expect(f.getPresentation).not.toHaveBeenCalled();
    f.setSession('root');
    f.setAlive(false);
    await f.watcher.poll();
    expect(f.getPresentation).not.toHaveBeenCalled();
    f.setAlive(true);
    f.watcher.stop();
    await f.watcher.poll();
    expect(f.getPresentation).not.toHaveBeenCalled();
  });

  it('starts exactly one timer, polls on schedule and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(
        [
          { events: [event('one')], cursor: 'one' },
          { events: [event('one'), event('two')], cursor: 'two' },
        ],
        50,
      );
      f.watcher.start();
      f.watcher.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(f.notifications).toEqual(['message-one']);
      await vi.advanceTimersByTimeAsync(50);
      expect(f.notifications).toEqual(['message-one', 'message-two']);
      f.watcher.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(f.getPresentation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a second read while one is in flight', async () => {
    let resolve: (page: PresentationPage) => void = () => {};
    const getPresentation = vi.fn(
      () =>
        new Promise<PresentationPage>((next) => {
          resolve = next;
        }),
    );
    const notifications: string[] = [];
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => 'root',
      notify: (value) => notifications.push(value.message),
      isAlive: () => true,
    });
    const first = watcher.poll();
    const second = watcher.poll();
    expect(getPresentation).toHaveBeenCalledTimes(1);
    resolve({ events: [], cursor: null });
    await Promise.all([first, second]);
    expect(notifications).toEqual([]);
  });

  it('does not notify when liveness changes during a read', async () => {
    let resolve: (page: PresentationPage) => void = () => {};
    const getPresentation = vi.fn(
      () =>
        new Promise<PresentationPage>((next) => {
          resolve = next;
        }),
    );
    let alive = true;
    const notifications: string[] = [];
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => 'root',
      notify: (value) => notifications.push(value.message),
      isAlive: () => alive,
    });
    const poll = watcher.poll();
    alive = false;
    resolve({ events: [event('late')], cursor: 'late' });
    await poll;
    expect(notifications).toEqual([]);
  });

  it('discards a page when the selected session changes during the read', async () => {
    let resolve: (page: PresentationPage) => void = () => {};
    const getPresentation = vi.fn(
      () =>
        new Promise<PresentationPage>((next) => {
          resolve = next;
        }),
    );
    let sessionID = 'root';
    const notifications: string[] = [];
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => sessionID,
      notify: (value) => notifications.push(value.message),
      isAlive: () => true,
    });
    const poll = watcher.poll();
    sessionID = 'child';
    resolve({ events: [event('stale', 'root')], cursor: 'stale' });
    await poll;
    expect(getPresentation).toHaveBeenCalledWith('root', null);
    expect(notifications).toEqual([]);
  });

  it('resets after a missing session and baselines the next session read', async () => {
    const f = fixture([
      { events: [event('one')], cursor: 'one' },
      { events: [event('one')], cursor: 'one' },
    ]);
    await f.watcher.poll();
    f.setSession(null);
    await f.watcher.poll();
    expect(f.getPresentation).toHaveBeenCalledTimes(1);
    f.setSession('root');
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-one', 'message-one']);
  });

  it('passes a null cursor to a newly selected session', async () => {
    const calls: Array<string | null> = [];
    const getPresentation = vi.fn(async (_sessionID: string, after: string | null) => {
      calls.push(after);
      return {
        events: calls.length === 1 ? [event('root-old')] : [event('child-old', 'child')],
        cursor: calls.length === 1 ? 'root-old' : 'child-old',
      };
    });
    let sessionID = 'root';
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => sessionID,
      notify: vi.fn(),
      isAlive: () => true,
    });
    await watcher.poll();
    sessionID = 'child';
    await watcher.poll();
    expect(calls).toEqual([null, null]);
  });

  it('prunes the seen set so an old event can be announced after a long session', async () => {
    const many = Array.from({ length: 600 }, (_, index) => event(`e${index}`));
    const f = fixture([
      { events: many, cursor: 'e599' },
      { events: [many[0]!, many[300]!, event('new')], cursor: 'new' },
    ]);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-e599']);
    await f.watcher.poll();
    expect(f.notifications).toEqual(['message-e599', 'message-e0', 'message-e300', 'message-new']);
  });

  it('keeps the previous cursor when a page reports no cursor', async () => {
    const calls: Array<string | null> = [];
    const getPresentation = vi.fn(async (_sessionID: string, after: string | null) => {
      calls.push(after);
      if (calls.length === 1) return { events: [event('one')], cursor: 'one' };
      if (calls.length === 2) return { events: [], cursor: null };
      return { events: [], cursor: 'two' };
    });
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => 'root',
      notify: vi.fn(),
      isAlive: () => true,
    });
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    expect(calls).toEqual([null, 'one', 'one']);
  });

  it('does not notify after disposal while a read is in flight', async () => {
    let resolve: (page: PresentationPage) => void = () => {};
    const getPresentation = vi.fn(
      () =>
        new Promise<PresentationPage>((next) => {
          resolve = next;
        }),
    );
    const notifications: string[] = [];
    const watcher = createPresentationWatcher({
      getPresentation,
      currentSessionID: () => 'root',
      notify: (value) => notifications.push(value.message),
      isAlive: () => true,
    });
    const poll = watcher.poll();
    watcher.stop();
    resolve({ events: [event('late')], cursor: 'late' });
    await poll;
    expect(notifications).toEqual([]);
  });
});
