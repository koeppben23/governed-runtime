/** Raw V2 tool hooks/events, plus the actual product plugin for recovery acceptance. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodeEvent } from '@opencode/client';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { COMPONENT_ACTIVATION_SETUP } from './opencode-activation-test-helpers.js';

export interface ProbeCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}
export interface ProbeEntry {
  readonly hook: string;
  readonly input?: {
    tool: string;
    id: string;
    sessionID: string;
    status?: string;
    error?: unknown;
  };
  readonly event?: OpenCodeEvent;
}

interface MutationHostProbe extends Omit<NativeHostProbe, 'session' | 'prompt' | 'entries'> {
  session(): Promise<string>;
  prompt(sessionID: string, calls: ProbeCall[]): ReturnType<NativeHostProbe['prompt']>;
  entries(): Promise<ProbeEntry[]>;
  history(sessionID: string): ReturnType<NativeHostProbe['client']['session']['context']>;
}
export async function createMutationHostProbe(flowGuard = false): Promise<MutationHostProbe> {
  let pending: ProbeCall[] = [];
  const probe = await createNativeHostProbe({
    product: flowGuard,
    plugin: `
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'mutation-probe', async setup(ctx) {
  const record = entry => appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify(entry) + '\\n');
  const registrations = [];
  registrations.push(await ctx.tool.transform(editor => editor.add({ name: 'probe_wait', description: 'Wait for host cancellation', options: { codemode: false }, input: { type: 'object', properties: {} },
    async execute(input, context) { return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('Probe cancelled'));
      if (context.signal.aborted) fail(); else context.signal.addEventListener('abort', fail, { once: true });
    }); }
  })));
  for (const hook of ['execute.before', 'execute.after']) registrations.push(await ctx.tool.hook(hook, input => record({ hook, input })));
  const controller = new AbortController();
  const observing = (async () => { try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type.startsWith('session.')) record({ hook: 'event', event });
    }
  } catch (error) { if (!controller.signal.aborted) throw error; } })();
  return async () => { controller.abort(); await observing; for (const registration of registrations) await registration.dispose(); };
} });`,
    script: () => {
      const call = pending.shift();
      return call
        ? { tool: { name: call.name, arguments: call.args } }
        : { text: 'Probe finished.' };
    },
    async prepare(project) {
      if (flowGuard) {
        // Component admission only: not an installed StartGovernance positive.
        // Controlled callback loss exercises the real synchronous recovery after
        // reload without fabricating host history or mutation completion.
        await writeFile(
          join(project, '.opencode/plugins/flowguard/index.ts'),
          `
import { Plugin } from '@opencode/plugin';
import { existsSync, appendFileSync } from 'node:fs';
import Product from ${JSON.stringify(new URL('../../dist/integration/plugin.js', import.meta.url).href)};
export default Plugin.define({ id: Product.id, async setup(ctx) {
  const drop = () => existsSync(ctx.location.directory + '/.fixture-drop-mutation-completion');
  const record = entry => appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify(entry) + '\\n');
  const fixtureCleanup = await (async () => { ${COMPONENT_ACTIVATION_SETUP} })();
  const cleanup = await Product.setup({ ...ctx,
    tool: { ...ctx.tool, hook: (name, callback) => ctx.tool.hook(name, async event => {
      if (name === 'execute.after' && event.tool === 'edit' && drop()) {
        record({ hook: 'component.dropped-after', input: event }); return;
      }
      return callback(event);
    }) },
    event: { ...ctx.event, subscribe: options => (async function* () {
      for await (const event of ctx.event.subscribe(options)) {
        if (event.type === 'session.tool.failed' && drop()) {
          record({ hook: 'component.dropped-event', event }); continue;
        }
        yield event;
      }
    })() },
  });
  return async () => { try { await cleanup?.(); } finally { await fixtureCleanup(); } };
} });\n`,
        );
      }
      await writeFile(join(project, 'edit-target.txt'), 'original\n');
      execFileSync('git', ['add', '.'], { cwd: project });
      execFileSync('git', ['commit', '--quiet', '-m', 'test fixture'], {
        cwd: project,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'FlowGuard Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'FlowGuard Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
      });
    },
  });
  return {
    ...probe,
    async session() {
      return (await probe.session()).id;
    },
    async prompt(sessionID: string, calls: ProbeCall[]) {
      pending = [...calls];
      return probe.prompt(sessionID);
    },
    entries: () => probe.entries<ProbeEntry>(),
    history: (sessionID: string) => probe.client.session.context({ sessionID }),
  };
}
