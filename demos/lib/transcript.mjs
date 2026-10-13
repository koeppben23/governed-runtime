/**
 * @module demos/lib/transcript
 * @description Structured host-transcript forensics for the demo runners.
 *
 * Denials, recoveries and reviewer re-arms are classified from parsed JSON
 * envelopes, never from formatting-sensitive regexes. Recovery is bound to the
 * concrete denial occurrence: a denial is only `recovered` when a LATER
 * invocation of the same governed tool succeeded. Unreadable governed output
 * never grounds a success claim.
 *
 * @version v1
 */

const GOVERNED_TOOL_PREFIX = 'flowguard_';
const GOVERNED_TOOL_EXACT = new Set(['task']);

export function isGovernedTool(tool) {
  return (
    typeof tool === 'string' &&
    (tool.startsWith(GOVERNED_TOOL_PREFIX) || GOVERNED_TOOL_EXACT.has(tool))
  );
}

export function eventsOf(output) {
  return String(output)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Parse one governed tool payload; `unreadable` is a trust defect, not "no denial". */
export function parseHostPayload(raw) {
  if (typeof raw !== 'string') return { kind: 'none' };
  if (raw.trim() === '') return { kind: 'empty' };
  try {
    return { kind: 'json', value: JSON.parse(raw) };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function toolUseEvents(output) {
  const events = [];
  let index = 0;
  for (const event of eventsOf(output)) {
    index += 1;
    if (event.type !== 'tool_use') continue;
    events.push({
      index,
      tool: typeof event.part?.tool === 'string' ? event.part.tool : undefined,
      payload: parseHostPayload(event.part?.state?.output),
    });
  }
  return events;
}

/** Ordered governed tool_use events with parsed payloads. */
export function governedToolEvents(output) {
  return toolUseEvents(output).filter((event) => isGovernedTool(event.tool));
}

/** Trust boundary: governed output that cannot be parsed can never prove success. */
export function transcriptTrust(output) {
  const unreadable = governedToolEvents(output)
    .filter((event) => event.payload.kind === 'unreadable')
    .map((event) => ({ index: event.index, tool: event.tool }));
  return { readable: unreadable.length === 0, unreadable };
}

/** Ordered denial occurrences with the tool that produced them (when named). */
export function toolDenialEvents(output) {
  const denials = [];
  for (const event of toolUseEvents(output)) {
    if (event.payload.kind !== 'json') continue;
    const value = event.payload.value;
    if (value && value.error === true && typeof value.code === 'string') {
      denials.push({ index: event.index, tool: event.tool, code: value.code });
    }
  }
  return denials;
}

export function toolDenialCodes(output) {
  const codes = [];
  for (const denial of toolDenialEvents(output)) {
    if (!codes.includes(denial.code)) codes.push(denial.code);
  }
  return codes;
}

export function deniedToolForCode(output, code) {
  return toolDenialEvents(output).find((denial) => denial.code === code)?.tool;
}

/**
 * A completed governed call. Transport re-arms and unfulfilled review
 * dispatches are explicitly not successes.
 */
function isSuccessPayload(value) {
  if (!value || typeof value !== 'object' || value.error === true) return false;
  if (value.reviewRetry !== undefined) return false;
  if (value.reviewDispatch && value.reviewDispatch.completed === false) return false;
  return true;
}

export function governedSuccessEvents(output) {
  return governedToolEvents(output).filter(
    (event) => event.payload.kind === 'json' && isSuccessPayload(event.payload.value),
  );
}

/**
 * Occurrence-bound recovery proofs. A denial is recovered iff a later
 * invocation of the same governed tool succeeded; one later success may
 * resolve several earlier rejections, but a denial after the last success
 * stays open.
 */
export function sameTurnRecoveryProofs(output) {
  const denials = toolDenialEvents(output);
  const successes = governedSuccessEvents(output);
  const recovered = [];
  const unproven = [];
  for (const denial of denials) {
    const success = successes.find(
      (candidate) =>
        denial.tool !== undefined &&
        candidate.index > denial.index &&
        candidate.tool === denial.tool,
    );
    if (success === undefined) {
      unproven.push({ code: denial.code, tool: denial.tool, index: denial.index });
    } else {
      recovered.push({
        code: denial.code,
        tool: denial.tool,
        denialIndex: denial.index,
        successIndex: success.index,
      });
    }
  }
  return { recovered, unproven };
}

/** Compatibility projection: tools with at least one proven occurrence recovery. */
export function sameTurnCorrectedTools(output) {
  return new Set(sameTurnRecoveryProofs(output).recovered.map((proof) => proof.tool));
}

/** Structured reviewer capture re-arms (`reviewDispatch.completed === false`). */
export function captureRetryEvents(output) {
  const events = [];
  for (const event of toolUseEvents(output)) {
    if (event.payload.kind !== 'json') continue;
    const retry = event.payload.value?.reviewRetry;
    if (retry && typeof retry.code === 'string') {
      events.push({
        index: event.index,
        code: retry.code,
        obligationId: typeof retry.obligationId === 'string' ? retry.obligationId : null,
        attemptId: typeof retry.attemptId === 'string' ? retry.attemptId : null,
        retryable: retry.retryable === true,
      });
    }
  }
  return events;
}

export function captureRetryCodes(output) {
  const codes = [];
  for (const event of captureRetryEvents(output)) {
    if (!codes.includes(event.code)) codes.push(event.code);
  }
  return codes;
}

/**
 * A terminal capture block is superseded only by a structured re-arm on the
 * SAME code that occurs LATER in the transcript.
 */
export function structuredRearmSupersedesTerminal(output, code) {
  const terminals = toolDenialEvents(output).filter((denial) => denial.code === code);
  const rearms = captureRetryEvents(output).filter((event) => event.code === code);
  if (terminals.length === 0 || rearms.length === 0) return false;
  const lastTerminal = Math.max(...terminals.map((denial) => denial.index));
  const lastRearm = Math.max(...rearms.map((event) => event.index));
  return lastRearm > lastTerminal;
}

/** The controlled negative probe: exactly the expected denial, provably nothing else. */
export function assertExpectedDenial(output, expectedCode) {
  const trust = transcriptTrust(output);
  if (!trust.readable) {
    throw new Error(
      `transcript contains ${trust.unreadable.length} unreadable governed tool output(s); ` +
        `cannot certify the expected denial ${expectedCode}`,
    );
  }
  const codes = toolDenialCodes(output);
  if (!codes.includes(expectedCode)) {
    throw new Error(`expected denial ${expectedCode}, observed [${codes.join(', ') || 'none'}]`);
  }
  const unexpected = codes.filter((code) => code !== expectedCode);
  if (unexpected.length > 0) {
    throw new Error(`unexpected denial(s) alongside ${expectedCode}: ${unexpected.join(', ')}`);
  }
}
