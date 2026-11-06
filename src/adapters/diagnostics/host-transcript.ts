/**
 * @module adapters/diagnostics/host-transcript
 * @description Validation and normalization of host transcript payloads.
 *
 * Host-specific capture (which executable/API produced the payload) belongs to
 * the CLI or integration adapter. This module only validates the shared shape
 * before redaction and persistence.
 */

export type DiagnosticHostErrorCode =
  'HOST_EXPORT_INVALID' | 'HOST_EXPORT_TIMEOUT' | 'HOST_EXPORT_TOO_LARGE';

export class DiagnosticHostError extends Error {
  readonly code: DiagnosticHostErrorCode;

  constructor(code: DiagnosticHostErrorCode, message: string) {
    super(message);
    this.name = 'DiagnosticHostError';
    this.code = code;
  }
}

export interface HostTranscript {
  readonly sessionId: string;
  readonly payload: Record<string, unknown>;
  readonly messageCount: number;
  readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', `Missing ${label} in host transcript.`);
  }
  return value;
}

function validatePart(part: unknown, sessionId: string, partIds: Set<string>): void {
  if (!isRecord(part)) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host transcript part is not an object.');
  }
  const partId = requireString(part['id'], 'part id');
  if (partIds.has(partId)) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', `Duplicate host part id: ${partId}`);
  }
  partIds.add(partId);
  if (part['sessionID'] !== undefined && part['sessionID'] !== sessionId) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host part belongs to another session.');
  }
  if (part['messageID'] !== undefined && typeof part['messageID'] !== 'string') {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host part message id is invalid.');
  }
}

function validateMessage(
  message: unknown,
  sessionId: string,
  messageIds: Set<string>,
  partIds: Set<string>,
): void {
  if (!isRecord(message)) {
    throw new DiagnosticHostError(
      'HOST_EXPORT_INVALID',
      'Host transcript message is not an object.',
    );
  }
  const info = message['info'];
  if (info !== undefined) {
    if (!isRecord(info)) {
      throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host message info is not an object.');
    }
    const messageId = requireString(info['id'], 'message id');
    if (messageIds.has(messageId)) {
      throw new DiagnosticHostError(
        'HOST_EXPORT_INVALID',
        `Duplicate host message id: ${messageId}`,
      );
    }
    messageIds.add(messageId);
    if (info['sessionID'] !== undefined && info['sessionID'] !== sessionId) {
      throw new DiagnosticHostError(
        'HOST_EXPORT_INVALID',
        'Host message belongs to another session.',
      );
    }
  }
  const parts = message['parts'];
  if (parts === undefined) return;
  if (!Array.isArray(parts)) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host message parts are not an array.');
  }
  for (const part of parts) validatePart(part, sessionId, partIds);
}

/** Validate a host export payload without trusting optional fields as lineage. */
export function validateHostTranscript(
  payload: unknown,
  expectedSessionId: string,
  bytes: number,
): HostTranscript {
  if (!isRecord(payload)) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host transcript is not an object.');
  }
  const info = payload['info'];
  if (!isRecord(info)) {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host transcript has no info object.');
  }
  if (requireString(info['id'], 'session id') !== expectedSessionId) {
    throw new DiagnosticHostError(
      'HOST_EXPORT_INVALID',
      `Host transcript session identity mismatch for ${expectedSessionId}.`,
    );
  }
  const messages = payload['messages'];
  if (!Array.isArray(messages)) {
    throw new DiagnosticHostError(
      'HOST_EXPORT_INVALID',
      'Host transcript messages are not an array.',
    );
  }
  const messageIds = new Set<string>();
  const partIds = new Set<string>();
  for (const message of messages) {
    validateMessage(message, expectedSessionId, messageIds, partIds);
  }
  return { sessionId: expectedSessionId, payload, messageCount: messages.length, bytes };
}

/** Normalize an already-loaded host payload (used by the native plugin context). */
export function normalizeHostTranscript(
  payload: unknown,
  expectedSessionId: string,
  maxBytes?: number,
): HostTranscript {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (maxBytes !== undefined && bytes > maxBytes)
    throw new DiagnosticHostError(
      'HOST_EXPORT_TOO_LARGE',
      `Host transcript exceeds the ${maxBytes}-byte capture limit.`,
    );
  return validateHostTranscript(payload, expectedSessionId, bytes);
}
