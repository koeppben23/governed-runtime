import { createHash } from 'node:crypto';
import { ProbeError } from './isolation.mjs';

export function sessionBinding(session) {
  if (
    ![session?.id, session?.projectID, session?.location?.directory].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  ) {
    throw new ProbeError(
      'PROBE_SESSION_IDENTITY_INCOMPLETE',
      'Missing session/project/location identity',
    );
  }
  if (session.parentID !== undefined && typeof session.parentID !== 'string') {
    throw new ProbeError('PROBE_SESSION_IDENTITY_INCOMPLETE', 'Invalid parent identity');
  }
  return {
    id: session.id,
    parentID: session.parentID ?? null,
    projectID: session.projectID,
    directory: session.location.directory,
  };
}

export function unchangedBinding(before, after) {
  return JSON.stringify(sessionBinding(before)) === JSON.stringify(sessionBinding(after));
}

/** Diagnostic byte digest of an API observation, not a FlowGuard content digest. */
export function observationDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function stableSnapshots(before, after) {
  if (
    !Array.isArray(before) ||
    before.length === 0 ||
    !Array.isArray(after) ||
    before.length !== after.length
  )
    return false;
  return before.every(
    (item, index) =>
      /^[a-f0-9]{64}$/.test(item.contextSha256 ?? '') &&
      /^[a-f0-9]{64}$/.test(item.instructionsSha256 ?? '') &&
      unchangedBinding(item.session, after[index]?.session) &&
      item.contextSha256 === after[index]?.contextSha256 &&
      item.instructionsSha256 === after[index]?.instructionsSha256,
  );
}

export function normalAnswer(context, expected) {
  return context.some(
    (message) =>
      message.type === 'assistant' &&
      message.finish === 'stop' &&
      message.content?.some((part) => part.type === 'text' && part.text === expected),
  );
}

function singleNativeTool(context) {
  const tools = context
    .filter((message) => message.type === 'assistant')
    .flatMap((message) =>
      (message.content ?? [])
        .filter((part) => part.type === 'tool' && part.name === 'subagent')
        .map((tool) => ({ messageID: message.id, tool })),
    );
  return tools.length === 1 ? tools[0] : undefined;
}

export function nativeChildReference(context) {
  const reference = singleNativeTool(context);
  if (
    !reference ||
    reference.tool.state?.status !== 'completed' ||
    ![reference.tool.state.metadata?.sessionID, reference.tool.id, reference.messageID].every(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    Object.hasOwn(reference.tool.state.input ?? {}, 'sessionID')
  ) {
    throw new ProbeError(
      'PROBE_NATIVE_CHILD_AMBIGUOUS',
      'Missing/ambiguous fresh native child reference',
    );
  }
  return {
    sessionID: reference.tool.state.metadata.sessionID,
    toolCallID: reference.tool.id,
    assistantMessageID: reference.messageID,
  };
}

/** Correlation in this controlled host run, not independent native provenance. */
export function correlatedNativeChild(parent, child, context, events) {
  const reference = singleNativeTool(context);
  if (!reference) return false;
  const { tool, messageID } = reference;
  if (
    ![tool.id, messageID, child.id, parent.id].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return false;
  if (
    tool.state?.status !== 'completed' ||
    tool.state.metadata?.sessionID !== child.id ||
    Object.hasOwn(tool.state.input ?? {}, 'sessionID') ||
    child.parentID !== parent.id ||
    child.projectID !== parent.projectID ||
    child.location?.directory !== parent.location?.directory
  )
    return false;
  const created = events.filter(
    (event) => event.type === 'session.created' && event.data?.sessionID === child.id,
  );
  const completed = events.filter(
    (event) =>
      event.type === 'session.tool.success' &&
      event.data?.sessionID === parent.id &&
      event.data?.id === tool.id,
  );
  return (
    created.length === 1 &&
    completed.length === 1 &&
    created[0].data.parentID === parent.id &&
    created[0].data.location?.directory === child.location.directory &&
    created[0].durable?.aggregateID === child.id &&
    created[0].durable?.version === 1 &&
    completed[0].data.assistantMessageID === messageID &&
    completed[0].durable?.aggregateID === parent.id &&
    completed[0].durable?.version === 2 &&
    completed[0].data.metadata?.sessionID === child.id
  );
}

export async function waitForObservation(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new ProbeError('PROBE_OBSERVATION_TIMEOUT', `Timed out: ${label}`);
}

/** Live-only stream. Failure is retained, never converted into no observed events. */
export async function startScopeTrace(client) {
  const controller = new AbortController();
  const events = [];
  let failure;
  let ended = false;
  const task = (async () => {
    try {
      for await (const event of client.event.subscribe({
        signal: controller.signal,
        types: [
          'session.created',
          'session.deleted',
          'session.moved',
          'session.forked',
          'session.execution.started',
          'session.execution.succeeded',
          'session.execution.failed',
          'session.execution.interrupted',
          'session.inbox.enqueued',
          'session.inbox.delivered',
          'session.tool.called',
          'session.tool.success',
          'session.tool.failed',
        ],
      }))
        events.push(event);
    } catch (error) {
      if (!controller.signal.aborted) failure = String(error);
    } finally {
      ended = true;
    }
  })();
  try {
    await waitForObservation(() => {
      if (failure || ended)
        throw new ProbeError(
          'PROBE_EVENT_STREAM_FAILED',
          failure ?? 'Event stream ended before readiness',
        );
      return events.some((event) => event.type === 'server.connected');
    }, 'event subscription ready');
  } catch (error) {
    controller.abort();
    await task;
    throw error;
  }
  return {
    events,
    get failure() {
      return failure;
    },
    get ended() {
      return ended;
    },
    async stop() {
      controller.abort();
      await task;
    },
  };
}
