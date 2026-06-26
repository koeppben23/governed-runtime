/**
 * @module logging/process-exit
 * @description Process-exit registrar seam for flushing diagnostic log sinks.
 *
 * OpenCode plugins have no dispose/teardown lifecycle hook (see
 * https://opencode.ai/docs/plugins — only session.* events exist). The only
 * reliable place to flush batched log records (e.g. the OTLP exporter) is a
 * process-level exit signal, mirroring the existing precedent in
 * `src/hooks/http-server.ts` (SIGTERM/SIGINT).
 *
 * `ProcessExitRegistrar` abstracts that registration so the flush wiring is
 * unit-testable without emitting real process signals.
 *
 * @version v1
 */

/**
 * Registers a one-shot exit callback. Returns a dispose function that removes
 * the listeners. The callback runs at most once even if multiple exit signals
 * fire.
 */
export interface ProcessExitRegistrar {
  register(cb: () => void | Promise<void>): () => void;
}

const EXIT_SIGNALS = ['SIGTERM', 'SIGINT', 'beforeExit'] as const;

/** Production registrar: binds SIGTERM, SIGINT, and beforeExit once. */
export const processExitRegistrar: ProcessExitRegistrar = {
  register(cb) {
    let ran = false;
    const handler = (): void => {
      if (ran) return;
      ran = true;
      try {
        // Fire-and-forget: exit handlers cannot reliably await, but kicking the
        // flush off here gives the OTLP processor a chance to export. Errors are
        // swallowed — a failed flush must never crash shutdown.
        void Promise.resolve(cb()).catch(() => {});
      } catch {
        // ignore — never throw out of an exit handler
      }
    };
    for (const sig of EXIT_SIGNALS) {
      process.once(sig, handler);
    }
    return () => {
      for (const sig of EXIT_SIGNALS) {
        process.off(sig, handler);
      }
    };
  },
};
