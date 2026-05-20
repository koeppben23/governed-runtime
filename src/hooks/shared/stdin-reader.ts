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
 *
 * @version v1
 */

/**
 * Error thrown when stdin cannot be read or parsed.
 */
export class StdinReadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StdinReadError';
  }
}

/**
 * Read all data from stdin and parse as JSON.
 *
 * @param stream - Readable stream (defaults to process.stdin). Injectable for testing.
 * @returns Parsed JSON object.
 * @throws StdinReadError if stdin is empty, not valid JSON, or not an object.
 */
export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  if (raw.length === 0) {
    throw new StdinReadError('STDIN_EMPTY', 'No data received on stdin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StdinReadError('STDIN_INVALID_JSON', `stdin is not valid JSON: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StdinReadError(
      'STDIN_NOT_OBJECT',
      `stdin must be a JSON object, got: ${typeof parsed}`,
    );
  }

  return parsed as Record<string, unknown>;
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
} {
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

  // tool_input may be absent or non-object — default to empty
  const toolInput =
    typeof payload['tool_input'] === 'object' &&
    payload['tool_input'] !== null &&
    !Array.isArray(payload['tool_input'])
      ? (payload['tool_input'] as Record<string, unknown>)
      : {};

  if (errors.length > 0) {
    throw new StdinReadError(
      'STDIN_VALIDATION_FAILED',
      `Hook payload validation failed: ${errors.join('; ')}`,
    );
  }

  return {
    tool_name: payload['tool_name'] as string,
    tool_input: toolInput,
    session_id: payload['session_id'] as string,
    cwd: payload['cwd'] as string,
  };
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
