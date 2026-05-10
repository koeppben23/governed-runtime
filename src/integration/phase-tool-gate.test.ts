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
  MUTATING_HOST_TOOLS,
  INVESTIGATION_ONLY_PHASES,
} from './phase-tool-gate.js';
import type { Phase } from '../state/schema.js';

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
      it('T10: empty string → false', () => {
        expect(isMutatingHostTool('')).toBe(false);
      });

      it('T11: unknown_tool → false (deny-list, not allow-list)', () => {
        expect(isMutatingHostTool('unknown_tool')).toBe(false);
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

      it('T34: unknown_tool in PLAN → allowed (deny-list only blocks known mutating tools)', () => {
        const result = isHostToolAllowedInPhase('unknown_tool', 'PLAN');
        expect(result.allowed).toBe(true);
      });

      it('T35: empty string tool in PLAN → allowed', () => {
        const result = isHostToolAllowedInPhase('', 'PLAN');
        expect(result.allowed).toBe(true);
      });
    });

    // ── SMOKE — constant set integrity ──────────────────────────────────

    describe('SMOKE — constant set integrity', () => {
      it('T36: MUTATING_HOST_TOOLS contains exactly bash, write, edit', () => {
        expect(MUTATING_HOST_TOOLS.size).toBe(3);
        expect(MUTATING_HOST_TOOLS.has('bash')).toBe(true);
        expect(MUTATING_HOST_TOOLS.has('write')).toBe(true);
        expect(MUTATING_HOST_TOOLS.has('edit')).toBe(true);
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
      const mutatingTools = ['bash', 'write', 'edit'] as const;
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
});
