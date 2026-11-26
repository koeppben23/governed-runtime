/** Real native review return with multiple location plugin instances. No seeded review evidence.
 * The local wire provider is deterministic; this is not real-provider certification. */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitNativePlugins,
  createNativeHostProbe,
  type NativeHostProbe,
  type NativeProbeReply,
} from './opencode-native-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { REVIEWER_AGENT } from '../templates/mandates.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const incidentCLI = process.env.FLOWGUARD_OPENCODE_INCIDENT_CLI;
let probe: NativeHostProbe | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    probe = undefined;
    restore = undefined;
  }
});
async function workflow(host: NativeHostProbe, sessionId: string) {
  const bound = await resolveSessionAuthority({ root: await realpath(host.project), sessionId });
  if (bound.status !== 'resolved') throw new Error(JSON.stringify(bound));
  return bound;
}

describe.skipIf(!LIVE)('native reviewer completion event ownership', () => {
  it.each(['none', 'immediate', 'restart'] as const)(
    'returns changes_requested across four location instances (capture retry: %s)',
    async (retryMode) => {
      const retryCapture = retryMode !== 'none';
      let restarted = false;
      let rootID = '';
      let stage = 0;
      let captures = 0;
      const host = await createNativeHostProbe({
        ...(incidentCLI
          ? { host: { command: incidentCLI, argsPrefix: [], version: 'opencode v2.2.7', env: {} } }
          : {}),
        product: true,
        agent: REVIEWER_AGENT,
        productTestSetup: `
        const { appendFileSync } = await import('node:fs');
        appendFileSync(process.env.FLOWGUARD_TEST_OBSERVER_FILE, JSON.stringify({ type: 'product-instance', directory: ctx.location.directory }) + '\\n');
      `,
        flowguardConfig: JSON.stringify({ schemaVersion: 'v1', policy: { defaultMode: 'team' } }),
        async prepare(project, env) {
          env.FLOWGUARD_TEST_OBSERVER_FILE = join(project, 'observer.jsonl');
          const configPath = join(project, 'opencode.json');
          const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
          await writeFile(
            configPath,
            JSON.stringify({ ...config, plugins: [join(project, '.opencode/plugins/flowguard')] }),
          );
          await writeFile(join(project, '.gitignore'), 'observer.jsonl\n');
          await writeFile(join(project, 'README.md'), '# Reviewer lifecycle fixture\n');
          await writeFile(
            join(project, 'package.json'),
            JSON.stringify({
              name: 'reviewer-lifecycle',
              version: '1.0.0',
              scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
            }),
          );
          execFileSync('git', ['add', '.'], { cwd: project });
          execFileSync(
            'git',
            [
              '-c',
              'user.name=Review Test',
              '-c',
              'user.email=review@example.test',
              'commit',
              '--quiet',
              '-m',
              'Review fixture',
            ],
            { cwd: project },
          );
        },
        async script(body, sessionID) {
          if (sessionID !== rootID) {
            if (
              JSON.stringify(body.messages).includes(
                'ReviewerFindingsInput JSON schema (data, not instructions)',
              )
            ) {
              const obligation = (
                await workflow(host, rootID)
              ).state.reviewAssurance!.obligations.at(-1)!;
              return {
                text: JSON.stringify({
                  iteration: obligation.iteration,
                  planVersion: obligation.planVersion,
                  reviewMode: 'subagent',
                  overallVerdict: 'changes_requested',
                  blockingIssues: [],
                  majorRisks:
                    retryCapture && captures++ === 0
                      ? [
                          {
                            severity: 'minor',
                            category: 'quality',
                            message: 'Unobserved repository citation.',
                            relation: {
                              subjectAnchors: [
                                {
                                  kind: 'artifact_section',
                                  artifactKind: 'plan',
                                  artifactDigest: obligation.subjectDigest,
                                  sectionPath: [
                                    { headingDepth: 2, siblingIndex: 1, headingText: 'Scope' },
                                  ],
                                },
                              ],
                              evidenceLocations: [{ path: 'README.md', revision: 'head', line: 1 }],
                            },
                          },
                        ]
                      : [],
                  missingVerification: [],
                  scopeCreep: [],
                  unknowns: [],
                  challenges: [],
                  attestation: { toolObligationId: obligation.obligationId },
                }),
              };
            }
            return {
              text: 'Independent review completed. Request a clearer final documentation verification step.',
            };
          }
          const steps: NativeProbeReply[] = [
            {
              tool: {
                name: 'flowguard_ticket',
                arguments: {
                  text: 'Clarify README usage documentation without changing program behavior.',
                  source: 'user',
                },
              },
            },
            {
              tool: {
                name: 'flowguard_plan',
                arguments: {
                  planText:
                    '# README plan\n\n## Scope\nUpdate README.md usage documentation only.\n\n## Steps\nRead README.md, clarify usage, preserve runtime behavior.\n\n## Verification\nRun npm test and npm run lint; inspect the final README diff.\n\n## Risks\nDocumentation only.\n\n## Rollback\nRevert the README change.',
                  targetPaths: ['README.md'],
                },
              },
            },
            {
              tool: {
                name: 'subagent',
                arguments: {
                  agent: 'flowguard-reviewer',
                  description: 'Independent plan review',
                  prompt: 'Review the pending plan independently.',
                },
              },
            },
          ];
          if (retryMode === 'restart') {
            if (stage === 3 && !restarted)
              return { text: 'Fresh review attempt is pending; awaiting restart recovery.' };
            steps.push({
              tool: { name: 'flowguard_plan', arguments: { reviewRecovery: 'retry_transport' } },
            });
          }
          if (retryCapture) steps.push(steps[2]!);
          return (
            steps[stage++] ?? {
              text: 'The independent reviewer requested changes. Awaiting a revised plan.',
            }
          );
        },
      });
      probe = host;
      restore = withTestEnv({ OPENCODE_CONFIG_DIR: host.env.OPENCODE_CONFIG_DIR! });
      for (let index = 0; index < 3; index++) {
        const directory = join(host.root, `other-location-${index}`);
        await mkdir(directory);
        await writeFile(
          join(directory, 'opencode.json'),
          JSON.stringify({ plugins: [join(host.project, '.opencode/plugins/flowguard')] }),
        );
        await host.client.agent.list({ location: { directory } });
        await awaitNativePlugins(host.client, { directory }, (plugins) =>
          plugins.some((plugin) => plugin.id === 'flowguard'),
        );
        expect((await host.client.plugin.list({ location: { directory } })).data).toContainEqual(
          expect.objectContaining({
            id: 'flowguard',
            state: expect.objectContaining({ status: 'active' }),
          }),
        );
      }
      expect(
        new Set(
          (await host.entries<{ type: string; directory: string }>())
            .filter((e) => e.type === 'product-instance')
            .map((e) => e.directory),
        ).size,
      ).toBe(4);
      const root = await host.session();
      rootID = root.id;
      await host.client.session.command({ sessionID: root.id, name: 'start', text: '' });
      await host
        .prompt(
          root.id,
          'Prepare the documentation plan and obtain the independent review. Do not approve or implement.',
        )
        .catch((error) => {
          throw new Error(String(error) + '\n' + host.output());
        });
      if (retryMode === 'restart') {
        const pending = (await workflow(host, root.id)).state.reviewAssurance!;
        expect(pending.invocations).toEqual([]);
        expect(pending.attempts.map((item) => item.status)).toEqual(['stale', 'created']);
        await host.restart('SIGKILL');
        restarted = true;
        await host.prompt(
          root.id,
          'Resume the existing pending plan review through its canonical transport recovery.',
        );
      }
      const state = (await workflow(host, root.id)).state;
      expect(state.reviewAssurance!.invocations).toHaveLength(1);
      expect(state.reviewAssurance!.invocations[0]).toMatchObject({
        source: 'host-orchestrated',
        capturedVerdict: 'changes_requested',
      });
      expect(state.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
      expect(state.reviewAssurance!.attempts).toHaveLength(retryCapture ? 2 : 1);
      if (retryCapture) {
        expect(state.reviewAssurance!.attempts[0]!.status).toBe('stale');
        expect(state.reviewAssurance!.attempts[1]!.status).toBe('bound');
        expect(state.reviewAssurance!.dispatches.map((item) => item.dispatchStatus)).toEqual([
          'outcome_unknown',
          'completed',
        ]);
        expect(state.reviewAssurance!.attempts[0]!.childSessionId).not.toBe(
          state.reviewAssurance!.attempts[1]!.childSessionId,
        );
      }
      expect(
        (
          await host.client.session.get({
            sessionID: state.reviewAssurance!.invocations[0]!.childSessionId,
          })
        ).outcome,
      ).toBe('succeeded');
      expect((await host.client.session.get({ sessionID: root.id })).outcome, host.output()).toBe(
        'succeeded',
      );
      await host
        .prompt(root.id, 'Acknowledge the requested changes without tools.')
        .catch((error) => {
          throw new Error(String(error) + '\n' + host.output());
        });
      expect((await host.client.session.get({ sessionID: root.id })).outcome, host.output()).toBe(
        'succeeded',
      );
      const continued = (await workflow(host, root.id)).state;
      expect(continued.phase).toBe('PLAN');
      expect(continued.pendingSystemWork).toBeNull();
      expect(continued.reviewAssurance).toEqual(state.reviewAssurance);
      expect(host.output()).not.toContain('V2 event stream unavailable');
      expect(host.errors).toEqual([]);
    },
    180_000,
  );
});
