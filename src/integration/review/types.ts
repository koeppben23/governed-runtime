/**
 * @module integration/review/types
 * @description Shared type definitions for the review bounded context.
 *
 * This module breaks the circular type-only dependency between
 * orchestrator.ts and agent-resolution.ts by providing the shared
 * OrchestratorClient interface in a dedicated leaf module.
 *
 * @version v1
 */

/**
 * Minimal SDK client interface for the review orchestrator.
 *
 * Mirrors the subset of OpencodeClient used by review modules.
 * Defined as an interface (not imported from SDK) so these modules
 * have zero runtime SDK dependency — testable with plain mocks.
 */
export interface OrchestratorClient {
  app: {
    agents(): Promise<{ data?: Array<Record<string, unknown>> | undefined; error?: unknown }>;
  };
  session: {
    create(opts: {
      body?: { parentID?: string; title?: string };
    }): Promise<{ data?: { id: string } | undefined; error?: unknown }>;
    prompt(opts: {
      path: { id: string };
      body: {
        agent?: string;
        system?: string;
        parts: Array<{ type: string; text: string }>;
        format?: {
          type: 'json_schema';
          schema: Record<string, unknown>;
          retryCount?: number;
        };
      };
    }): Promise<{
      data?:
        | {
            parts?: Array<{ type?: string; text?: string }>;
            info?: {
              structured_output?: unknown;
              structured?: unknown;
              error?: {
                name: string;
                message?: string;
                data?: { message?: string; retries?: number };
              };
            };
          }
        | undefined;
      error?: unknown;
    }>;
  };
  /** Optional TUI client for toast notifications. Not available in headless/CLI mode. */
  tui?: {
    showToast(opts: {
      body: { message: string; variant?: 'info' | 'success' | 'error' };
    }): Promise<unknown>;
  };
}
