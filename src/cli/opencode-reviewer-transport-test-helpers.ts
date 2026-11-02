/** Host-mechanism instrumentation only: no FlowGuard product, activation,
 * dispatch authorization or evidence writer is loaded by this fixture. */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodeEvent } from '@opencode/client';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import {
  createNativeHostProbe,
  type NativeProbeReply,
  type NativeHostProbe,
} from './opencode-native-test-helpers.js';

export interface TransportObservation {
  readonly hook: string;
  readonly input?: {
    readonly sessionID: string;
    readonly messageID?: string;
    readonly id?: string;
    readonly tool?: string;
    readonly status?: string;
    readonly text?: string;
    readonly capture?: boolean;
    readonly agent?: string;
    readonly model?: { providerID: string; id: string; variant?: string };
    readonly kind?: string;
    readonly keys?: string[];
    readonly tools?: string[];
    readonly messages?: unknown;
  };
  readonly event?: OpenCodeEvent;
}

function replyGate() {
  let release: (reply: NativeProbeReply) => void = () => {};
  const promise = new Promise<NativeProbeReply>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export interface ReviewerTransportProbe extends NativeHostProbe {
  readonly reviewText: string;
  readonly captureText: string;
  readonly payload: string;
  readonly sentinel: string;
  start(): ReturnType<NativeHostProbe['session']>;
  releaseReview(): void;
  releaseCapture(): void;
  captureRequests(): number;
  observations(): Promise<TransportObservation[]>;
}

export async function createReviewerTransportProbe(
  mode: 'positive' | 'tool' = 'positive',
): Promise<ReviewerTransportProbe> {
  const review = replyGate();
  const capture = replyGate();
  const reviewText = `Review this frozen fixture subject. Run: ${randomUUID()}`;
  const captureText = `Serialize the same fixture review as one JSON object. Run: ${randomUUID()}`;
  const payload = JSON.stringify({ verdict: 'fixture-only', nonce: randomUUID() });
  const sentinel = `MUST_NOT_REACH_PROVIDER_${randomUUID()}`;
  let parentID = '';
  let parentTurns = 0;
  let captureRequests = 0;
  let project = '';
  const probe = await createNativeHostProbe({
    agent: REVIEWER_AGENT,
    plugin: `
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'reviewer-transport-observer', async setup(ctx) {
  const record = value => appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify(value) + '\\n');
  const registrations = [];
  let captureSession;
  // This exact fixture text arms only sandbox instrumentation. It is NOT a
  // product capability, actor decision or authorization derived from text.
  registrations.push(await ctx.session.hook('prompt', event => {
    if (event.prompt.text === ${JSON.stringify(captureText)}) captureSession = event.sessionID;
    record({ hook: 'prompt', input: { sessionID: event.sessionID, messageID: event.messageID, text: event.prompt.text, capture: captureSession === event.sessionID } });
  }));
  registrations.push(await ctx.session.hook('context', event => {
    const capturing = captureSession === event.sessionID;
    record({ hook: 'context', input: { sessionID: event.sessionID, agent: event.agent, model: event.model, messages: event.messages, capture: capturing, tools: Object.keys(event.tools) } });
    if (capturing) for (const name of Object.keys(event.tools)) delete event.tools[name];
  }));
  registrations.push(await ctx.session.hook('model.request', event => record({ hook: 'model.request', input: {
    sessionID: event.sessionID, agent: event.agent, model: event.model,
    kind: event.kind, keys: Object.keys(event).sort(), capture: captureSession === event.sessionID,
  } })));
  registrations.push(await ctx.tool.hook('execute.before', event => {
    const capturing = captureSession === event.sessionID;
    record({ hook: 'tool.before', input: { sessionID: event.sessionID, messageID: event.messageID, id: event.id, tool: event.tool, capture: capturing } });
    if (capturing) throw Object.assign(new Error('Fixture capture tool attempt'), { name: 'FixtureCaptureToolAttempt' });
  }));
  registrations.push(await ctx.tool.hook('execute.after', event => record({ hook: 'tool.after', input: {
    sessionID: event.sessionID, messageID: event.messageID, id: event.id, tool: event.tool, status: event.status,
  } })));
  const controller = new AbortController();
  const observing = (async () => { try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type.startsWith('session.')) record({ hook: 'event', event });
    }
  } catch (error) { if (!controller.signal.aborted) throw error; } })();
  return async () => { controller.abort(); await observing; for (const registration of registrations) await registration.dispose(); };
} });`,
    async prepare(directory) {
      project = directory;
      await writeFile(join(project, 'transport-sentinel.txt'), sentinel);
    },
    async script(body, sessionID) {
      if (sessionID === parentID) {
        if (parentTurns++ === 0)
          return {
            tool: {
              name: 'subagent',
              arguments: {
                agent: 'flowguard-reviewer',
                background: false,
                description: 'Native reviewer mechanism',
                prompt: reviewText,
              },
            },
          };
        return { text: 'Parent completed.' };
      }
      // Deterministic provider routing only, never request correlation authority.
      if (JSON.stringify(body.messages).includes('Do not include the <template> tags'))
        return { text: '## Objective\n- Exercise a native fixture compaction checkpoint.' };
      if (JSON.stringify(body.messages).includes(captureText)) {
        captureRequests++;
        if (captureRequests === 1) return capture.promise;
        return { text: payload };
      }
      return review.promise;
    },
  });
  return {
    ...probe,
    get client() {
      return probe.client;
    },
    reviewText,
    captureText,
    payload,
    sentinel,
    async start() {
      const parent = await probe.session();
      parentID = parent.id;
      return parent;
    },
    releaseReview: () => review.release({ text: 'Fixture reviewer completed its analysis.' }),
    releaseCapture: () =>
      capture.release(
        mode === 'tool'
          ? { tool: { name: 'read', arguments: { path: join(project, 'transport-sentinel.txt') } } }
          : { text: payload },
      ),
    captureRequests: () => captureRequests,
    observations: () => probe.entries<TransportObservation>(),
    async close() {
      review.release({ text: 'Fixture teardown.' });
      capture.release({ text: 'Fixture teardown.' });
      await probe.close();
    },
  };
}
