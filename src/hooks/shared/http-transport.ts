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
  readonly observedPrefix: Buffer | null;

  constructor(observed: { readonly bytes: number | null; readonly prefix: Buffer | null } | null) {
    super(`request body exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
    this.observedBytes = observed?.bytes ?? null;
    this.observedPrefix = observed?.prefix ?? null;
  }
}

/** Stream failure after zero or more chunks were observed. */
class BodyStreamError extends Error {
  readonly observedBytes: number;
  readonly observedPrefix: Buffer | null;

  constructor(
    message: string,
    observed: { readonly bytes: number; readonly prefix: Buffer | null },
  ) {
    super(message);
    this.name = 'BodyStreamError';
    this.observedBytes = observed.bytes;
    this.observedPrefix = observed.prefix;
  }
}

/** Bounded metadata for a transport ingestion failure (no raw payload claims). */
export interface IngestFailure {
  readonly reasonCode: string;
  readonly observedBytes: number | null;
  readonly observedPrefix: Buffer | null;
}

/** Records a transport ingestion failure; returns whether it was persisted. */
export type IngestFailureSink = (failure: IngestFailure) => Promise<boolean>;

/** Successfully read hook payload plus its observed raw bytes (cap-bounded). */
export interface HookPayloadRead {
  readonly payload: Record<string, unknown>;
  readonly observedBytes: number;
  readonly observedPrefix: Buffer;
}

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

/**
 * Read the request body under the shared hook payload byte cap.
 *
 * Memory contract: only up to `MAX_HOOK_PAYLOAD_BYTES` is retained; a single
 * oversized chunk is sliced to the remaining cap room before retention, while
 * the observed byte count reflects the full chunk the reader saw.
 */
async function readBody(req: IncomingMessage): Promise<{ text: string; observed: Buffer }> {
  if (contentLengthExceedsLimit(req)) throw new BodyTooLargeError(null);
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let observedBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      observedBytes += buffer.byteLength;
      const room = MAX_HOOK_PAYLOAD_BYTES - keptBytes;
      if (room > 0) {
        const slice = buffer.byteLength <= room ? buffer : buffer.subarray(0, room);
        kept.push(slice);
        keptBytes += slice.byteLength;
      }
      if (observedBytes > MAX_HOOK_PAYLOAD_BYTES) {
        throw new BodyTooLargeError({ bytes: observedBytes, prefix: Buffer.concat(kept) });
      }
    }
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    throw new BodyStreamError(err instanceof Error ? err.message : String(err), {
      bytes: observedBytes,
      prefix: kept.length > 0 ? Buffer.concat(kept) : null,
    });
  }
  const observed = Buffer.concat(kept);
  return { text: observed.toString('utf-8'), observed };
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
): Promise<{ text: string; observed: Buffer } | undefined> {
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
      err instanceof BodyTooLargeError || err instanceof BodyStreamError
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
  observed: Buffer,
  res: ServerResponse,
  protocolDenyEvent?: HookEventName,
  onIngestFailure?: IngestFailureSink,
): Promise<Record<string, unknown> | undefined> {
  const reportInvalid = async (error: string): Promise<undefined> => {
    const recorded = await reportIngestFailure(onIngestFailure, {
      reasonCode: 'HOOK_PAYLOAD_INVALID',
      observedBytes: observed.byteLength,
      observedPrefix: observed,
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
): Promise<HookPayloadRead | undefined> {
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
    // The body is deliberately not read for a wrong content type; the record is
    // an honest unavailable-digest ingestion failure.
    const recorded = await reportIngestFailure(onIngestFailure, {
      reasonCode: 'HOOK_PAYLOAD_INVALID',
      observedBytes: null,
      observedPrefix: null,
    });
    jsonResponse(res, 415, {
      error: 'Content-Type must be application/json',
      auditFailureRecorded: recorded,
    });
    return undefined;
  }

  const body = await readRequestBodyOrRespond(req, res, protocolDenyEvent, onIngestFailure);
  if (body === undefined) return undefined;

  const payload = await parseJsonObjectOrRespond(
    body.text,
    body.observed,
    res,
    protocolDenyEvent,
    onIngestFailure,
  );
  if (payload === undefined) return undefined;

  return {
    payload,
    observedBytes: body.observed.byteLength,
    observedPrefix: body.observed,
  };
}
