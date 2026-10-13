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

/** Parse JSONL framing explicitly: unparseable lines are trust defects, not noise. */
export function parseTranscript(output) {
  const events = [];
  const framingLosses = [];
  const lines = String(output).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      framingLosses.push(index + 1);
    }
  }
  return { events, framingLosses };
}

export function eventsOf(output) {
  return parseTranscript(output).events;
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

/** Trust boundary: framing losses or unparseable governed output can never prove success. */
export function transcriptTrust(output) {
  const { framingLosses } = parseTranscript(output);
  const unreadable = governedToolEvents(output)
    .filter((event) => event.payload.kind === 'unreadable')
    .map((event) => ({ index: event.index, tool: event.tool }));
  return {
    readable: framingLosses.length === 0 && unreadable.length === 0,
    framingLosses,
    unreadable,
  };
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
 * Typed operation identities exposed by governed envelopes. A claim identity
 * cannot override a contradictory subject or obligation. Multiple exposed
 * locations of the same identity must also be coherent within one envelope.
 */
export function operationIdentity(payload) {
  if (payload?.kind !== 'json' || !payload.value || typeof payload.value !== 'object') {
    return { bindings: {}, conflicts: [] };
  }
  const value = payload.value;
  const bindings = {};
  const conflicts = [];
  for (const [type, candidates] of [
    ['claimId', [value.claimId, value.detail?.claimId]],
    [
      'subjectDigest',
      [
        value.planDigest,
        value.subjectDigest,
        value.detail?.planDigest,
        value.detail?.subjectDigest,
        value.reviewFeedback?.obligation?.subjectDigest,
      ],
    ],
    [
      'obligationId',
      [
        value.obligationId,
        value.reviewObligation?.obligationId,
        value.reviewRetry?.obligationId,
        value.reviewFeedback?.obligation?.id,
        value.detail?.obligationId,
      ],
    ],
  ]) {
    const present = candidates.filter((candidate) => candidate !== undefined && candidate !== null);
    if (
      present.some((candidate) => typeof candidate !== 'string' || candidate.length === 0) ||
      new Set(present).size > 1
    ) {
      conflicts.push(type);
    } else if (present.length > 0) {
      bindings[type] = present[0];
    }
  }
  return { bindings, conflicts };
}

function sameOperation(denial, success) {
  if (denial.conflicts.length > 0 || success.conflicts.length > 0) return false;
  const required = Object.entries(denial.bindings);
  return required.length > 0 && required.every(([type, value]) => success.bindings[type] === value);
}

/**
 * Occurrence-bound recovery proofs. A denial is recovered iff a later
 * invocation of the same governed tool succeeded. The proof records WHICH
 * binding was available: `operation` only when all denial identities match
 * by type with no explicit contradiction, otherwise `tool` (observation only).
 * A denial after the last success stays open.
 */
export function sameTurnRecoveryProofs(output) {
  const events = toolUseEvents(output);
  const denials = toolDenialEvents(output);
  const successes = governedSuccessEvents(output);
  const recovered = [];
  const unproven = [];
  for (const denial of denials) {
    const denialEvent = events.find((event) => event.index === denial.index);
    const denialIdentity = operationIdentity(denialEvent?.payload);
    const candidates = successes.filter(
      (candidate) =>
        denial.tool !== undefined &&
        candidate.index > denial.index &&
        candidate.tool === denial.tool,
    );
    // Prefer the matching operation over an earlier, unrelated tool success.
    const matched = candidates.find((candidate) =>
      sameOperation(denialIdentity, operationIdentity(candidate.payload)),
    );
    const success = matched ?? candidates[0];
    if (success === undefined) {
      unproven.push({ code: denial.code, tool: denial.tool, index: denial.index });
    } else {
      recovered.push({
        code: denial.code,
        tool: denial.tool,
        denialIndex: denial.index,
        successIndex: success.index,
        binding: matched !== undefined ? 'operation' : 'tool',
        operationIdentity:
          matched !== undefined ? operationIdentity(matched.payload).bindings : null,
        denialIdentity,
      });
    }
  }
  return { recovered, unproven };
}

/** Structured reviewer capture re-arms (`reviewDispatch.completed === false`). */
export function captureRetryEvents(output) {
  const events = [];
  for (const event of governedToolEvents(output)) {
    if (event.payload.kind !== 'json') continue;
    if (event.payload.value?.error === true) continue;
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
    if (!authorizedRearm(event)) continue;
    if (!codes.includes(event.code)) codes.push(event.code);
  }
  return codes;
}

function authorizedRearm(event) {
  if (event.retryable !== true) return false;
  return (
    typeof event.obligationId === 'string' &&
    event.obligationId.length > 0 &&
    typeof event.attemptId === 'string' &&
    event.attemptId.length > 0
  );
}

/** Observations only: no anonymous or partially identified hint authorizes re-arm. */
export function captureRetryHints(output) {
  return captureRetryEvents(output).filter((event) => event.retryable && !authorizedRearm(event));
}

/**
 * A terminal capture block is superseded only by a structured re-arm on the
 * SAME code, with retryable:true and a fresh attempt on the SAME obligation.
 * Without the terminal obligation identity there is no supersession proof.
 */
export function structuredRearmSupersedesTerminal(output, code) {
  const events = toolUseEvents(output);
  const terminals = toolDenialEvents(output).filter((denial) => denial.code === code);
  const rearms = captureRetryEvents(output).filter(
    (event) => event.code === code && authorizedRearm(event),
  );
  if (terminals.length === 0 || rearms.length === 0) return false;
  const lastTerminal = terminals.at(-1);
  const terminal = events.find((event) => event.index === lastTerminal?.index)?.payload.value;
  const obligationId = terminal?.detail?.obligationId ?? terminal?.obligationId;
  const failedAttemptId = terminal?.detail?.attemptId ?? terminal?.attemptId;
  if (typeof obligationId !== 'string' || obligationId.length === 0) return false;
  return rearms.some((rearm) => {
    if (lastTerminal === undefined || rearm.index <= lastTerminal.index) return false;
    return (
      rearm.obligationId === obligationId &&
      rearm.attemptId !== null &&
      rearm.attemptId !== failedAttemptId
    );
  });
}

/** The controlled negative probe: exactly the expected denial, provably nothing else. */
export function assertExpectedDenial(output, expectedCode) {
  const trust = transcriptTrust(output);
  if (!trust.readable) {
    throw new Error(
      `transcript is not trustworthy (${trust.framingLosses.length} framing loss(es), ` +
        `${trust.unreadable.length} unreadable governed tool output(s)); ` +
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
