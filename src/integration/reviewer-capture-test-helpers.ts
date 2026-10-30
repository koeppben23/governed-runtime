/** Host-contract fixtures. These simulate hooks, not provider compatibility. */
import type { OrchestratorClient } from './review/types.js';
import type { Hooks } from '@opencode-ai/plugin';
import { ReviewerCaptureController } from './reviewer-capture.js';

export const CAPTURE_OBLIGATION = '44444444-4444-4444-8444-444444444444';
export const CAPTURE_ATTEMPT = '55555555-5555-4555-8555-555555555555';
export const CAPTURE_MODEL = {
  providerID: 'test-provider',
  modelID: 'test-model',
  variant: 'high',
} as const;

export function reviewerInputFixture() {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: CAPTURE_OBLIGATION },
  };
}

export function completedReviewMessages(child: string, model = CAPTURE_MODEL) {
  return {
    data: [
      {
        info: {
          id: 'msg_native_request',
          sessionID: child,
          role: 'user',
          agent: 'flowguard-reviewer',
          model,
        },
      },
      {
        info: {
          id: 'msg_native_answer',
          parentID: 'msg_native_request',
          sessionID: child,
          role: 'assistant',
          agent: 'flowguard-reviewer',
          ...model,
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'Final review answer.' }],
      },
    ],
  };
}

export function hostJsonReply(payload: unknown) {
  return { data: { parts: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/** Run the actual product hooks around a mock SDK operation, as the host does. */
export function wireReviewerHostFixture(
  client: { session: Record<string, unknown> },
  hooks: Hooks,
): void {
  const original = client.session.prompt;
  if (typeof original !== 'function') throw new Error('Host fixture requires session.prompt.');
  client.session.prompt = async (opts: Parameters<OrchestratorClient['session']['prompt']>[0]) => {
    const { messageID, model, variant, agent } = opts.body;
    if (!messageID || !model || !agent) throw new Error('Missing fixture request identity.');
    const message = {
      id: messageID,
      sessionID: opts.path.id,
      role: 'user',
      agent,
      time: { created: Date.now() },
      model: { ...model, ...(variant === undefined ? {} : { variant }) },
    };
    const output = { message, parts: opts.body.parts };
    await hooks['chat.message']?.({ sessionID: opts.path.id }, output as never);
    await hooks['experimental.chat.messages.transform']?.({}, {
      messages: [{ info: message, parts: opts.body.parts }],
    } as never);
    await hooks['chat.params']?.(
      {
        sessionID: opts.path.id,
        agent,
        message,
        provider: {},
        model: {
          id: model.modelID,
          providerID: model.providerID,
          limit: { context: 1_000_000, output: 1_000_000 },
        },
      } as never,
      { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 8192, options: {} },
    );
    const response = (await original.call(client.session, opts)) as Awaited<
      ReturnType<OrchestratorClient['session']['prompt']>
    >;
    if (!response.data) return response;
    return {
      ...response,
      data: {
        ...response.data,
        info: {
          id: `msg_response_${messageID}`,
          parentID: messageID,
          sessionID: opts.path.id,
          role: 'assistant',
          agent,
          providerID: model.providerID,
          modelID: model.modelID,
          ...(variant === undefined ? {} : { variant }),
          finish: 'stop',
          time: { completed: Date.now() },
          ...response.data.info,
        },
      },
    };
  };
}

export function observedPrompt(
  controller: ReviewerCaptureController,
  opts: Parameters<OrchestratorClient['session']['prompt']>[0],
  text: string,
) {
  const { messageID, model: selected, agent, variant } = opts.body;
  if (!messageID || !selected || !agent)
    throw new Error('Host fixture requires explicit request identity.');
  const model = { ...selected, ...(variant === undefined ? {} : { variant }) };
  const user = { id: messageID, sessionID: opts.path.id, role: 'user', agent, model };
  controller.onMessage({ sessionID: opts.path.id }, { message: user, parts: opts.body.parts });
  controller.onMessages({ messages: [{ info: user, parts: opts.body.parts }] });
  controller.onParams(
    {
      sessionID: opts.path.id,
      agent: opts.body.agent,
      message: user,
      model: { providerID: model.providerID, id: model.modelID },
    },
    { options: {} },
  );
  return {
    data: {
      info: {
        id: `msg_response_${messageID}`,
        parentID: messageID,
        sessionID: opts.path.id,
        role: 'assistant',
        agent,
        providerID: model.providerID,
        modelID: model.modelID,
        ...(variant === undefined ? {} : { variant }),
        finish: 'stop',
        time: { completed: Date.now() },
      },
      parts: [{ type: 'text', text }],
    },
  };
}
