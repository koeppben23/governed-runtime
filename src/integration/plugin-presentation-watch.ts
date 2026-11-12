/**
 * @module integration/plugin-presentation-watch
 * @description Read-only polling bridge from the server presentation store to a
 * host UI. The watcher is a convenience channel only: it never writes state,
 * awaits no governance operation and treats every failure as a lost notice.
 */
import type { PresentationEvent, PresentationPage } from './plugin-presentation.js';

export interface PresentationWatchDeps {
  readonly getPresentation: (sessionID: string, after: string | null) => Promise<PresentationPage>;
  readonly currentSessionID: () => string | null;
  readonly notify: (event: PresentationEvent) => void;
  readonly isAlive: () => boolean;
  readonly intervalMs?: number;
}

export interface PresentationWatcher {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 1_000;
const MAX_SEEN_IDS = 512;
const KEEP_SEEN_IDS = 256;

/**
 * Poll the current session's presentation page.
 *
 * The first successful read of a session is a baseline: only its newest event
 * is announced, so opening a window does not replay the whole history. Later
 * reads announce every new event once. A session switch starts a new baseline.
 */
export function createPresentationWatcher(deps: PresentationWatchDeps): PresentationWatcher {
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentSessionID: string | null = null;
  let cursor: string | null = null;
  let baseline = true;
  let reading = false;
  let disposed = false;
  const seen = new Set<string>();

  const reset = (): void => {
    currentSessionID = null;
    cursor = null;
    baseline = true;
    seen.clear();
  };

  const isActive = (): boolean => !disposed && deps.isAlive();
  const canStart = (): boolean => isActive() && !reading;

  const beginSession = (sessionID: string): void => {
    currentSessionID = sessionID;
    cursor = null;
    baseline = true;
    seen.clear();
  };

  const applyPage = (page: PresentationPage): void => {
    const events = page.events;
    for (const [index, event] of events.entries()) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (!baseline || index === events.length - 1) deps.notify(event);
    }
    cursor = page.cursor ?? cursor;
    baseline = false;
    if (seen.size <= MAX_SEEN_IDS) return;
    const keep = [...seen].slice(-KEEP_SEEN_IDS);
    seen.clear();
    for (const id of keep) seen.add(id);
  };

  const poll = async (): Promise<void> => {
    if (!canStart()) return;
    let sessionID: string | null;
    try {
      sessionID = deps.currentSessionID();
    } catch {
      return;
    }
    if (sessionID === null) {
      if (currentSessionID !== null) reset();
      return;
    }
    if (sessionID !== currentSessionID) beginSession(sessionID);
    reading = true;
    try {
      const page = await deps.getPresentation(sessionID, cursor);
      // A session switch while the read was in flight invalidates the page.
      if (!isActive() || currentSessionID !== sessionID) return;
      applyPage(page);
    } catch {
      // A presentation read is not an authority check. The canonical read-only
      // status remains available, so a transport failure is deliberately quiet.
    } finally {
      reading = false;
    }
  };

  return {
    start() {
      if (timer !== undefined || disposed) return;
      timer = setInterval(
        () => void poll().catch(() => {}),
        deps.intervalMs ?? DEFAULT_INTERVAL_MS,
      );
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      disposed = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      reset();
    },
    poll,
  };
}
