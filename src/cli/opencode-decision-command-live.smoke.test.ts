/** Actual pinned native command/model boundaries. Core review gates are explicit fixtures,
 * not proof of native reviewer execution, installed acceptance, or human provenance. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, realpath, writeFile } from 'node:fs/promises';
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
import {
  FlowGuardGovernance,
  type PresentationResult,
} from '../integration/opencode-governance-rpc.js';

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
  it('runs /check through the native command prompt', async () => {
    const p = await open('solo');
    const root = await p.session();
    await activate(p, root.id);
    const before = p.requests.length;
    await p.client.session.command({ sessionID: root.id, name: 'check', text: '' });
    expect(p.requests.length).toBeGreaterThan(before);
    expect(
      p.requests
        .slice(before)
        .some((request) => JSON.stringify(request.body).includes('flowguard_run_check')),
    ).toBe(true);
  }, 300_000);
  it.each(['approve', 'override-approve'] as const)(
    'drives real Start, ticket, independent native review and %s without seeded gate evidence',
    async (command) => {
      let rootID = '';
      let stage = 0;
      let mutationRequested = false;
      let implementationStep: number | null = null;
      let exportRequested = false;
      const p = await createNativeHostProbe({
        ...(incidentCLI
          ? { host: { command: incidentCLI, argsPrefix: [], version: 'opencode v2.2.7', env: {} } }
          : {}),
        product: true,
        agent: REVIEWER_AGENT,
        flowguardConfig: JSON.stringify({
          schemaVersion: 'v1',
          policy: { defaultMode: 'team', reviewBudget: { plan: 1 } },
        }),
        prepare: async (project) => {
          // Native patch is offered only to supported GPT-family models. The
          // deterministic local wire provider still owns every fixture reply.
          const configPath = project + '/opencode.json';
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          config.model = 'capture/gpt-5-probe';
          config.providers.capture.models['gpt-5-probe'] = config.providers.capture.models.probe;
          delete config.providers.capture.models.probe;
          await writeFile(configPath, JSON.stringify(config));
          await writeFile(project + '/README.md', '# Decision pipeline fixture\n');
          await writeFile(
            project + '/package.json',
            JSON.stringify({
              name: 'decision-pipeline',
              version: '1.0.0',
              scripts: {
                test: 'node -e "setTimeout(() => console.log(\'OK\'), 1000)"',
                lint: 'node -e "console.log(\'OK\')"',
                typecheck: 'node -e "console.log(\'OK\')"',
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
                  overallVerdict:
                    obligation.obligationType === 'implement' || command === 'approve'
                      ? 'accept'
                      : 'changes_requested',
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
          if (mutationRequested) {
            mutationRequested = false;
            return {
              tool: {
                name: 'patch',
                arguments: {
                  patchText:
                    '*** Begin Patch\n*** Update File: README.md\n@@\n-# Decision pipeline fixture\n+# Verified native patch fixture\n*** End Patch',
                },
              },
            };
          }
          if (implementationStep !== null) {
            const steps = [
              { tool: { name: 'flowguard_implement', arguments: {} } },
              {
                tool: {
                  name: 'subagent',
                  arguments: {
                    agent: 'flowguard-reviewer',
                    description: 'Independent implementation review',
                    prompt: 'Review the recorded implementation independently.',
                  },
                },
              },
              {
                tool: {
                  name: 'flowguard_review_implementation',
                  arguments: { reviewVerdict: 'accept' },
                },
              },
            ];
            const next = steps[implementationStep++];
            if (next) return next;
            implementationStep = null;
          }
          if (exportRequested) {
            exportRequested = false;
            return { tool: { name: 'flowguard_export', arguments: {} } };
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
      const root = await p.client.session.create({
        title: 'Native GPT patch pipeline fixture',
        location: p.location,
        agent: 'build',
        model: { providerID: 'capture', id: 'gpt-5-probe', variant: 'chosen' },
      });
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
      const snapshots: PresentationResult[] = [];
      const reads: Promise<void>[] = [];
      const rpc = p.client.rpc(FlowGuardGovernance);
      const unsubscribe = rpc.events.on('PresentationUpdated', (event) => {
        if (event.data.sessionID !== root.id) return;
        const reading = rpc
          .GetPresentation({ sessionID: root.id }, { location: p.location })
          .then((page) => {
            snapshots.push(page);
          });
        reads.push(reading);
        return reading;
      });
      try {
        await p.client.session.command({
          sessionID: root.id,
          name: command,
          text: 'Accept the independently reviewed README plan with the stated residual documentation risk.',
        });
        await p.client.session.wait(
          { sessionID: root.id },
          { signal: AbortSignal.timeout(120_000) },
        );
      } finally {
        unsubscribe();
        await Promise.all(reads);
      }
      // Only baseline progress is model-free. The original final chat report
      // still carries check results and the /implement recommendation.
      const approvalRequests = p.requests.slice(requestsBeforeApproval);
      expect(approvalRequests).toHaveLength(1);
      expect(JSON.stringify(approvalRequests[0]!.body.messages)).toContain('Decision recorded');
      expect(JSON.stringify(approvalRequests[0]!.body.messages)).toContain('/implement');
      const context = await p.client.session.context({ sessionID: root.id });
      expect(JSON.stringify(context)).not.toContain('Validation started');
      expect(JSON.stringify(context)).toContain('Decision recorded');
      const presentation = await p.client.rpc.call({
        location: p.location,
        rpcID: 'flowguard-governance',
        method: 'GetPresentation',
        input: { sessionID: root.id },
      });
      const events = (presentation.output as { events: Array<{ kind: string; message: string }> })
        .events;
      expect(events).toEqual([]);
      expect(snapshots.flatMap((page) => page.events)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'validation',
            operation: expect.objectContaining({ kind: 'validation', attempt: 0 }),
            runID: expect.any(String),
            stage: 'check_started',
          }),
        ]),
      );
      expect(await receipts(p, root.id)).toMatchObject([
        {
          detail: {
            verdict: command === 'approve' ? 'approve' : 'approve_with_governance_override',
            operation: { source: 'host_command' },
          },
        },
      ]);
      expect((await workflow(p, root.id)).state.plan?.approvalCertificate).toBeDefined();
      expect((await workflow(p, root.id)).state.phase).toBe('IMPLEMENTATION');
      mutationRequested = true;
      await p.prompt(root.id, 'Apply the approved README-only change with the native patch tool.');
      expect(
        await readFile(p.project + '/README.md', 'utf8'),
        JSON.stringify(await p.client.session.context({ sessionID: root.id })) + '\n' + p.output(),
      ).toBe('# Verified native patch fixture\n');
      const mutated = await workflow(p, root.id);
      expect(mutated.state.mutationEpisodes).toEqual([
        expect.objectContaining({
          toolName: 'apply_patch',
          status: 'completed',
          outcome: 'success',
        }),
      ]);
      expect(verifyChain(await readAuditTrail(mutated.sessDir)).valid).toBe(true);
      implementationStep = 0;
      const implementationSnapshots: PresentationResult[] = [];
      const implementationReads: Promise<void>[] = [];
      const unsubscribeImplementation = rpc.events.on('PresentationUpdated', (event) => {
        if (event.data.sessionID !== root.id) return;
        const reading = rpc
          .GetPresentation({ sessionID: root.id }, { location: p.location })
          .then((page) => {
            implementationSnapshots.push(page);
          });
        implementationReads.push(reading);
        return reading;
      });
      try {
        await p.prompt(
          root.id,
          '/implement — record the change, run the post-implementation checks and obtain the independent implementation review.',
        );
      } finally {
        unsubscribeImplementation();
        await Promise.all(implementationReads);
      }
      const implementationEvents = [
        ...new Map(
          implementationSnapshots.flatMap((page) => page.events).map((event) => [event.id, event]),
        ).values(),
      ];
      expect(implementationEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'IMPL_VALIDATION',
            stage: 'check_started',
            message: expect.stringContaining('preparing `test` check'),
          }),
        ]),
      );
      const implemented = await workflow(p, root.id);
      expect(
        implemented.state.phase,
        JSON.stringify(await p.client.session.context({ sessionID: root.id })),
      ).toBe('EVIDENCE_REVIEW');
      expect(implemented.state.reviewAssurance!.invocations).toHaveLength(2);
      await p.client.session.command({
        sessionID: root.id,
        name: 'approve',
        text: 'Approve the independently reviewed documentation implementation.',
      });
      await p.client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(120_000) });
      expect((await workflow(p, root.id)).state.phase).toBe('EXPORT_READY');
      exportRequested = true;
      await p.prompt(root.id, '/export — create and verify the completion package.');
      const completed = await workflow(p, root.id);
      expect(
        completed.state.phase,
        JSON.stringify(await p.client.session.context({ sessionID: root.id })),
      ).toBe('COMPLETE');
      expect(verifyChain(await readAuditTrail(completed.sessDir)).valid).toBe(true);
    },
    300_000,
  );
  it('preserves the visible decision report, actual audit source and one receipt across repeat and SIGKILL/reload', async () => {
    const p = await open();
    const root = await p.session();
    await activate(p, root.id);
    // Start again has its own original chat response. Finish that turn before
    // measuring provider requests attributable to the subsequent decision.
    await p.client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(120_000) });
    await prepareComponentDecisionGate(await workflow(p, root.id));
    const beforeDecision = p.requests.length;
    await p.client.session.command({
      sessionID: root.id,
      name: 'approve',
      text: 'Reviewed current ADR.',
    });
    await p.client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(120_000) });
    expect(p.requests.slice(beforeDecision)).toHaveLength(1);
    expect(JSON.stringify(await p.client.session.context({ sessionID: root.id }))).toContain(
      'Decision recorded',
    );
    const presentation = await p.client.rpc.call({
      location: p.location,
      rpcID: 'flowguard-governance',
      method: 'GetPresentation',
      input: { sessionID: root.id },
    });
    expect((presentation.output as { events: unknown[] }).events).toEqual([]);
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
    const emptyPresentation = await p.client.rpc.call({
      location: p.location,
      rpcID: 'flowguard-governance',
      method: 'GetPresentation',
      input: { sessionID: root.id },
    });
    expect((emptyPresentation.output as { events: unknown[] }).events).toEqual([]);
    expect(p.requests.slice(beforeDecision)).toHaveLength(1);
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
