/** Native result-boundary instrumentation, NOT production attestation or a fix.
 * The mutation cases deliberately install trusted test hooks after the product;
 * they do not demonstrate an unprivileged caller can install those hooks. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';

export type ResultProbeMode = 'observe' | 'after-mutation' | 'truncate' | 'context-mutation';
export const RESULT_SENTINEL = 'R4_POST_PRODUCT_REPLACED_TOOL_RESULT';
export const LONG_RESULT_END = 'R4_LONG_OUTPUT_END_MUST_NOT_REACH_MODEL';

export interface ResultBoundaryObservation {
  readonly hook: string;
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly result?: { readonly content?: unknown; readonly metadata?: Record<string, unknown> };
  readonly messages?: unknown;
  readonly history?: unknown;
  readonly data?: Record<string, unknown>;
}

function setup(mode: ResultProbeMode): string {
  return `
const { appendFileSync } = await import('node:fs');
const record = value => appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify(value) + '\\n');
const registrations = [];
const reviewer = event => event.agent === 'flowguard-reviewer';
registrations.push(await ctx.tool.hook('execute.after', event => {
  if (!reviewer(event) || event.tool !== 'read' || event.status !== 'completed') return;
  record({ hook: 'r4.after.original', sessionID: event.sessionID, messageID: event.messageID, id: event.id, result: event.result });
  if (${JSON.stringify(mode)} === 'after-mutation') event.result.content = ${JSON.stringify(RESULT_SENTINEL)};
  if (${JSON.stringify(mode)} === 'truncate') {
    // Explicit fixture mutation: exercise the host's real post-hook normalizer
    // and generic truncation, not the read tool's own pagination.
    event.result.content = [
      { type: 'text', text: Array.from({ length: 3000 }, (_, i) => 'r4-line-' + i + '-' + 'x'.repeat(35)).join('\\n') },
      { type: 'text', text: ${JSON.stringify(LONG_RESULT_END)} },
    ];
    event.result.metadata = { ...event.result.metadata };
    delete event.result.metadata.truncated;
  }
  record({ hook: 'r4.after.released', sessionID: event.sessionID, messageID: event.messageID, id: event.id, result: event.result });
}));
registrations.push(await ctx.session.hook('context', async event => {
  if (!reviewer(event)) return;
  record({ hook: 'r4.context.original', sessionID: event.sessionID, messages: event.messages,
    history: await ctx.session.context({ sessionID: event.sessionID }) });
  if (${JSON.stringify(mode)} === 'context-mutation') {
    for (const message of event.messages) for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      part.result = { type: 'text', value: ${JSON.stringify(RESULT_SENTINEL)} };
    }
  }
  record({ hook: 'r4.context.released', sessionID: event.sessionID, messages: event.messages });
}));
registrations.push(await ctx.session.hook('model.request', async event => {
  if (!reviewer(event) || event.kind !== 'primary') return;
  record({ hook: 'r4.model', sessionID: event.sessionID, history: await ctx.session.context({ sessionID: event.sessionID }) });
}));
registrations.push(await ctx.session.hook('http.request', async event => {
  if (!reviewer(event) || event.kind !== 'primary') return;
  record({ hook: 'r4.http', sessionID: event.sessionID, data: { body: await event.request.clone().json() } });
}));
const controller = new AbortController();
const events = (async () => {
  try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === 'session.tool.success')
        record({ hook: 'r4.success', sessionID: event.data.sessionID, messageID: event.data.assistantMessageID,
          id: event.data.id, data: event.data });
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
})();
return async () => { controller.abort(); await events; for (const r of registrations) await r.dispose(); };
`;
}

export type ToolResultProbe = Awaited<ReturnType<typeof createReviewerCaptureHostProbe>> & {
  resultObservations(): Promise<ResultBoundaryObservation[]>;
};

export async function createToolResultProbe(mode: ResultProbeMode): Promise<ToolResultProbe> {
  const probe = await createReviewerCaptureHostProbe({
    initialRead: true,
    postProductSetup: setup(mode),
  });
  return {
    ...probe,
    async resultObservations(): Promise<ResultBoundaryObservation[]> {
      const source = await readFile(join(probe.project, 'observer.jsonl'), 'utf8');
      return source
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ResultBoundaryObservation)
        .filter((entry) => entry.hook.startsWith('r4.'));
    },
  };
}
