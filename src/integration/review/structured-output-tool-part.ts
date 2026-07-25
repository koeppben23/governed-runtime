/**
 * @module integration/review/structured-output-tool-part
 * @description Extract structured review findings from a host `StructuredOutput`
 * tool part.
 *
 * Some OpenCode host versions (verified against Desktop CLI v1.4.0) deliver a
 * `json_schema`-formatted response as a `tool` part named `StructuredOutput`
 * whose completed state carries the schema-validated object in `state.input`,
 * rather than as a top-level `info.structured_output` field. This helper reads
 * that tool part fail-closed: it returns findings ONLY for a genuine, completed,
 * host-validated StructuredOutput tool part with an object payload. A plain text
 * part is never a structured-output substitute — that remains the caller's
 * fail-closed / text-compat concern.
 */

/** The structured-output tool name emitted by the host. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** A response part as seen on the OrchestratorClient prompt response. */
interface ResponsePart {
  readonly type?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly callID?: string;
  readonly state?: {
    readonly status?: string;
    readonly input?: unknown;
    readonly metadata?: { valid?: unknown } & Record<string, unknown>;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the schema-validated findings object from a completed, host-validated
 * `StructuredOutput` tool part, or `null` if no such part is present.
 *
 * Fail-closed guards (all required):
 * - part `type === 'tool'` and `tool === 'StructuredOutput'`;
 * - `state.status === 'completed'`;
 * - `state.metadata.valid === true` (strict boolean; the host's own validation);
 * - `state.input` is a plain object (not an array or primitive).
 */
export function extractStructuredOutputToolPart(
  parts: readonly ResponsePart[] | undefined,
): Record<string, unknown> | null {
  if (!parts) return null;
  for (const part of parts) {
    if (part.type !== 'tool' || part.tool !== STRUCTURED_OUTPUT_TOOL) continue;
    const state = part.state;
    if (!state || state.status !== 'completed') continue;
    if (state.metadata?.valid !== true) continue;
    if (!isPlainObject(state.input)) continue;
    return state.input;
  }
  return null;
}
