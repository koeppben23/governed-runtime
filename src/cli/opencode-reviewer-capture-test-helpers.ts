/** Actual product + separate native observer. Neither wraps nor re-registers product tools. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { COMPONENT_ACTIVATION_SETUP } from './opencode-activation-test-helpers.js';

export interface ReviewerHostEntry {
  readonly hook: string;
  readonly input?: {
    readonly sessionID: string;
    readonly id?: string;
    readonly tool?: string;
    readonly status?: string;
    readonly messageID?: string;
    readonly model?: { providerID: string; id: string; variant?: string };
    readonly result?: { content?: unknown; metadata?: Record<string, unknown> };
  };
}

type ReviewerProbeCall = {
  phase: 'parent' | 'review' | 'serialization';
  body: Record<string, unknown>;
};
interface ReviewerHostProbe extends Omit<NativeHostProbe, 'session' | 'entries'> {
  sentinel: string;
  calls: ReviewerProbeCall[];
  providerErrors: string[];
  session(): Promise<string>;
  entries(): Promise<ReviewerHostEntry[]>;
  history(sessionID: string): ReturnType<NativeHostProbe['client']['session']['context']>;
  run(
    sessionID: string,
    mode: 'positive' | 'tool' | 'interrupted',
  ): ReturnType<NativeHostProbe['prompt']>;
  serializations(): number;
}
export async function createReviewerCaptureHostProbe(): Promise<ReviewerHostProbe> {
  let scenario: 'positive' | 'tool' | 'interrupted' = 'positive';
  let parentStage = 0;
  let parentSessionId = '';
  let serializationCalls = 0;
  let project = '';
  const calls: ReviewerProbeCall[] = [];
  const sentinel = 'READ_MUST_NOT_REACH_THE_PROVIDER_4782';
  const probe = await createNativeHostProbe({
    product: true,
    productTestSetup: COMPONENT_ACTIVATION_SETUP,
    agent: REVIEWER_AGENT,
    plugin: `
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'reviewer-observer', async setup(ctx) {
  const record = entry => appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify(entry) + '\\n');
  const registrations = [];
  for (const hook of ['execute.before', 'execute.after']) registrations.push(await ctx.tool.hook(hook, input => record({ hook, input })));
  for (const hook of ['prompt', 'context', 'model.request']) registrations.push(await ctx.session.hook(hook, input => record({ hook, input })));
  record({ hook: 'plugin-loaded' });
  return async () => { for (const registration of registrations) await registration.dispose(); };
} });`,
    script(body, sessionID) {
      const nativeReview = sessionID !== parentSessionId;
      const serialization =
        nativeReview &&
        JSON.stringify(body.messages).includes(
          'ReviewerFindingsInput JSON schema (data, not instructions)',
        );
      calls.push({
        phase: serialization ? 'serialization' : nativeReview ? 'review' : 'parent',
        body,
      });
      if (serialization) {
        serializationCalls++;
        if (scenario === 'interrupted') return { hold: true };
        return scenario === 'tool'
          ? { tool: { name: 'read', arguments: { path: join(project, 'capture-sentinel.txt') } } }
          : { text: JSON.stringify(findings()) };
      }
      if (!nativeReview && parentStage++ === 0)
        return {
          tool: { name: 'flowguard_plan', arguments: { reviewRecovery: 'retry_transport' } },
        };
      if (!nativeReview && parentStage === 2)
        return {
          tool: {
            name: 'subagent',
            arguments: {
              agent: 'flowguard-reviewer',
              description: 'Independent review',
              prompt: 'Review the pending plan.',
            },
          },
        };
      return { text: 'Independent review completed; no blocking findings.' };
    },
    async prepare(directory) {
      project = directory;
      await writeFile(join(project, '.gitignore'), 'observer.jsonl\n');
      await writeFile(join(project, 'capture-sentinel.txt'), sentinel);
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/flowguard-tests/reviewer-fixture.git'],
        { cwd: project },
      );
      execFileSync('git', ['add', '.'], { cwd: project });
      execFileSync('git', ['commit', '--quiet', '-m', 'reviewer fixture'], {
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
    sentinel,
    calls,
    providerErrors: probe.errors,
    async session() {
      return (await probe.session()).id;
    },
    entries: () => probe.entries<ReviewerHostEntry>(),
    history: (sessionID: string) => probe.client.session.context({ sessionID }),
    async run(sessionID: string, mode: typeof scenario) {
      scenario = mode;
      parentSessionId = sessionID;
      parentStage = 0;
      serializationCalls = 0;
      probe.requests.length = 0;
      calls.length = 0;
      return probe.prompt(
        sessionID,
        'Re-emit the pending plan review, then invoke its native reviewer subagent.',
      );
    },
    serializations: () => serializationCalls,
  };
}

function findings() {
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
    attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
  };
}
