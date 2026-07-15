/** Sanitized fatal diagnostics for the MCP stdio entry point. */

import { sanitizeDiagnosticString } from '../logging/redact.js';

export function reportMcpFatalError(err: unknown): void {
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = '[unprintable]';
  }
  process.stderr.write(`[FlowGuard MCP] Fatal error: ${sanitizeDiagnosticString(message)}\n`);
  process.exitCode = 1;
}
