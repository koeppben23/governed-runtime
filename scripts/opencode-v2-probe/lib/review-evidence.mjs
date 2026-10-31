import { ProbeError } from './isolation.mjs';

export function lastUserText(body) {
  const user = [...(body?.messages ?? [])].reverse().find((message) => message.role === 'user');
  if (!user) return '';
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
}

export function requestSessionID(request) {
  const value = request?.headers?.['x-opencode-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

export function reviewerRequests(requests, childID) {
  return requests.filter((request) => requestSessionID(request) === childID);
}

export function textParts(assistant) {
  return (assistant?.content ?? []).filter((part) => part.type === 'text');
}

export function toolParts(context) {
  return context.flatMap((message) =>
    message.type === 'assistant'
      ? (message.content ?? [])
          .filter((part) => part.type === 'tool')
          .map((part) => ({ messageID: message.id, ...part }))
      : [],
  );
}

export function latestAssistantText(context) {
  const assistant = [...context].reverse().find((message) => message.type === 'assistant');
  return textParts(assistant)
    .map((part) => part.text)
    .join('');
}

/** Bind an answer to the exact reviewed prompt, not the latest assistant text. */
export function exactTerminalForPrompt(context, prompt, expectedText) {
  const userIndex = context.findIndex(
    (message) => message.type === 'user' && String(message.text ?? '').includes(prompt),
  );
  if (userIndex < 0)
    throw new ProbeError('PROBE_REVIEWER_PROMPT_MISSING', 'Reviewed user prompt missing');
  const assistantIndex = context.findIndex(
    (message, index) => index > userIndex && message.type === 'assistant',
  );
  if (assistantIndex < 0)
    throw new ProbeError('PROBE_REVIEWER_TERMINAL_MISSING', 'Terminal assistant missing');
  const between = context.slice(userIndex + 1, assistantIndex);
  if (between.length > 0)
    throw new ProbeError('PROBE_REVIEWER_INTERLEAVED', 'Unexpected messages before terminal');
  const assistant = context[assistantIndex];
  const tools = (assistant.content ?? []).filter((part) => part.type === 'tool');
  const text = textParts(assistant)
    .map((part) => part.text)
    .join('');
  if (tools.length > 0 || text !== expectedText || assistant.finish !== 'stop') {
    throw new ProbeError(
      'PROBE_REVIEWER_TERMINAL_INVALID',
      'Terminal is not a coherent tool-free stop',
    );
  }
  return {
    userIndex,
    assistantIndex,
    messageID: assistant.id,
    text,
    finish: assistant.finish,
    agent: assistant.agent,
    model: assistant.model,
    toolParts: tools.length,
  };
}

export function exactReviewerRequest(requests, childID, prompt) {
  const matches = reviewerRequests(requests, childID).filter((request) =>
    lastUserText(request.body).includes(prompt),
  );
  if (matches.length !== 1)
    throw new ProbeError(
      'PROBE_REVIEWER_REQUEST_AMBIGUOUS',
      `Expected one child request, got ${matches.length}`,
    );
  const request = matches[0];
  return {
    model: request.body?.model,
    reasoningEffort: request.body?.reasoning_effort,
    stream: request.body?.stream,
    lastUser: lastUserText(request.body),
  };
}

export function normalTerminal(context, expectedText) {
  return context.some(
    (message) =>
      message.type === 'assistant' &&
      message.finish === 'stop' &&
      textParts(message).some((part) => part.text === expectedText) &&
      !(message.content ?? []).some((part) => part.type === 'tool'),
  );
}
