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
  resolveCeremonyProfile,
  MUTATING_HOST_TOOLS,
  INVESTIGATION_ONLY_PHASES,
} from './phase-tool-gate.js';
import type { Phase } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';

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
    });

    describe('CORNER — non-host tools return false', () => {
      it('T8: task → false (has its own enforcement)', () => {
        expect(isMutatingHostTool('task')).toBe(false);
      });

      it('T9: flowguard_plan → false (FlowGuard tools excluded)', () => {
        expect(isMutatingHostTool('flowguard_plan')).toBe(false);
      });
    });

    describe('EDGE — empty and unknown tools', () => {
      it('T10: empty string → true (fail-closed)', () => {
        expect(isMutatingHostTool('')).toBe(true);
      });

      it('T11: unknown_tool → true (fail-closed until explicitly classified)', () => {
        expect(isMutatingHostTool('unknown_tool')).toBe(true);
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

    describe('CORNER — mutating tools allowed in non-investigation phases', () => {
      it('T27: bash in VALIDATION → allowed (tests need bash)', () => {
        const result = isHostToolAllowedInPhase('bash', 'VALIDATION');
        expect(result.allowed).toBe(true);
      });

      it('T28: bash in READY → allowed (entry phase, no restriction)', () => {
        const result = isHostToolAllowedInPhase('bash', 'READY');
        expect(result.allowed).toBe(true);
      });

      it('T29: bash in PLAN_REVIEW → allowed (reviewer has platform restrictions)', () => {
        const result = isHostToolAllowedInPhase('bash', 'PLAN_REVIEW');
        expect(result.allowed).toBe(true);
      });

      it('T30: bash in IMPL_REVIEW → allowed', () => {
        const result = isHostToolAllowedInPhase('bash', 'IMPL_REVIEW');
        expect(result.allowed).toBe(true);
      });

      it('T31: edit in EVIDENCE_REVIEW → allowed', () => {
        const result = isHostToolAllowedInPhase('edit', 'EVIDENCE_REVIEW');
        expect(result.allowed).toBe(true);
      });
    });

    describe('EDGE — boundary and terminal phases', () => {
      it('T32: bash in COMPLETE → allowed (terminal, no active work)', () => {
        const result = isHostToolAllowedInPhase('bash', 'COMPLETE');
        expect(result.allowed).toBe(true);
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

      it('T37: INVESTIGATION_ONLY_PHASES contains exactly TICKET, PLAN, ARCHITECTURE', () => {
        expect(INVESTIGATION_ONLY_PHASES.size).toBe(3);
        expect(INVESTIGATION_ONLY_PHASES.has('TICKET')).toBe(true);
        expect(INVESTIGATION_ONLY_PHASES.has('PLAN')).toBe(true);
        expect(INVESTIGATION_ONLY_PHASES.has('ARCHITECTURE')).toBe(true);
      });

      it('T38: blocked result includes actionable reason text', () => {
        const result = isHostToolAllowedInPhase('bash', 'PLAN');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('read-only tools');
        expect(result.reason).toContain('read, glob, grep');
      });
    });

    // ── E2E — full matrix coverage ──────────────────────────────────────

    describe('E2E — every mutating tool × every investigation phase → blocked', () => {
      const mutatingTools = ['bash', 'write', 'edit', 'apply_patch'] as const;
      const investigationPhases: Phase[] = ['TICKET', 'PLAN', 'ARCHITECTURE'];

      for (const tool of mutatingTools) {
        for (const phase of investigationPhases) {
          it(`T-MATRIX: ${tool} × ${phase} → blocked`, () => {
            const result = isHostToolAllowedInPhase(tool, phase);
            expect(result.allowed).toBe(false);
            expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
          });
        }
      }
    });

    describe('E2E — every mutating tool × every non-investigation phase → allowed', () => {
      const mutatingTools = ['bash', 'write', 'edit'] as const;
      const nonInvestigationPhases: Phase[] = [
        'READY',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
        'ARCH_REVIEW',
        'ARCH_COMPLETE',
        'REVIEW',
        'REVIEW_COMPLETE',
      ];

      for (const tool of mutatingTools) {
        for (const phase of nonInvestigationPhases) {
          it(`T-MATRIX: ${tool} × ${phase} → allowed`, () => {
            const result = isHostToolAllowedInPhase(tool, phase);
            expect(result.allowed).toBe(true);
          });
        }
      }
    });
  });

  describe('risk classification gate', () => {
    it('BAD — TRIVIAL claim on src/state change is blocked', () => {
      const state = makeState('IMPLEMENTATION', { claimedTaskClass: 'TRIVIAL' });
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/state/schema.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('RISK_CLASSIFICATION_MISMATCH');
      expect(result.minimumTaskClass).toBe('HIGH-RISK');
    });

    it('BAD — missing claim is blocked under enforced gate checks', () => {
      const state = makeState('IMPLEMENTATION');
      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['README.md'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('RISK_CLASSIFICATION_REQUIRED');
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

    it('BAD — downgrade override flag is denied rather than accepted', () => {
      const base = makeState('IMPLEMENTATION', { claimedTaskClass: 'TRIVIAL' });
      const state = {
        ...base,
        policySnapshot: {
          ...base.policySnapshot,
          allowRiskDowngradeOverride: true,
        },
      };

      const result = isRiskClassificationAllowed({
        state,
        changedFiles: ['src/identity/actor-info.ts'],
        now: '2026-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('RISK_DOWNGRADE_OVERRIDE_DENIED');
      expect(result.minimumTaskClass).toBe('HIGH-RISK');
    });

    it('BAD — existing persistent riskGate block stops subsequent mutating paths', () => {
      const state = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'HIGH-RISK',
        riskGate: {
          status: 'blocked',
          code: 'RISK_CLASSIFICATION_MISMATCH',
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

  describe('reduced ceremony profile', () => {
    it('HAPPY — permits reduced ceremony only for verified TRIVIAL runtime evidence', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [
          {
            checkId: 'test',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            executionMs: 100,
            outputDigest: 'a'.repeat(64),
            timedOut: false,
          },
          {
            checkId: 'lint',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
            kind: 'lint',
            command: 'npm run lint',
            exitCode: 0,
            executionMs: 100,
            outputDigest: 'b'.repeat(64),
            timedOut: false,
          },
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
      expect(result.reason).toBe('RUNTIME_VERIFIED_TRIVIAL');
      expect(result.computedMinimumTaskClass).toBe('TRIVIAL');
    });

    it('BAD — missing task class claim keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('TASK_CLASS_CLAIM_MISSING');
    });

    it('BAD — non-TRIVIAL task class claim keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'STANDARD',
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('CLAIMED_CLASS_NOT_TRIVIAL');
    });

    it('BAD — host-task-required review policy keeps full ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const state = {
        ...base,
        policySnapshot: {
          ...base.policySnapshot,
          allowReducedCeremony: true,
          reviewInvocationPolicy: 'host_task_required' as const,
        },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('POLICY_REVIEW_REQUIRED');
    });

    it('BAD — default policy keeps full ceremony even for TRIVIAL evidence', () => {
      const state = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

      const result = resolveCeremonyProfile({ state, changedFiles: ['docs/usage-notes.md'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('POLICY_REDUCED_CEREMONY_DISABLED');
    });

    it('BAD — governance surface escalates to computed HIGH-RISK and blocks reduction', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, allowReducedCeremony: true },
      };

      const result = resolveCeremonyProfile({ state, changedFiles: ['src/security/policy.ts'] });

      expect(result.profile).toBe('full');
      expect(result.reason).toBe('COMPUTED_MINIMUM_NOT_TRIVIAL');
      expect(result.computedMinimumTaskClass).toBe('HIGH-RISK');
    });

    it('BAD — blocked riskGate prevents reduced ceremony', () => {
      const base = makeState('IMPLEMENTATION', {
        claimedTaskClass: 'TRIVIAL',
        riskGate: {
          status: 'blocked',
          code: 'RISK_CLASSIFICATION_MISMATCH',
          message: 'blocked',
          blockedAt: '2026-01-01T00:00:00.000Z',
          lastDecisionId: 'RISK-1',
        },
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'OK',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
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
