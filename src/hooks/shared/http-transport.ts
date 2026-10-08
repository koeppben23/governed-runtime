/**
 * @module hooks/shared/http-transport
 * @description HTTP hook transport framing and fail-closed error responses.
 *
 * Owns the shared payload byte cap, header/body framing, and the D1 (#1027)
 * protocol-DENY responses for the blocking PreToolUse route. Claude Code treats
 * HTTP non-2xx hook responses as non-blocking, so authenticated PreToolUse
 * transport/validation failures are delivered as HTTP 200 with a protocol DENY
 * instead of a bare 4xx. Authentication (401), method (405), and unknown-route
 * (404) failures are decided by the server before this module is consulted; an
 * unauthenticated caller is not a PreToolUse decision, and a misconfigured
 * token remains a non-blocking host error (documented residual risk).
 *
 * @version v1
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_HOOK_PAYLOAD_BYTES } from './limits.js';
import { formatDenyOutput } from './stdout-writer.js';
import type { HookEventName } from './types.js';

class BodyTooLargeError extends Error {
  readonly observedBytes: number | null;
  readonly observedPrefix: string | null;

  constructor(observed?: { readonly bytes: number; readonly prefix: string }) {
    super(`request body exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
    this.observedBytes = observed?.bytes ?? null;
    this.observedPrefix = observed?.prefix ?? null;
  }
}

/** Bounded metadata for a transport ingestion failure (no raw payload claims). */
export interface IngestFailure {
  readonly reasonCode: string;
  readonly observedBytes: number | null;
  readonly observedPrefix: string | null;
}

/** Records a transport ingestion failure; returns whether it was persisted. */
export type IngestFailureSink = (failure: IngestFailure) => Promise<boolean>;

async function reportIngestFailure(
  sink: IngestFailureSink | undefined,
  failure: IngestFailure,
): Promise<boolean> {
  if (sink === undefined) return false;
  try {
    return await sink(failure);
  } catch {
    return false;
  }
}

function contentLengthExceedsLimit(req: IncomingMessage): boolean {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string') return false;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > MAX_HOOK_PAYLOAD_BYTES;
}

/** Read the request body under the shared hook payload byte cap. */
async function readBody(req: IncomingMessage): Promise<string> {
  if (contentLengthExceedsLimit(req)) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    chunks.push(buffer);
    if (total > MAX_HOOK_PAYLOAD_BYTES) {
      throw new BodyTooLargeError({
        bytes: total,
        prefix: Buffer.concat(chunks).toString('utf-8'),
      });
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Write a JSON response with an explicit status code. */
export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Deliver an authenticated transport/validation failure as a protocol DENY. */
function respondProtocolDeny(
  res: ServerResponse,
  event: HookEventName,
  code: string,
  reason: string,
): void {
  const denyOutput = formatDenyOutput(event, code, reason);
  jsonResponse(res, 200, { decision: 'deny', code, reason, ...denyOutput });
}

/** Collect the values of one header name, rejecting duplicates by count. */
export function headerValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  const rawHeaders = req.rawHeaders ?? [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? '');
  }
  if (values.length > 0) return values;

  const value = req.headers[name];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value : [];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequestBodyOrRespond(
  req: IncomingMessage,
  res: ServerResponse,
  protocolDenyEvent?: HookEventName,
  onIngestFailure?: IngestFailureSink,
): Promise<string | undefined> {
  try {
    return await readBody(req);
  } catch (err) {
    if (protocolDenyEvent) {
      respondProtocolDeny(
        res,
        protocolDenyEvent,
        'HOOK_STDIN_INVALID',
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
    const observed =
      err instanceof BodyTooLargeError
        ? { observedBytes: err.observedBytes, observedPrefix: err.observedPrefix }
        : { observedBytes: null, observedPrefix: null };
    const recorded = await reportIngestFailure(onIngestFailure, {
      reasonCode: 'HOOK_STDIN_INVALID',
      ...observed,
    });
    if (err instanceof BodyTooLargeError) {
      jsonResponse(res, 413, { error: 'Request body too large', auditFailureRecorded: recorded });
      return undefined;
    }
    jsonResponse(res, 400, {
      error: 'Failed to read request body',
      auditFailureRecorded: recorded,
    });
    return undefined;
  }
}

async function parseJsonObjectOrRespond(
  body: string,
  res: ServerResponse,
  protocolDenyEvent?: HookEventName,
  onIngestFailure?: IngestFailureSink,
): Promise<Record<string, unknown> | undefined> {
  const reportInvalid = async (error: string): Promise<undefined> => {
    const recorded = await reportIngestFailure(onIngestFailure, {
      reasonCode: 'HOOK_PAYLOAD_INVALID',
      observedBytes: Buffer.byteLength(body),
      observedPrefix: body,
    });
    jsonResponse(res, 400, { error, auditFailureRecorded: recorded });
    return undefined;
  };

  try {
    const parsed: unknown = JSON.parse(body);
    if (!isJsonObject(parsed)) {
      if (protocolDenyEvent) {
        respondProtocolDeny(
          res,
          protocolDenyEvent,
          'HOOK_PAYLOAD_INVALID',
          'Request body must be a JSON object',
        );
        return undefined;
      }
      return await reportInvalid('Request body must be a JSON object');
    }
    return parsed;
  } catch {
    if (protocolDenyEvent) {
      respondProtocolDeny(
        res,
        protocolDenyEvent,
        'HOOK_PAYLOAD_INVALID',
        'Invalid JSON in request body',
      );
      return undefined;
    }
    return await reportInvalid('Invalid JSON in request body');
  }
}

/** The PreToolUse route is the only blocking hook route in HTTP mode. */
export function protocolDenyEventFor(event: HookEventName): HookEventName | undefined {
  return event === 'PreToolUse' ? event : undefined;
}

/**
 * Validate and read the transport framing before dispatch. On the blocking
 * PreToolUse route every failure becomes a protocol DENY; the informational
 * routes keep their status codes.
 */
export async function readHookPayloadOrRespond(
  req: IncomingMessage,
  res: ServerResponse,
  protocolDenyEvent: HookEventName | undefined,
  onIngestFailure?: IngestFailureSink,
): Promise<Record<string, unknown> | undefined> {
  const contentTypes = headerValues(req, 'content-type');
  const [contentType] = contentTypes;
  const hasJsonContentType =
    contentTypes.length === 1 &&
    contentType !== undefined &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
  if (!hasJsonContentType) {
    if (protocolDenyEvent) {
      respondProtocolDeny(
        res,
        protocolDenyEvent,
        'HOOK_PAYLOAD_INVALID',
        'Content-Type must be application/json',
      );
      return undefined;
    }
    jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
    return undefined;
  }

  const body = await readRequestBodyOrRespond(req, res, protocolDenyEvent, onIngestFailure);
  if (body === undefined) return undefined;

  return parseJsonObjectOrRespond(body, res, protocolDenyEvent, onIngestFailure);
}
