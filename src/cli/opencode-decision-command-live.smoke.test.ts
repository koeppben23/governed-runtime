/** Actual pinned native command/model boundaries. Core review gates are explicit fixtures,
 * not proof of native reviewer execution, installed acceptance, or human provenance. */
import { afterEach, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { prepareComponentDecisionGate } from '../integration/component-decision-test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { readConfig } from '../adapters/persistence-config.js';
import { resolveHydratePolicy } from '../integration/tools/index.js';
import { freezePolicySnapshot } from '../config/policy-snapshot.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
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
async function open(
  mode: 'team' | 'solo' = 'team',
  modelDecision = false,
  minimumActorAssuranceForApproval = 'best_effort',
) {
  const emitted = new Set<string>();
  const p = await createNativeHostProbe({
    product: true,
    flowguardConfig: JSON.stringify({
      schemaVersion: 'v1',
      governance: { autonomousActivation: { enabled: true, minimumActorAssurance: 'best_effort' } },
      policy: { defaultMode: mode, minimumActorAssuranceForApproval },
    }),
    script: (_body, sessionID) => {
      if (modelDecision && !emitted.has(sessionID)) {
        emitted.add(sessionID);
        return {
          tool: {
            name: 'flowguard_decision',
            arguments: { verdict: 'approve', rationale: 'Explicit autonomous decision.' },
          },
        };
      }
      return { text: 'Done.' };
    },
  });
  probe = p;
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: p.env.OPENCODE_CONFIG_DIR! });
  await p.client.command.list({ location: p.location });
  return p;
}
async function workflow(p: NativeHostProbe, sessionID: string) {
  const value = await resolveSessionAuthority({
    root: await realpath(p.project),
    sessionId: sessionID,
  });
  if (value.status !== 'resolved') throw new Error(`Expected workflow: ${JSON.stringify(value)}`);
  return value;
}
async function activate(p: NativeHostProbe, sessionID: string, autonomous = false) {
  if (!autonomous) await p.client.session.command({ sessionID, name: 'start', text: '' });
  else {
    const worktreeRoot = await realpath(p.project);
    const policy = await resolveHydratePolicy(null, await readConfig(worktreeRoot), {});
    const policyDigest = freezePolicySnapshot(
      policy.policyResolution,
      new Date().toISOString(),
      hashText,
    ).hash;
    const result = await p.client.rpc.call({
      location: p.location,
      rpcID: 'flowguard-governance',
      method: 'StartGovernance',
      input: { sessionID, worktreeRoot, policyDigest },
    });
    expect(result.output).toMatchObject({ kind: 'activated' });
  }
}
async function receipts(p: NativeHostProbe, sessionID: string) {
  return (await readAuditTrail((await workflow(p, sessionID)).sessDir)).filter(
    (event) => event.detail.kind === 'decision',
  );
}
describe.skipIf(!LIVE)('native decision commands with component core review gates', () => {
  it.each(['approve', 'override-approve'] as const)(
    'drives real Start, ticket, independent native review and %s without seeded gate evidence',
    async (command) => {
      let rootID = '';
      let stage = 0;
      const p = await createNativeHostProbe({
        product: true,
        agent: REVIEWER_AGENT,
        flowguardConfig: JSON.stringify({
          schemaVersion: 'v1',
          policy: { defaultMode: 'team', reviewBudget: { plan: 1 } },
        }),
        prepare: async (project) => {
          await writeFile(project + '/README.md', '# Decision pipeline fixture\n');
          await writeFile(
            project + '/package.json',
            JSON.stringify({
              name: 'decision-pipeline',
              version: '1.0.0',
              scripts: {
                test: 'node -e "console.log(\'OK\')"',
                lint: 'node -e "console.log(\'OK\')"',
              },
            }),
          );
          execFileSync('git', ['add', '.'], { cwd: project });
          execFileSync(
            'git',
            [
              '-c',
              'user.name=Decision Test',
              '-c',
              'user.email=decision@example.test',
              'commit',
              '--quiet',
              '-m',
              'Native decision fixture',
            ],
            { cwd: project },
          );
        },
        script: async (body, sessionID) => {
          if (sessionID !== rootID) {
            if (
              JSON.stringify(body.messages).includes(
                'ReviewerFindingsInput JSON schema (data, not instructions)',
              )
            ) {
              const obligation = (await workflow(p, rootID)).state.reviewAssurance!.obligations.at(
                -1,
              )!;
              return {
                text: JSON.stringify({
                  iteration: obligation.iteration,
                  planVersion: obligation.planVersion,
                  reviewMode: 'subagent',
                  overallVerdict: command === 'approve' ? 'accept' : 'changes_requested',
                  blockingIssues: [],
                  majorRisks: [],
                  missingVerification: [],
                  scopeCreep: [],
                  unknowns: [],
                  challenges: [],
                  attestation: { toolObligationId: obligation.obligationId },
                }),
              };
            }
            return { text: 'Independent review completed. No blocking findings.' };
          }
          const steps = [
            {
              tool: {
                name: 'flowguard_ticket',
                arguments: {
                  text: 'Improve the existing README usage documentation. Preserve all program behavior.',
                  source: 'user',
                },
              },
            },
            {
              tool: {
                name: 'flowguard_plan',
                arguments: {
                  planText:
                    '# README documentation plan\n\n## Scope\nUpdate README.md usage instructions only.\n\n## Steps\nRead the existing README, clarify the documented usage, and retain all runtime behavior.\n\n## Verification\nRun npm test and npm run lint. Inspect the README diff for factual correctness.\n\n## Risks\nDocumentation-only change; no executable code or API changes.\n\n## Rollback\nRevert the README edit if verification fails.',
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
            {
              tool: {
                name: 'flowguard_plan',
                arguments:
                  command === 'approve'
                    ? { reviewVerdict: 'accept' }
                    : {
                        reviewVerdict: 'changes_requested',
                        planText:
                          '# Revised README plan\n\nAdd an explicit final diff check and retain runtime behavior. Run npm test and npm run lint before recording completion.',
                        claims: [],
                      },
              },
            },
          ];
          return steps[stage++] ?? { text: 'Awaiting the explicit approval command.' };
        },
      });
      probe = p;
      restore = withTestEnv({ OPENCODE_CONFIG_DIR: p.env.OPENCODE_CONFIG_DIR! });
      await p.client.command.list({ location: p.location });
      const root = await p.session();
      rootID = root.id;
      await activate(p, root.id);
      await p.prompt(
        root.id,
        'Prepare and independently review the documentation plan. Do not approve the human gate.',
      );
      const reviewed = await workflow(p, root.id);
      expect(
        reviewed.state.phase,
        JSON.stringify(await p.client.session.context({ sessionID: root.id })),
      ).toBe('PLAN_REVIEW');
      expect(reviewed.state.reviewAssurance!.invocations).toHaveLength(1);
      const invocation = reviewed.state.reviewAssurance!.invocations[0]!;
      expect(invocation.source).toBe('host-orchestrated');
      expect(invocation.capturedVerdict).toBe(
        command === 'approve' ? 'accept' : 'changes_requested',
      );
      if (command === 'override-approve') {
        expect(reviewed.state.plan!.reviewCompletion).toBe('review_exhausted');
        await expect(
          p.client.session.command({
            sessionID: root.id,
            name: 'approve',
            text: 'Must not silently override.',
          }),
        ).rejects.toThrow();
      }
      const requestsBeforeApproval = p.requests.length;
      await p.client.session.command({
        sessionID: root.id,
        name: command,
        text: 'Accept the independently reviewed README plan with the stated residual documentation risk.',
      });
      expect(p.requests).toHaveLength(requestsBeforeApproval);
      expect(await receipts(p, root.id)).toMatchObject([
        {
          detail: {
            verdict: command === 'approve' ? 'approve' : 'approve_with_governance_override',
            operation: { source: 'host_command' },
          },
        },
      ]);
      expect((await workflow(p, root.id)).state.plan?.approvalCertificate).toBeDefined();
    },
    300_000,
  );
  it('approves without a model turn, audits the actual source and keeps one receipt across repeat and SIGKILL/reload', async () => {
    const p = await open();
    const root = await p.session();
    await activate(p, root.id);
    await prepareComponentDecisionGate(await workflow(p, root.id));
    await p.client.session.command({
      sessionID: root.id,
      name: 'approve',
      text: 'Reviewed current ADR.',
    });
    expect(p.requests).toEqual([]);
    expect((await workflow(p, root.id)).state.phase).toBe('ARCH_COMPLETE');
    const events = await receipts(p, root.id);
    expect(events).toMatchObject([
      {
        detail: {
          verdict: 'approve',
          rationale: 'Reviewed current ADR.',
          operation: {
            source: 'host_command',
            sessionId: root.id,
            rootSessionId: root.id,
            generation: 1,
            operationId: expect.any(String),
            stateDigest: expect.any(String),
          },
        },
      },
    ]);
    await expect(
      p.client.session.command({
        sessionID: root.id,
        name: 'approve',
        text: 'Reviewed current ADR.',
      }),
    ).rejects.toThrow();
    await p.restart('SIGKILL');
    await p.client.command.list({ location: p.location });
    await expect(
      p.client.session.command({
        sessionID: root.id,
        name: 'approve',
        text: 'Reviewed current ADR.',
      }),
    ).rejects.toThrow();
    expect(await receipts(p, root.id)).toEqual(events);
    expect(verifyChain(await readAuditTrail((await workflow(p, root.id)).sessDir)).valid).toBe(
      true,
    );
  }, 300_000);
  it('requires OverrideApprove and a non-empty rationale at an exhausted gate', async () => {
    const p = await open();
    const root = await p.session();
    await activate(p, root.id);
    await prepareComponentDecisionGate(await workflow(p, root.id), true);
    await expect(
      p.client.session.command({ sessionID: root.id, name: 'approve', text: 'Wrong operation' }),
    ).rejects.toThrow();
    await expect(
      p.client.session.command({ sessionID: root.id, name: 'override-approve', text: '  ' }),
    ).rejects.toThrow();
    expect(await receipts(p, root.id)).toHaveLength(0);
    await p.client.session.command({
      sessionID: root.id,
      name: 'override-approve',
      text: 'Documented governance override.',
    });
    expect((await workflow(p, root.id)).state.phase).toBe('ARCH_COMPLETE');
    expect(await receipts(p, root.id)).toMatchObject([
      {
        detail: {
          verdict: 'approve_with_governance_override',
          rationale: 'Documented governance override.',
          operation: { source: 'host_command' },
        },
      },
    ]);
  }, 300_000);
  it.each(['team', 'solo'] as const)(
    'autonomous activation supplies no implicit approval; the frozen %s policy decides',
    async (mode) => {
      const p = await open(mode, true);
      const root = await p.session();
      await activate(p, root.id, true);
      await prepareComponentDecisionGate(await workflow(p, root.id));
      await p.prompt(root.id, 'Attempt the explicit autonomous decision.');
      expect((await workflow(p, root.id)).state.phase).toBe(
        mode === 'team' ? 'ARCH_REVIEW' : 'ARCH_COMPLETE',
      );
      const events = await receipts(p, root.id);
      if (mode === 'team') expect(events).toHaveLength(0);
      else expect(events).toMatchObject([{ detail: { operation: { source: 'autonomous' } } }]);
    },
    300_000,
  );
  it('does not reuse activation permission to bypass the approval actor-assurance minimum', async () => {
    const p = await open('team', false, 'idp_verified');
    const root = await p.session();
    await activate(p, root.id, true);
    await prepareComponentDecisionGate(await workflow(p, root.id));
    await expect(
      p.client.session.command({ sessionID: root.id, name: 'approve', text: 'Weak actor' }),
    ).rejects.toThrow();
    expect((await workflow(p, root.id)).state.phase).toBe('ARCH_REVIEW');
    expect(await receipts(p, root.id)).toHaveLength(0);
  }, 300_000);
});
