import { describe, expect, it } from 'vitest';
import { makeProgressedState } from '../../fixtures.js';
import { authorizeMutationEpisode } from '../../state/evidence-mutation-episode.js';
import { getPolicyPreset } from '../../config/policy.js';
import {
  resolveWorkflowDirective,
  resolveExecutionDisposition,
} from '../../machine/workflow-directive.js';
import { buildStatusProjection } from './status.js';
import { buildBlockedProjection, buildReadinessProjection } from './status-detail-projections.js';
import {
  buildWhyPresentationProjection,
  buildFinishPresentationProjection,
} from './status-why-finish.js';
import { buildFinishCard } from './status-finish.js';
import { buildWhyDocument } from './why-presentation.js';
import { renderMarkdown } from '../../presentation/index.js';
import { buildStatusDocument } from './status-presentation.js';
import { notCheckedDiscoveryDriftStatus } from '../discovery/discovery-drift-status.js';

const at = '2026-10-01T00:00:00.000Z';
const policy = getPolicyPreset('solo');
function openState() {
  const authorized = authorizeMutationEpisode([], {
    episodeId: '11111111-1111-4111-8111-111111111111',
    hostCallId: 'edit-failed-1',
    toolName: 'edit',
    runtimeInstanceId: '22222222-2222-4222-8222-222222222222',
    leaseGeneration: 1,
    authorizedAt: at,
  });
  if (authorized.kind !== 'authorized') throw new Error('fixture');
  return { ...makeProgressedState('IMPLEMENTATION'), mutationEpisodes: authorized.episodes };
}

describe('MUT4 canonical mutation blocker projection', () => {
  it('projects an open dispatch consistently and read-only, including exact recovery IDs', () => {
    const state = openState();
    const before = structuredClone(state);
    const full = buildStatusProjection(state, policy);
    const focused = buildBlockedProjection(state, policy);
    expect(resolveExecutionDisposition(state)).toBe('blocked');
    expect(full.directive).toEqual(resolveWorkflowDirective(state));
    expect(full.directive).toMatchObject({
      kind: 'blocked',
      commands: [],
      allowedIntents: [],
      context: { reasonCode: 'MUTATION_EPISODE_UNRESOLVED', reasonParams: { count: '1' } },
    });
    expect(full.blocker?.reasonCode).toBe('MUTATION_EPISODE_UNRESOLVED');
    expect(full.readiness).toBe('BLOCKED');
    expect(full.allowedCommands).toContain('/implement');
    expect(full.conclusion.kind).toBe('recovery');
    expect(focused).toMatchObject({
      blocked: true,
      reasonCode: 'MUTATION_EPISODE_UNRESOLVED',
      nextResolvableCommand: null,
      humanActionRequired: false,
      mutationEpisodes: [
        { hostCallId: 'edit-failed-1', toolName: 'edit', authorizedAt: at, leaseGeneration: 1 },
      ],
    });
    expect(focused.reasonText).toContain('1 authorized host mutation');
    expect(focused.recoveryHint).toContain('retry /implement');
    expect(full.mutationEpisodes).toEqual(focused.mutationEpisodes);
    expect(buildReadinessProjection(state, policy).blocked).toBe(true);
    const why = buildWhyPresentationProjection(state, policy, focused);
    expect(why.conclusion).toEqual(full.conclusion);
    expect(
      buildFinishPresentationProjection(state, buildFinishCard(state, policy)).conclusion,
    ).toEqual(full.conclusion);
    const markdown = renderMarkdown(buildWhyDocument(why));
    expect(markdown).toContain('retry /implement');
    expect(markdown).not.toContain('Implementation required');
    expect(markdown).not.toContain('{count}');
    expect(JSON.stringify(why)).not.toContain('REVIEW_STATE_INCOMPLETE');
    expect(state).toEqual(before);
  });

  it('labels phase-admissible commands without recommending a blocked implementation', () => {
    const full = buildStatusProjection(openState(), policy);
    const document = buildStatusDocument(
      {
        status: full,
        discoveryHealth: null,
        discoveryDrift: notCheckedDiscoveryDriftStatus('Mutation blocker presentation test.'),
      },
      { detail: 'explanation' },
    );
    const commands = document.sections.find((section) => section.kind === 'commandList');
    expect(commands).toMatchObject({
      heading: 'Commands allowed by phase (prerequisites still apply)',
      items: expect.arrayContaining([
        expect.objectContaining({ invocation: '/implement', visibility: 'available' }),
      ]),
    });
    expect(document.conclusion).toMatchObject({ kind: 'recovery' });
    const markdown = renderMarkdown(document);
    expect(markdown).not.toContain('## Available actions');
    expect(markdown).not.toContain('→ `/implement`');
    expect(markdown).toContain('retry /implement');
  });

  it('clears the blocker only after completion or a valid append-only resolution', () => {
    const state = openState();
    const completed = {
      ...state,
      mutationEpisodes: state.mutationEpisodes.map((episode) => ({
        ...episode,
        status: 'completed' as const,
        outcome: 'failure' as const,
        completedAt: at,
      })),
    };
    expect(buildBlockedProjection(completed, policy).blocked).toBe(false);
    expect(resolveWorkflowDirective(completed).commands).toEqual(['/implement']);
    const resolved = {
      ...state,
      mutationEpisodeResolutions: [
        {
          resolutionId: '33333333-3333-4333-8333-333333333333',
          hostCallId: 'edit-failed-1',
          status: 'reconciled_after_unknown_outcome' as const,
          basis: 'worktree_recapture' as const,
          resolvedAt: at,
          resolvingRuntimeInstanceId: '44444444-4444-4444-8444-444444444444',
          resolvingLeaseGeneration: 2,
        },
      ],
    };
    expect(buildBlockedProjection(resolved, policy)).toMatchObject({
      blocked: false,
      mutationEpisodes: [],
    });
  });

  it('preserves error > risk > discovery > mutation precedence', () => {
    const state = {
      ...openState(),
      error: {
        code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        message: 'unavailable',
        occurredAt: at,
        recoveryHint: 'Restore the plugin.',
      },
      riskGate: {
        status: 'blocked' as const,
        code: 'RISK_GATE_BLOCKED' as const,
        message: 'risk',
        blockedAt: at,
        lastDecisionId: 'decision',
      },
      discoveryHealthGate: {
        status: 'blocked' as const,
        code: 'DISCOVERY_DRIFT_BLOCKED' as const,
        message: 'drift',
        blockedAt: at,
      },
    };
    expect(buildBlockedProjection(state, policy).reasonCode).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    const risk = { ...state, error: null };
    expect(buildBlockedProjection(risk, policy).reasonCode).toBe('RISK_GATE_BLOCKED');
    const discovery = { ...risk, riskGate: undefined };
    expect(buildBlockedProjection(discovery, policy).reasonCode).toBe('DISCOVERY_DRIFT_BLOCKED');
    expect(resolveWorkflowDirective({ ...state, phase: 'ABORTED' }).kind).toBe('terminal');
    expect(buildBlockedProjection({ ...state, phase: 'ABORTED' }, policy).blocked).toBe(false);
  });
});
