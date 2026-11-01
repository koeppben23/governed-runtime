/** Raw V2 tool hooks/events, plus the actual product plugin for recovery acceptance. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodeEvent } from '@opencode/client';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';

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
