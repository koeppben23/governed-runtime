/**
 * @module integration/diagnostics/notification-view
 * @description Explicit unsupported-delivery report for Desktop notifications.
 *
 * No installed pinned-host proof exists for OpenCode Desktop panel or toast
 * delivery. The command surface therefore reports `NOT_VERIFIED` and keeps the
 * file log as the reliable diagnostic baseline. It never calls a toast API.
 */

import type { NotificationView } from './types.js';

export interface NotificationViewRequest {
  /** Existing `.opencode/logs` directory, or null when unavailable. */
  readonly logDirectory: string | null;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
}

/** Build the explicit notification-delivery capability report. */
export function buildNotificationView(request: NotificationViewRequest): NotificationView {
  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'notifications',
    generatedAt: (request.now ?? (() => new Date()))().toISOString(),
    status: 'NOT_VERIFIED',
    delivery: 'unsupported',
    reason:
      'No installed pinned-host proof exists for Desktop panel or notification delivery; API documentation and mocked clients are not acceptance.',
    fallback: {
      kind: 'file-logs',
      directory: request.logDirectory,
      note: 'File logs in the existing FlowGuard log directory remain the complete diagnostic fallback. No toast, panel or governance action is attempted.',
    },
    constraints: [
      'Notifications would be redacted, deduplicated and rate-limited before any host call.',
      'A notification can never approve, mutate state, unlock capacity or become evidence.',
      'Installed Desktop and TUI behavior must be verified separately before delivery is reported as supported.',
    ],
  };
}
