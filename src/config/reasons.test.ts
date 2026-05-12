import { describe, it, expect } from 'vitest';
import { BlockedReasonRegistry, defaultReasonRegistry, blocked } from '../config/reasons.js';
import { COMMANDS } from '../cli/templates.js';
import { resolveRuntimePolicyMode } from '../config/policy.js';
import { benchmarkSync } from '../test-policy.js';

describe('config/reasons', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('format produces structured result for known code', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
        command: '/plan',
        phase: 'COMPLETE',
      });
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/plan');
      expect(result.reason).toContain('COMPLETE');
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it('blocked() helper returns correct RailBlocked structure', () => {
      const result = blocked('TICKET_REQUIRED', { action: 'planning' });
      expect(result.kind).toBe('blocked');
      expect(result.code).toBe('TICKET_REQUIRED');
      expect(result.reason).toContain('planning');
      expect(result.quickFix).toBe('/ticket');
    });

    it('defaultReasonRegistry has 30+ codes', () => {
      expect(defaultReasonRegistry.size).toBeGreaterThanOrEqual(30);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('format returns generic message for unknown code', () => {
      const result = defaultReasonRegistry.format('TOTALLY_UNKNOWN');
      expect(result.code).toBe('TOTALLY_UNKNOWN');
      expect(result.reason).toContain('TOTALLY_UNKNOWN');
      expect(result.recovery).toEqual([]);
    });

    it('get returns undefined for unknown code', () => {
      expect(defaultReasonRegistry.get('NOPE')).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('format interpolates all {variables}', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
        command: '/implement',
        phase: 'TICKET',
      });
      expect(result.reason).toBe('/implement is not allowed in phase TICKET');
    });

    it('format leaves unknown {variables} as-is', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {});
      expect(result.reason).toContain('{command}');
      expect(result.reason).toContain('{phase}');
    });

    it('registerAll adds multiple reasons', () => {
      const registry = new BlockedReasonRegistry();
      registry.registerAll([
        { code: 'A', category: 'input', messageTemplate: 'A', recoverySteps: [] },
        { code: 'B', category: 'input', messageTemplate: 'B', recoverySteps: [] },
      ]);
      expect(registry.size).toBe(2);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all seed codes have non-empty messageTemplate', () => {
      for (const code of defaultReasonRegistry.codes()) {
        const reason = defaultReasonRegistry.get(code);
        expect(reason?.messageTemplate.length).toBeGreaterThan(0);
      }
    });

    it('blocked() with unknown code and vars.message uses it', () => {
      const result = blocked('CUSTOM_CODE', { message: 'Custom error' });
      expect(result.reason).toBe('Custom error');
    });

    it('codes() returns array of strings', () => {
      const codes = defaultReasonRegistry.codes();
      expect(Array.isArray(codes)).toBe(true);
      expect(codes.length).toBe(defaultReasonRegistry.size);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    const REASON_LOOKUP_MS = 8;
    it(`reason lookup + format < ${REASON_LOOKUP_MS}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
          command: '/plan',
          phase: 'TICKET',
        });
      });
      expect(result.p99Ms).toBeLessThan(REASON_LOOKUP_MS);
    });
  });
});

describe('cli/templates/verification-output-contract', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('/plan template contains ## Verification Plan section', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toContain('## Verification Plan');
    });

    it('/plan template requires Source citation for verification checks', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Source:/i);
    });

    it('/plan template requires NOT_VERIFIED fallback when no candidate available', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/NOT_VERIFIED/i);
      expect(planTemplate).toMatch(/recovery/i);
    });

    it('/plan template requires seven sections', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toContain('## Objective');
      expect(planTemplate).toContain('## Approach');
      expect(planTemplate).toContain('## Steps');
      expect(planTemplate).toContain('## Files to Modify');
      expect(planTemplate).toContain('## Edge Cases');
      expect(planTemplate).toContain('## Validation Criteria');
      expect(planTemplate).toContain('## Verification Plan');
    });

    it('/implement template contains ## Verification Evidence section', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toContain('## Verification Evidence');
    });

    it('/implement template distinguishes Planned checks from Executed checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/Planned checks/i);
      expect(implementTemplate).toMatch(/Executed checks/i);
    });

    it('/implement template requires NOT_VERIFIED for unexecuted checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/NOT_VERIFIED/i);
    });

    it('/review template checks verificationCandidates vs generic command mismatch', () => {
      const reviewTemplate = COMMANDS['review.md'];
      expect(reviewTemplate).toMatch(/verificationCandidates/i);
      expect(reviewTemplate).toMatch(/generic commands/i);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('/plan guards against invented verification commands via Source citation requirement', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Cite Source for each verification check/i);
    });

    it('/plan must NOT use generic commands when candidates exist', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/verificationCandidates/i);
    });

    it('/implement requires listing only actually executed checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/list only checks.*actually executed/i);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('/plan requires source-backed Verification Plan', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Verification Plan cites Source/i);
    });

    it('/implement requires clearly separated Verification Evidence', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/Verification Evidence[\s\S]*distinguishing/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // P32: Runtime Policy Mode Unification
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('P32 Runtime Policy Mode Unification', () => {
    // ─── HAPPY ─────────────────────────────────────────────────
    describe('HAPPY', () => {
      it('state.policySnapshot.mode takes precedence over config', () => {
        const state = {
          policySnapshot: { mode: 'regulated' as const },
        };
        const result = resolveRuntimePolicyMode({
          state,
          configDefaultMode: 'team',
        });
        expect(result).toBe('regulated');
      });

      it('config.defaultMode is used when no state', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('solo is fallback when no state and no config', () => {
        const result = resolveRuntimePolicyMode({});
        expect(result).toBe('solo');
      });

      it('team config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('solo config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'solo',
        });
        expect(result).toBe('solo');
      });

      it('team-ci config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team-ci',
        });
        expect(result).toBe('team-ci');
      });
    });

    // ─── BAD ─────────────────────────────────────────────────
    describe('BAD', () => {
      it('undefined state is handled gracefully', () => {
        const result = resolveRuntimePolicyMode({
          state: undefined,
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('empty policySnapshot is handled', () => {
        const result = resolveRuntimePolicyMode({
          state: { policySnapshot: {} },
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });
    });

    // ─── CORNER ─────────────────────────────────────────────────
    describe('CORNER', () => {
      it('null configDefaultMode falls back to solo', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: undefined,
        });
        expect(result).toBe('solo');
      });

      it('null state falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: undefined,
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });
    });

    // ─── EDGE ─────────────────────────────────────────────────
    describe('EDGE', () => {
      it('empty state object falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: {},
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('state with null mode falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: { policySnapshot: { mode: undefined } },
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('complex state object works', () => {
        const result = resolveRuntimePolicyMode({
          state: {
            policySnapshot: {
              mode: 'regulated',
              requireHumanGates: true,
            },
          },
          configDefaultMode: 'solo',
        });
        expect(result).toBe('regulated');
      });
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('/plan has verification guidance in independent review loop', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/verificationCandidates/i);
    });

    it('/review flags generic command usage as defect', () => {
      const reviewTemplate = COMMANDS['review.md'];
      expect(reviewTemplate).toMatch(/flag this as a defect/i);
    });
  });
});
