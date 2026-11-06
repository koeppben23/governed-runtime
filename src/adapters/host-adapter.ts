/**
 * @module adapters/host-adapter
 * @description Minimal Host-Agnostic Adapter Interface (HAI) between the
 * host-neutral governance engine and a concrete host integration.
 *
 * The HAI contains only ports the product actually invokes. Host SDK mechanics,
 * native-tool names, provider wiring and transport provenance stay in the host
 * adapter and the review evidence authorities. Static capability tables are not
 * an assurance source.
 *
 * Layer: adapters (may be imported by integration, not the reverse)
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v5
 */

export interface HostSession {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly directory: string;
  readonly agent?: string;
}

export interface HostAdapter {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  /** Exact host session metadata; implementations reject a different session ID. */
  getSession(sessionId: string): Promise<HostSession>;

  /** Native session history bytes. Callers validate every identity they use. */
  readHistory(sessionId: string): Promise<unknown>;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}
