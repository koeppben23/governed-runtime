/**
 * @module integration/phase-tool-gate.test
 * @description Tests for phase-aware host tool gate (BUG-03).
 *
 * Pure function tests — no mocks, no I/O, no filesystem.
 * Covers: HAPPY, BAD, CORNER, EDGE paths.
 */

import { describe, it, expect } from 'vitest';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  assessMinimumTaskClass,
  isRiskClassificationAllowed,
  maxTaskClass,
  projectCeremonyEligibility,
  reducedCeremonyEligible,
  resolveCeremonyProfile,
  ticketDeclarationGate,
  declaredTaskClassFor,
  MUTATING_HOST_TOOLS,
  HOST_MUTATION_PHASE,
} from './phase-tool-gate.js';
import type { Phase } from '../state/schema.js';
import {
  makeState,
  PLAN_REVIEW_ASSURANCE,
  IMPL_EVIDENCE,
  VERIFICATION_CANDIDATES,
  FIXTURE_TEST_CANDIDATE_ID,
  FIXTURE_LINT_CANDIDATE_ID,
} from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { hashText } from '../shared/hashing.js';

function implementationAttempt(
  checkId: string,
  implementation: { implementationId: string; digest: string },
) {
  return {
    attemptId:
      checkId === 'test'
        ? '00000000-0000-4000-8000-0000000000c1'
        : '00000000-0000-4000-8000-0000000000c2',
    scope: 'implementation' as const,
    implementationId: implementation.implementationId,
    implementationDigest: implementation.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: validationResult(checkId),
  };
}

function validationResult(checkId: string) {
  const candidate =
    checkId === 'lint'
      ? { candidateId: FIXTURE_LINT_CANDIDATE_ID, command: 'npm run lint', kind: 'lint' as const }
      : { candidateId: FIXTURE_TEST_CANDIDATE_ID, command: 'npm test', kind: 'test' as const };
  return {
    checkId,
    ...candidate,
    passed: true,
    detail: 'OK',
    executedAt: '2026-01-01T00:00:00.000Z',
    exitCode: 0,
    executionMs: 1,
    outputDigest: 'a'.repeat(64),
    timedOut: false,
    outcome: 'supported' as const,
  };
}

// ─── isMutatingHostTool ──────────────────────────────────────────────────────

describe('phase-tool-gate', () => {
  describe('isMutatingHostTool', () => {
    describe('HAPPY — mutating tools return true', () => {
      it('T1: bash → true', () => {
        expect(isMutatingHostTool('bash')).toBe(true);
      });

      it('T2: write → true', () => {
        expect(isMutatingHostTool('write')).toBe(true);
      });

      it('T3: edit → true', () => {
        expect(isMutatingHostTool('edit')).toBe(true);
      });

      it('T3b: apply_patch → true', () => {
        expect(isMutatingHostTool('apply_patch')).toBe(true);
      });
    });

    describe('HAPPY — read-only tools return false', () => {
      it('T4: read → false', () => {
        expect(isMutatingHostTool('read')).toBe(false);
      });

      it('T5: glob → false', () => {
        expect(isMutatingHostTool('glob')).toBe(false);
      });

      it('T6: grep → false', () => {
        expect(isMutatingHostTool('grep')).toBe(false);
      });

      it('T7: webfetch → false', () => {
        expect(isMutatingHostTool('webfetch')).toBe(false);
      });

      it('T7b: todowrite → false (host task-list tool, no repo/state mutation)', () => {
        expect(isMutatingHostTool('todowrite')).toBe(false);
      });
    });

    describe('CORNER — non-host tools return false', () => {
      it('T8: task → false (has its own enforcement)', () => {
        expect(isMutatingHostTool('task')).toBe(false);
      });

      it('T9: flowguard_plan → false (FlowGuard tools excluded)', () => {
        expect(isMutatingHostTool('flowguard_plan')).toBe(false);
      });

      it('T9b: mcp__flowguard__flowguard_status → false (MCP FlowGuard surface excluded)', () => {
        expect(isMutatingHostTool('mcp__flowguard__flowguard_status')).toBe(false);
      });
    });

    describe('EDGE — empty and unknown tools', () => {
      it('T10: empty string → true (fail-closed)', () => {
        expect(isMutatingHostTool('')).toBe(true);
      });

      it('T11: unknown_tool → true (fail-closed until explicitly classified)', () => {
        expect(isMutatingHostTool('unknown_tool')).toBe(true);
      });

      it('T11b: mcp__other__danger → true (unknown MCP surface fails closed)', () => {
        expect(isMutatingHostTool('mcp__other__danger')).toBe(true);
      });
    });
  });

  // ─── isHostToolAllowedInPhase ────────────────────────────────────────────

  describe('isHostToolAllowedInPhase', () => {
    describe('HAPPY — mutating tools allowed in execution phases', () => {
      it('T12: bash in IMPLEMENTATION → allowed', () => {
        const result = isHostToolAllowedInPhase('bash', 'IMPLEMENTATION');
        expect(result.allowed).toBe(true);
        expect(result.code).toBeUndefined();
      });

      it('T13: write in IMPLEMENTATION → allowed', () => {
        const result = isHostToolAllowedInPhase('write', 'IMPLEMENTATION');
        expect(result.allowed).toBe(true);
      });

      it('T14: edit in IMPLEMENTATION → allowed', () => {
        const result = isHostToolAllowedInPhase('edit', 'IMPLEMENTATION');
        expect(result.allowed).toBe(true);
      });
    });

    describe('HAPPY — read-only tools allowed in investigation phases', () => {
      it('T15: read in PLAN → allowed', () => {
        const result = isHostToolAllowedInPhase('read', 'PLAN');
        expect(result.allowed).toBe(true);
      });

      it('T16: glob in TICKET → allowed', () => {
        const result = isHostToolAllowedInPhase('glob', 'TICKET');
        expect(result.allowed).toBe(true);
      });

      it('T17: grep in ARCHITECTURE → allowed', () => {
        const result = isHostToolAllowedInPhase('grep', 'ARCHITECTURE');
        expect(result.allowed).toBe(true);
      });

      it('T17b: todowrite in PLAN → allowed (not default-denied as unknown)', () => {
        const result = isHostToolAllowedInPhase('todowrite', 'PLAN');
        expect(result.allowed).toBe(true);
        expect(result.code).toBeUndefined();
      });

      it('T17c: todowrite in IMPLEMENTATION → allowed', () => {
        const result = isHostToolAllowedInPhase('todowrite', 'IMPLEMENTATION');
        expect(result.allowed).toBe(true);
        expect(result.code).toBeUndefined();
      });
    });

    describe('BAD — mutating tools blocked in PLAN phase', () => {
      it('T18: bash in PLAN → blocked with HOST_TOOL_PHASE_DENIED', () => {
        const result = isHostToolAllowedInPhase('bash', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
        expect(result.reason).toContain("'bash'");
        expect(result.reason).toContain('PLAN');
      });

      it('T19: write in PLAN → blocked', () => {
        const result = isHostToolAllowedInPhase('write', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });

      it('T20: edit in PLAN → blocked', () => {
        const result = isHostToolAllowedInPhase('edit', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });
    });

    describe('BAD — mutating tools blocked in TICKET phase', () => {
      it('T21: bash in TICKET → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'TICKET');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
        expect(result.reason).toContain('TICKET');
      });

      it('T22: write in TICKET → blocked', () => {
        const result = isHostToolAllowedInPhase('write', 'TICKET');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });

      it('T23: edit in TICKET → blocked', () => {
        const result = isHostToolAllowedInPhase('edit', 'TICKET');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });
    });

    describe('BAD — mutating tools blocked in ARCHITECTURE phase', () => {
      it('T24: bash in ARCHITECTURE → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'ARCHITECTURE');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
        expect(result.reason).toContain('ARCHITECTURE');
      });

      it('T25: write in ARCHITECTURE → blocked', () => {
        const result = isHostToolAllowedInPhase('write', 'ARCHITECTURE');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });

      it('T26: edit in ARCHITECTURE → blocked', () => {
        const result = isHostToolAllowedInPhase('edit', 'ARCHITECTURE');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });
    });

    describe('BAD — mutating tools blocked outside IMPLEMENTATION', () => {
      it('T27: bash in VALIDATION → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'VALIDATION');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });

      it('T28: bash in READY → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'READY');
        expect(result.allowed).toBe(false);
      });

      it('T29: bash in PLAN_REVIEW → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'PLAN_REVIEW');
        expect(result.allowed).toBe(false);
      });

      it('T30: bash in IMPL_REVIEW → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'IMPL_REVIEW');
        expect(result.allowed).toBe(false);
      });

      it('T31: edit in EVIDENCE_REVIEW → blocked', () => {
        const result = isHostToolAllowedInPhase('edit', 'EVIDENCE_REVIEW');
        expect(result.allowed).toBe(false);
      });
    });

    describe('EDGE — boundary and terminal phases', () => {
      it('T32: bash in COMPLETE → blocked', () => {
        const result = isHostToolAllowedInPhase('bash', 'COMPLETE');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
      });

      it('T33: flowguard_plan in PLAN → allowed (not in MUTATING_HOST_TOOLS)', () => {
        const result = isHostToolAllowedInPhase('flowguard_plan', 'PLAN');
        expect(result.allowed).toBe(true);
      });

      it('T34: unknown_tool in PLAN → denied by default', () => {
        const result = isHostToolAllowedInPhase('unknown_tool', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_UNKNOWN_DENIED');
      });

      it('T35: empty string tool in PLAN → denied by default', () => {
        const result = isHostToolAllowedInPhase('', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('HOST_TOOL_UNKNOWN_DENIED');
      });
    });

    // ── SMOKE — constant set integrity ──────────────────────────────────

    describe('SMOKE — constant set integrity', () => {
      it('T36: MUTATING_HOST_TOOLS contains exactly bash, write, edit, apply_patch', () => {
        expect(MUTATING_HOST_TOOLS.size).toBe(4);
        expect(MUTATING_HOST_TOOLS.has('bash')).toBe(true);
        expect(MUTATING_HOST_TOOLS.has('write')).toBe(true);
        expect(MUTATING_HOST_TOOLS.has('edit')).toBe(true);
        expect(MUTATING_HOST_TOOLS.has('apply_patch')).toBe(true);
      });

      it('T37: HOST_MUTATION_PHASE is IMPLEMENTATION', () => {
        expect(HOST_MUTATION_PHASE).toBe('IMPLEMENTATION');
      });

      it('T38: blocked result includes actionable reason text', () => {
        const result = isHostToolAllowedInPhase('bash', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('only allowed in phase IMPLEMENTATION');
        expect(result.reason).toContain('read, glob, grep');
      });
    });

    // ── E2E — full matrix coverage ──────────────────────────────────────

    describe('E2E — every mutating tool × every non-implementation phase → blocked', () => {
      const mutatingTools = ['bash', 'write', 'edit', 'apply_patch'] as const;
      const nonImplementationPhases: Phase[] = [
        'READY',
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPL_VALIDATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
        'ARCHITECTURE',
        'ARCH_REVIEW',
        'ARCH_COMPLETE',
        'PEER_REVIEW',
        'PEER_REVIEW_COMPLETE',
      ];

      for (const tool of mutatingTools) {
        for (const phase of nonImplementationPhases) {
          it(`T-MATRIX: ${tool} × ${phase} → blocked`, () => {
            const result = isHostToolAllowedInPhase(tool, phase);
            expect(result.allowed).toBe(false);
            expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
          });
        }
      }
    });

    describe('E2E — every mutating tool × IMPLEMENTATION → allowed', () => {
      const mutatingTools = ['bash', 'write', 'edit', 'apply_patch'] as const;

      for (const tool of mutatingTools) {
        it(`T-MATRIX: ${tool} × IMPLEMENTATION → allowed`, () => {
          const result = isHostToolAllowedInPhase(tool, 'IMPLEMENTATION');
          expect(result.allowed).toBe(true);
        });
      }
    });
  });

  describe('fail-closed decision contract', () => {
    it('ALLOW results carry no denial metadata', () => {
      for (const result of [
        isHostToolAllowedInPhase('bash', 'IMPLEMENTATION'),
        isHostToolAllowedInPhase('read', 'PLAN'),
      ]) {
        expect(result.allowed).toBe(true);
        expect(result.code).toBeUndefined();
        expect(result.reason).toBeUndefined();
      }
    });

    it('DENY results always carry string code and reason (host gate)', () => {
      for (const result of [
        isHostToolAllowedInPhase('bash', 'PLAN'),
        isHostToolAllowedInPhase('mystery_tool', 'PLAN'),
      ]) {
        expect(result.allowed).toBe(false);
        expect(typeof result.code).toBe('string');
        expect(typeof result.reason).toBe('string');
      }
    });

    it('DENY results always carry string code and reason (risk gate)', () => {
      const state = makeState('IMPLEMENTATION', {
        riskGate: {
          status: 'blocked',
          code: 'RISK_GATE_BLOCKED',
          message: 'blocked',
          blockedAt: '2026-01-01T00:00:00.000Z',
          lastDecisionId: 'RISK-1',
        },
      });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/state/schema.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(typeof result.code).toBe('string');
      expect(typeof result.reason).toBe('string');
    });
  });

  describe('risk classification gate', () => {
    it('HAPPY — an escalation claim can never lower the computed class', () => {
      const state = makeState('IMPLEMENTATION', { claimedTaskClass: 'TRIVIAL' });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/state/schema.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(true);
      expect(result.minimumTaskClass).toBe('HIGH-RISK');
      expect(result.effectiveTaskClass).toBe('HIGH-RISK');
    });

    it('HAPPY — a missing claim never blocks; the computed class governs', () => {
      const state = makeState('IMPLEMENTATION');
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['README.md'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(true);
      expect(result.effectiveTaskClass).toBe('TRIVIAL');
      expect(result.declaredTaskClass).toBeNull();
    });

    it('HAPPY — HIGH-RISK claim on sensitive change is allowed', () => {
      const state = makeState('IMPLEMENTATION', { claimedTaskClass: 'HIGH-RISK' });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/audit/types.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(true);
      expect(result.minimumTaskClass).toBe('HIGH-RISK');
    });

    it('HAPPY — narrow non-governance markdown typo may remain TRIVIAL', () => {
      expect(assessMinimumTaskClass(['docs/usage-notes.md']).minimumTaskClass).toBe('TRIVIAL');
    });

    it('BAD — governance docs and sensitive tests are not TRIVIAL', () => {
      expect(assessMinimumTaskClass(['AGENTS.md']).minimumTaskClass).toBe('HIGH-RISK');
      expect(assessMinimumTaskClass(['CHANGELOG.md']).minimumTaskClass).toBe('STANDARD');
      expect(assessMinimumTaskClass(['src/state/schema.test.ts']).minimumTaskClass).toBe(
        'HIGH-RISK',
      );
    });

    it('BAD — accepted governance surface matrix requires HIGH-RISK', () => {
      const highRiskPaths = [
        'src/identity/actor-info.ts',
        'src/adapters/persistence.ts',
        'src/adapters/persistence-logging.ts',
        'src/cli/install.ts',
        'src/cli/uninstall.ts',
        'src/cli/doctor.ts',
        'src/archive/verify.ts',
        'src/evidence/decision.ts',
        'src/rails/review.ts',
        'src/rails/review-decision.ts',
        'src/templates/commands/review.ts',
        'src/integration/review/enforcement/session.ts',
        'src/integration/phase-tool-gate.ts',
        'src/security/actions-pinning.ts',
        'src/config/policy-resolver.ts',
        'src/migrations/session-state.ts',
        'scripts/install.js',
        'scripts/uninstall.js',
        'scripts/release.js',
        'docs/agent-guidance/context-aware-mandates.md',
        'docs/agent-guidance/high-risk.md',
        'docs/runtime-mandates.md',
        'docs/project-governance.md',
        'docs/bsi-c5-mapping.md',
        'docs/policies.md',
        'docs/configuration.md',
        'docs/security-hardening.md',
      ];

      for (const filePath of highRiskPaths) {
        expect(assessMinimumTaskClass([filePath]).minimumTaskClass, filePath).toBe('HIGH-RISK');
      }
    });

    it('reports every specific trigger and uses ceremony_only only without one', () => {
      expect(
        assessMinimumTaskClass([
          'src/state/schema.ts',
          'src/templates/commands/plan.ts',
          'scripts/release.js',
        ]).riskTriggers,
      ).toEqual(['command_contract', 'distribution_integrity', 'state_integrity']);
      expect(assessMinimumTaskClass(['src/archive/verify.ts']).riskTriggers).toEqual([
        'ceremony_only',
      ]);
      // src/config/ remains HIGH-RISK for ceremony, but only the named policy
      // authorities create a claim requirement.
      expect(assessMinimumTaskClass(['src/config/logging-config.ts']).riskTriggers).toEqual([
        'ceremony_only',
      ]);
      expect(assessMinimumTaskClass(['src/config/policy-resolver.ts']).riskTriggers).toEqual([
        'policy_authority',
      ]);
    });

    it('HAPPY — root tool/editor config (opencode.json, tsconfig, vitest config) is not a STANDARD floor', () => {
      for (const cfg of [
        'opencode.json',
        'opencode.jsonc',
        'tsconfig.json',
        'vitest.config.ts',
        '.eslintrc.json',
        '.prettierrc',
        '.gitignore',
      ]) {
        expect(assessMinimumTaskClass([cfg]).minimumTaskClass, cfg).toBe('TRIVIAL');
      }
    });

    it('BAD — high-risk config stays HIGH-RISK and is NOT downgraded as non-domain config', () => {
      // Critical invariant: the non-domain-config exclusion must never lower
      // package.json or lockfiles, which are governed supply-chain surfaces.
      for (const cfg of [
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lockb',
      ]) {
        expect(assessMinimumTaskClass([cfg]).minimumTaskClass, cfg).toBe('HIGH-RISK');
      }
    });

    it('CORNER — a nested config.json (not root tooling) keeps the STANDARD default', () => {
      // Only exact ROOT basenames are non-domain; a project config nested in
      // source may carry behavior and must not be silently downgraded.
      expect(assessMinimumTaskClass(['src/app/config.json']).minimumTaskClass).toBe('STANDARD');
      expect(assessMinimumTaskClass(['config/opencode.json']).minimumTaskClass).toBe('STANDARD');
    });

    it('CORNER — a stale opencode.json does not escalate an otherwise TRIVIAL change', () => {
      expect(
        assessMinimumTaskClass(['opencode.json', 'docs/usage-notes.md']).minimumTaskClass,
      ).toBe('TRIVIAL');
    });

    it('EDGE — there is no downgrade path: the effective class escalates conservatively', () => {
      const state = makeState('IMPLEMENTATION', { claimedTaskClass: 'TRIVIAL' });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/identity/actor-info.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(true);
      expect(result.effectiveTaskClass).toBe('HIGH-RISK');
    });

    it('BAD — existing persistent riskGate block stops subsequent mutating paths', () => {
      const state = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'HIGH-RISK',
        riskGate: {
          status: 'blocked',
          code: 'RISK_GATE_BLOCKED',
          message: 'previous block',
          blockedAt: '2026-01-01T00:00:00.000Z',
          lastDecisionId: 'RISK-1',
        },
      });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['README.md'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('RISK_GATE_BLOCKED');
      expect(result.decisionId).toBe('RISK-1');
    });
  });

  describe('reduced ceremony eligibility boundary', () => {
    it('excludes instruction, permission and control-plane surfaces at any depth', () => {
      const excluded = [
        'AGENTS.md',
        'pkg/AGENTS.md',
        'CLAUDE.md',
        'nested/GEMINI.md',
        '.claude/settings.json',
        'pkg/.opencode/agent.md',
        '.github/copilot-instructions.md',
        'opencode.json',
        'vitest.config.ts',
      ];
      for (const path of excluded) {
        expect(reducedCeremonyEligible([path]), path).toBe(false);
      }
    });

    it('allows ordinary documentation and source files', () => {
      expect(reducedCeremonyEligible(['docs/usage-notes.md', 'src/feature.ts'])).toBe(true);
      expect(reducedCeremonyEligible([])).toBe(false);
    });

    it('escalates instruction surfaces in the general risk classifier', () => {
      for (const path of [
        'CLAUDE.md',
        'GEMINI.md',
        'nested/AGENTS.md',
        '.claude/settings.json',
        '.github/copilot-instructions.md',
      ]) {
        expect(assessMinimumTaskClass([path]).minimumTaskClass, path).toBe('HIGH-RISK');
      }
    });
  });

  describe('reduced ceremony profile', () => {
    it('HAPPY — permits reduced ceremony only for verified TRIVIAL runtime evidence', () => {
      const implementation = IMPL_EVIDENCE;
      const base = makeState('IMPL_VALIDATION', {
        claimedTaskClass: 'TRIVIAL',
        verificationCandidates: VERIFICATION_CANDIDATES,
        implementation,
        activeChecks: ['test', 'lint'],
        implValidation: [validationResult('test'), validationResult('lint')],
        validationAttempts: [
          implementationAttempt('test', implementation),
          implementationAttempt('lint', implementation),
        ],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({
        state,
        changedFiles: ['docs/usage-notes.md'],
      });

      expect(result.profile).toBe('reduced');
      if (result.profile === 'reduced') {
        expect(result.reason).toBe('POST_IMPL_VERIFIED_TRIVIAL');
        expect(result.implementationId).toBe(implementation.implementationId);
        expect(result.implementationDigest).toBe(implementation.digest);
        expect(result.policyDigest).toBe(state.policySnapshot.hash);
        expect(result.verificationBasis.checkIds).toEqual(['test', 'lint']);
        expect(result.verificationBasis.attempts).toHaveLength(2);
      }
    });

    it('HAPPY — a missing task class claim no longer keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        validation: [validationResult('test_quality'), validationResult('rollback_safety')],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      expect(
        projectCeremonyEligibility({ state, changedFiles: ['docs/usage-notes.md'] }).status,
      ).toBe('pending_post_implementation_verification');
    });

    it('BAD — non-TRIVIAL task class claim keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'STANDARD',
        validation: [validationResult('test_quality'), validationResult('rollback_safety')],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('RESOLVED_RISK_NOT_TRIVIAL');
      expect(result.effectiveTaskClass).toBe('STANDARD');
    });

    it('BAD — an outstanding review obligation keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [validationResult('test'), validationResult('lint')],
      });
      const outstandingObligation = {
        ...PLAN_REVIEW_ASSURANCE.obligations[0]!,
        status: 'pending' as const,
        invocationId: null,
        fulfilledAt: null,
        consumedAt: null,
      };
      const state = {
        ...base,
        policySnapshot: {
          ...base.policySnapshot,
          allowReducedCeremony: true,
        },
        reviewAssurance: {
          ...PLAN_REVIEW_ASSURANCE,
          obligations: [outstandingObligation],
        },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('REVIEW_OBLIGATION_REQUIRED');
    });

    it('GOOD — a deterministically blocked obligation keeps reduced ceremony', () => {
      const implementation = IMPL_EVIDENCE;
      const base = makeState('IMPL_VALIDATION', {
        claimedTaskClass: 'TRIVIAL',
        verificationCandidates: VERIFICATION_CANDIDATES,
        implementation,
        activeChecks: ['test', 'lint'],
        implValidation: [validationResult('test'), validationResult('lint')],
        validationAttempts: [
          implementationAttempt('test', implementation),
          implementationAttempt('lint', implementation),
        ],
      });
      const blockedObligation = {
        ...PLAN_REVIEW_ASSURANCE.obligations[0]!,
        status: 'blocked' as const,
        blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE',
        invocationId: null,
        fulfilledAt: null,
        consumedAt: null,
      };
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
        reviewAssurance: { ...PLAN_REVIEW_ASSURANCE, obligations: [blockedObligation] },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('reduced');
      expect(result.reason).toBe('POST_IMPL_VERIFIED_TRIVIAL');
    });

    it('BAD — a reuse integrity incident keeps full ceremony despite later evidence', () => {
      const implementation = IMPL_EVIDENCE;
      const base = makeState('IMPL_VALIDATION', {
        claimedTaskClass: 'TRIVIAL',
        verificationCandidates: VERIFICATION_CANDIDATES,
        implementation,
        activeChecks: ['test', 'lint'],
        implValidation: [validationResult('test'), validationResult('lint')],
        validationAttempts: [
          implementationAttempt('test', implementation),
          implementationAttempt('lint', implementation),
        ],
      });
      const incident = {
        ...PLAN_REVIEW_ASSURANCE.obligations[0]!,
        status: 'blocked' as const,
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
        invocationId: null,
        fulfilledAt: null,
        consumedAt: null,
      };
      // A successor review cannot be proven to have happened after the
      // incident from persisted evidence; reduced ceremony stays closed.
      const successor = {
        ...PLAN_REVIEW_ASSURANCE.obligations[0]!,
        obligationId: '00000000-0000-4000-8000-0000000000d2',
        status: 'fulfilled' as const,
        invocationId: '00000000-0000-4000-8000-0000000000d3',
        fulfilledAt: '2026-01-03T00:00:00.000Z',
        consumedAt: null,
      };
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
        reviewAssurance: {
          ...PLAN_REVIEW_ASSURANCE,
          obligations: [incident, successor],
        },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('REVIEW_INTEGRITY_INCIDENT');
    });

    it('BAD — default policy keeps full ceremony even for TRIVIAL evidence', () => {
      const state = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [validationResult('test_quality'), validationResult('rollback_safety')],
      });

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('POLICY_REDUCED_CEREMONY_DISABLED');
    });

    it('BAD — governance surface escalates to computed HIGH-RISK and blocks reduction', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [validationResult('test_quality'), validationResult('rollback_safety')],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['src/security/policy.ts'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('RESOLVED_RISK_NOT_TRIVIAL');
      expect(result.computedMinimumTaskClass).toBe('HIGH-RISK');
    });

    it('BAD — blocked riskGate prevents reduced ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        riskGate: {
          status: 'blocked',
          code: 'RISK_GATE_BLOCKED',
          message: 'blocked',
          blockedAt: '2026-01-01T00:00:00.000Z',
          lastDecisionId: 'RISK-1',
        },
        validation: [validationResult('test_quality'), validationResult('rollback_safety')],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('RISK_GATE_BLOCKED');
    });
  });
});

describe('ticket declaration gate projection', () => {
  function ticketState(input: {
    text: string;
    digest?: string;
    riskDeclaration:
      | { kind: 'absent' }
      | { kind: 'declared'; taskClass: 'TRIVIAL' | 'STANDARD' | 'HIGH-RISK' }
      | { kind: 'conflict'; values: Array<'TRIVIAL' | 'STANDARD' | 'HIGH-RISK'> }
      | { kind: 'invalid'; raw: string };
  }) {
    return makeState('TICKET', {
      ticket: {
        text: input.text,
        digest: input.digest ?? hashText(input.text),
        source: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        riskDeclaration: input.riskDeclaration,
      },
    });
  }

  it('HAPPY: a valid declaration is clear and contributes its floor', () => {
    const state = ticketState({
      text: 'Risk: STANDARD\n\nBounded change.',
      riskDeclaration: { kind: 'declared', taskClass: 'STANDARD' },
    });
    expect(ticketDeclarationGate(state)).toEqual({ status: 'clear' });
    expect(declaredTaskClassFor(state)).toBe('STANDARD');
  });

  it('HAPPY: an absent declaration is clear with no floor', () => {
    const state = ticketState({ text: 'No risk line.', riskDeclaration: { kind: 'absent' } });
    expect(ticketDeclarationGate(state)).toEqual({ status: 'clear' });
    expect(declaredTaskClassFor(state)).toBeNull();
  });

  it('BAD: an invalid declaration blocks with TICKET_RISK_DECLARATION_INVALID', () => {
    const state = ticketState({
      text: 'Risk: nonsense',
      riskDeclaration: { kind: 'invalid', raw: 'nonsense' },
    });
    expect(ticketDeclarationGate(state)).toMatchObject({
      status: 'blocked',
      code: 'TICKET_RISK_DECLARATION_INVALID',
    });
    expect(declaredTaskClassFor(state)).toBeNull();
  });

  it('BAD: a digest that does not hash the text blocks as inconsistent', () => {
    const state = ticketState({
      text: 'Risk: TRIVIAL',
      digest: 'not-the-hash-of-the-text',
      riskDeclaration: { kind: 'declared', taskClass: 'TRIVIAL' },
    });
    expect(ticketDeclarationGate(state)).toMatchObject({
      status: 'blocked',
      code: 'TICKET_RISK_DECLARATION_INCONSISTENT',
    });
  });

  it('BAD: a stored declaration that disagrees with the parser blocks as inconsistent', () => {
    // The digest alone would pass; only re-running the parser over the text
    // proves the stored declaration describes that text.
    const text = 'Risk: TRIVIAL';
    const state = ticketState({
      text,
      digest: hashText(text),
      riskDeclaration: { kind: 'declared', taskClass: 'HIGH-RISK' },
    });
    expect(ticketDeclarationGate(state)).toMatchObject({
      status: 'blocked',
      code: 'TICKET_RISK_DECLARATION_INCONSISTENT',
    });
  });

  it('EDGE: a conflicting declaration is clear but floors at the highest value', () => {
    const text = 'Risk: TRIVIAL\nRisk: HIGH-RISK';
    const state = ticketState({
      text,
      riskDeclaration: { kind: 'conflict', values: ['HIGH-RISK', 'TRIVIAL'] },
    });
    expect(ticketDeclarationGate(state)).toEqual({ status: 'clear' });
    expect(declaredTaskClassFor(state)).toBe('HIGH-RISK');
  });

  it('EDGE: no ticket never blocks and has no floor', () => {
    const state = makeState('TICKET');
    expect(ticketDeclarationGate(state)).toEqual({ status: 'clear' });
    expect(declaredTaskClassFor(state)).toBeNull();
  });
});

describe('task class ordering', () => {
  const CLASSES = ['TRIVIAL', 'STANDARD', 'HIGH-RISK'] as const;

  it('pins the full order and tie behaviour of maxTaskClass', () => {
    expect(maxTaskClass('TRIVIAL', 'STANDARD')).toBe('STANDARD');
    expect(maxTaskClass('STANDARD', 'TRIVIAL')).toBe('STANDARD');
    expect(maxTaskClass('STANDARD', 'HIGH-RISK')).toBe('HIGH-RISK');
    expect(maxTaskClass('HIGH-RISK', 'STANDARD')).toBe('HIGH-RISK');
    expect(maxTaskClass('TRIVIAL', 'HIGH-RISK')).toBe('HIGH-RISK');
    expect(maxTaskClass('HIGH-RISK', 'TRIVIAL')).toBe('HIGH-RISK');

    for (const taskClass of CLASSES) {
      expect(maxTaskClass(taskClass, taskClass), taskClass).toBe(taskClass);
    }
  });

  it('is commutative and idempotent for every pair', () => {
    for (const first of CLASSES) {
      for (const second of CLASSES) {
        const maximum = maxTaskClass(first, second);
        expect(maximum, `${first} vs ${second}`).toBe(maxTaskClass(second, first));
        expect(maxTaskClass(maximum, second), `${first} vs ${second}`).toBe(maximum);
        expect(maxTaskClass(first, first)).toBe(first);
      }
    }
  });

  it('never lowers an assessed minimum when combined with a claim', () => {
    const minimum = assessMinimumTaskClass(['src/state/schema.ts']).minimumTaskClass;
    expect(minimum).toBe('HIGH-RISK');

    for (const claimed of CLASSES) {
      expect(maxTaskClass(minimum, claimed), claimed).toBe('HIGH-RISK');
      expect(maxTaskClass(claimed, minimum), claimed).toBe('HIGH-RISK');
    }
  });
});
