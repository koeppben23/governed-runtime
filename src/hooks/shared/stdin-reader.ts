/**
 * @module hooks/shared/stdin-reader
 * @description Read and parse JSON from stdin for command-line hook scripts.
 *
 * Reads all data from process.stdin, parses as JSON, and returns the payload.
 * Validates that the result is a non-null object with required fields.
 *
 * Fail-closed behavior:
 * - Empty stdin → throws (hook should deny or exit non-zero)
 * - Invalid JSON → throws (malformed input)
 * - Non-object JSON → throws (unexpected shape)
 * - Payload over the shared byte cap → destroys the stream and throws before JSON parsing
 *
 * @version v1
 */

import { Readable } from 'node:stream';

import { MAX_HOOK_PAYLOAD_BYTES } from './limits.js';

/**
 * Error thrown when stdin cannot be read or parsed.
 *
 * `observedBytes`/`observedPrefix` describe exactly the raw bytes the reader
 * actually observed; the retained prefix is capped at the shared payload byte
 * cap so a single oversized chunk cannot hold more than the cap in memory.
 * They are never an inference about unread payload bytes.
 */
export class StdinReadError extends Error {
  readonly observedBytes: number | null;
  readonly observedPrefix: Buffer | null;

  constructor(
    public readonly code: string,
    message: string,
    observed?: { readonly bytes: number | null; readonly prefix: Buffer | null },
  ) {
    super(message);
    this.name = 'StdinReadError';
    this.observedBytes = observed?.bytes ?? null;
    this.observedPrefix = observed?.prefix ?? null;
  }
}

export interface StdinReadResult {
  readonly payload: Record<string, unknown>;
  /** The observed raw stdin bytes (before trimming), bounded by the shared cap. */
  readonly raw: Buffer;
}

/**
 * Read all data from stdin and parse as JSON, retaining the observed raw bytes
 * for bounded failure records.
 *
 * Memory contract: only up to `MAX_HOOK_PAYLOAD_BYTES` is retained; the
 * observed byte count still reflects every chunk the reader saw (including one
 * that crosses the cap), while the retained prefix never exceeds the cap.
 *
 * @param stream - Readable stream (defaults to process.stdin). Injectable for testing.
 * @throws StdinReadError if stdin is empty, not valid JSON, not an object,
 *   oversized, or the stream fails after bytes were observed.
 */
export async function readStdinRaw(stream: Readable = process.stdin): Promise<StdinReadResult> {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let observedBytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += buffer.byteLength;
      keptBytes = keepCapped(kept, buffer, keptBytes);
      if (observedBytes > MAX_HOOK_PAYLOAD_BYTES) {
        stream.destroy();
        throw new StdinReadError(
          'STDIN_TOO_LARGE',
          `stdin exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`,
          { bytes: observedBytes, prefix: Buffer.concat(kept) },
        );
      }
    }
  } catch (err) {
    if (err instanceof StdinReadError) throw err;
    throw new StdinReadError(
      'STDIN_READ_FAILED',
      err instanceof Error ? err.message : String(err),
      { bytes: observedBytes, prefix: kept.length > 0 ? Buffer.concat(kept) : null },
    );
  }

  const raw = Buffer.concat(kept);
  return { payload: parseObservedPayload(raw), raw };
}

/** Retain at most `MAX_HOOK_PAYLOAD_BYTES` of the observed stream. */
function keepCapped(kept: Buffer[], buffer: Buffer, keptBytes: number): number {
  const room = MAX_HOOK_PAYLOAD_BYTES - keptBytes;
  if (room <= 0) return keptBytes;
  const slice = buffer.byteLength <= room ? buffer : buffer.subarray(0, room);
  kept.push(slice);
  return keptBytes + slice.byteLength;
}

/** Parse the observed (cap-bounded) raw bytes as a JSON object. */
function parseObservedPayload(raw: Buffer): Record<string, unknown> {
  const trimmed = raw.toString('utf-8').trim();

  if (trimmed.length === 0) {
    throw new StdinReadError('STDIN_EMPTY', 'No data received on stdin', {
      bytes: raw.byteLength,
      prefix: raw,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new StdinReadError(
      'STDIN_INVALID_JSON',
      `stdin is not valid JSON: ${trimmed.slice(0, 200)}`,
      { bytes: raw.byteLength, prefix: raw },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StdinReadError(
      'STDIN_NOT_OBJECT',
      `stdin must be a JSON object, got: ${typeof parsed}`,
      { bytes: raw.byteLength, prefix: raw },
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Read all data from stdin and parse as JSON.
 *
 * @param stream - Readable stream (defaults to process.stdin). Injectable for testing.
 * @returns Parsed JSON object.
 * @throws StdinReadError if stdin is empty, not valid JSON, or not an object.
 */
export async function readStdin(
  stream: Readable = process.stdin,
): Promise<Record<string, unknown>> {
  return (await readStdinRaw(stream)).payload;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectToolPayloadErrors(payload: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (typeof payload['tool_name'] !== 'string' || payload['tool_name'].length === 0) {
    errors.push('tool_name must be a non-empty string');
  }
  if (typeof payload['session_id'] !== 'string' || payload['session_id'].length === 0) {
    errors.push('session_id must be a non-empty string');
  }
  if (typeof payload['cwd'] !== 'string' || payload['cwd'].length === 0) {
    errors.push('cwd must be a non-empty string');
  }

  return errors;
}

function readRequiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Validate that the parsed payload contains required fields for PreToolUse/PostToolUse.
 *
 * @param payload - Parsed stdin JSON.
 * @returns Validated payload with required fields guaranteed present.
 * @throws StdinReadError if required fields are missing.
 */
export function validateToolHookPayload(payload: Record<string, unknown>): {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
  cwd: string;
  /** Present only when the hook fired inside a subagent call. */
  agent_id?: string;
  /** Subagent type name (frontmatter `name`), present inside a subagent call. */
  agent_type?: string;
  /** Tool result the model received; shape depends on the tool. */
  tool_response?: unknown;
} {
  // tool_input may be absent or non-object — default to empty
  const toolInput = isRecordValue(payload['tool_input']) ? payload['tool_input'] : {};
  const errors = collectToolPayloadErrors(payload);

  if (errors.length > 0) {
    throw new StdinReadError(
      'STDIN_VALIDATION_FAILED',
      `Hook payload validation failed: ${errors.join('; ')}`,
    );
  }

  const result: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    session_id: string;
    cwd: string;
    agent_id?: string;
    agent_type?: string;
    tool_response?: unknown;
  } = {
    tool_name: readRequiredString(payload, 'tool_name'),
    tool_input: toolInput,
    session_id: readRequiredString(payload, 'session_id'),
    cwd: readRequiredString(payload, 'cwd'),
  };

  // Subagent context: present only when the hook fires inside a subagent.
  // Absence is normal (main-thread call) — never an error.
  const agentId = readOptionalString(payload, 'agent_id');
  if (agentId !== undefined) {
    result.agent_id = agentId;
  }
  const agentType = readOptionalString(payload, 'agent_type');
  if (agentType !== undefined) {
    result.agent_type = agentType;
  }
  if (payload['tool_response'] !== undefined) {
    result.tool_response = payload['tool_response'];
  }

  return result;
}

/**
 * Validate that the parsed payload contains required fields for SessionStart/Stop.
 *
 * @param payload - Parsed stdin JSON.
 * @returns Validated payload with required fields guaranteed present.
 * @throws StdinReadError if required fields are missing.
 */
export function validateSessionPayload(payload: Record<string, unknown>): {
  session_id: string;
  cwd: string;
} {
  const errors: string[] = [];

  if (typeof payload['session_id'] !== 'string' || payload['session_id'].length === 0) {
    errors.push('session_id must be a non-empty string');
  }
  if (typeof payload['cwd'] !== 'string' || payload['cwd'].length === 0) {
    errors.push('cwd must be a non-empty string');
  }

  if (errors.length > 0) {
    throw new StdinReadError(
      'STDIN_VALIDATION_FAILED',
      `Hook payload validation failed: ${errors.join('; ')}`,
    );
  }

  return {
    session_id: payload['session_id'] as string,
    cwd: payload['cwd'] as string,
  };
}
