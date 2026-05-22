/**
 * @file plugin-risk.test.ts
 * @description Unit tests for plugin-risk.ts risk classification enforcement.
 *
 * Covers 7 exported functions: targetPathsForRisk, currentChangedFilesForRisk,
 * evidenceUnavailableRiskDecision, persistRiskDecisionBlock, appendRiskDecisionAudit,
 * enforceRiskClassificationBefore, enforceRiskClassificationAfterBash.
 *
 * Mock strategy: vi.mock for external module deps (persistence, git, helpers,
 * phase-tool-gate, audit-events). vi.hoisted() provides mock refs above imports.
 * Pure functions tested without mocking.
 *
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockWriteState,
  mockReadState,
  mockChangedFiles,
  mockBuildEnforcementError,
  mockStrictBlockedOutput,
  mockIsRiskClassificationAllowed,
  mockAppendReviewAuditEvent,
} = vi.hoisted(() => ({
  mockWriteState: vi.fn<(...args: unknown[]) => Promise<void>>(),
  mockReadState: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockChangedFiles: vi.fn<(...args: unknown[]) => Promise<string[]>>(),
  mockBuildEnforcementError:
    vi.fn<(code: string, reason: string, detail?: Record<string, unknown>) => Error>(),
  mockStrictBlockedOutput: vi.fn<(code: string, detail: Record<string, string>) => string>(),
  mockIsRiskClassificationAllowed: vi.fn<(input: unknown) => unknown>(),
  mockAppendReviewAuditEvent: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('../adapters/persistence.js', () => ({
  writeState: mockWriteState,
  readState: mockReadState,
}));

vi.mock('../adapters/git.js', () => ({
  changedFiles: mockChangedFiles,
}));

vi.mock('./plugin-helpers.js', () => ({
  buildEnforcementError: mockBuildEnforcementError,
  strictBlockedOutput: mockStrictBlockedOutput,
}));

vi.mock('./phase-tool-gate.js', () => ({
  isRiskClassificationAllowed: mockIsRiskClassificationAllowed,
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: mockAppendReviewAuditEvent,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

import {
  targetPathsForRisk,
  currentChangedFilesForRisk,
  evidenceUnavailableRiskDecision,
  persistRiskDecisionBlock,
  appendRiskDecisionAudit,
  enforceRiskClassificationBefore,
  enforceRiskClassificationAfterBash,
  type RiskEnforcementDeps,
} from './plugin-risk.js';
import type { SessionState } from '../state/schema.js';
import type { RiskClassificationDecision } from './phase-tool-gate.js';
import { makeState } from '../__fixtures__.js';

function mockDeps(overrides: Partial<RiskEnforcementDeps> = {}): RiskEnforcementDeps {
  return {
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess'),
    getWorktreeRoot: vi.fn().mockReturnValue('/tmp/repo'),
    ...overrides,
  };
}

function makeRiskState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('IMPLEMENTATION', {
    policySnapshot: {
      ...makeState('IMPLEMENTATION').policySnapshot,
      enforceRiskClassification: true,
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteState.mockResolvedValue(undefined);
  mockReadState.mockResolvedValue(undefined);
  mockChangedFiles.mockResolvedValue([]);
  mockBuildEnforcementError.mockImplementation((code, reason) => {
    const err = new Error(`${code}: ${reason}`);
    err.name = code;
    return err;
  });
  mockStrictBlockedOutput.mockImplementation(
    (code, detail) => `BLOCKED: ${code} (${JSON.stringify(detail)})`,
  );
  mockIsRiskClassificationAllowed.mockReturnValue({
    allowed: true,
    decisionId: 'risk-ok',
    minimumTaskClass: 'TRIVIAL',
    touchedSurfaces: [],
    changedFiles: [],
  });
  mockAppendReviewAuditEvent.mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// targetPathsForRisk
// ═══════════════════════════════════════════════════════════════════════════════

describe('targetPathsForRisk', () => {
  const getWorktreeRoot = () => '/tmp/repo';

  describe('GOOD', () => {
    it('returns relative path for write tool with filePath inside worktree', () => {
      const result = targetPathsForRisk(
        'write',
        { filePath: '/tmp/repo/src/foo.ts' },
        getWorktreeRoot,
      );
      expect(result).toEqual(['src/foo.ts']);
    });

    it('returns relative path for edit tool with filePath inside worktree', () => {
      const result = targetPathsForRisk(
        'edit',
        { filePath: '/tmp/repo/README.md' },
        getWorktreeRoot,
      );
      expect(result).toEqual(['README.md']);
    });
  });

  describe('CORNER', () => {
    it('returns absolute path when filePath is outside worktree', () => {
      const result = targetPathsForRisk('write', { filePath: '/other/bar.ts' }, getWorktreeRoot);
      expect(result).toEqual(['/other/bar.ts']);
    });

    it('returns empty array for non-file tool (bash)', () => {
      const result = targetPathsForRisk('bash', {}, getWorktreeRoot);
      expect(result).toEqual([]);
    });

    it('returns empty array when filePath is not a string', () => {
      const result = targetPathsForRisk('write', { filePath: 123 }, getWorktreeRoot);
      expect(result).toEqual([]);
    });
  });

  describe('EDGE', () => {
    it('returns absolute path when worktree root is undefined', () => {
      const result = targetPathsForRisk('write', { filePath: '/foo/bar.ts' }, () => undefined);
      expect(result).toEqual(['/foo/bar.ts']);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// currentChangedFilesForRisk
// ═══════════════════════════════════════════════════════════════════════════════

describe('currentChangedFilesForRisk', () => {
  describe('GOOD', () => {
    it('returns changed files from git', async () => {
      mockChangedFiles.mockResolvedValue(['src/a.ts', 'src/b.ts']);
      const result = await currentChangedFilesForRisk(() => '/tmp/repo');
      expect(result).toEqual(['src/a.ts', 'src/b.ts']);
      expect(mockChangedFiles).toHaveBeenCalledWith('/tmp/repo');
    });
  });

  describe('BAD', () => {
    it('throws error when worktree is undefined', async () => {
      mockBuildEnforcementError.mockReturnValue(
        new Error('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE: no worktree'),
      );
      await expect(currentChangedFilesForRisk(() => undefined)).rejects.toThrow(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      );
    });

    it('throws error when git changedFiles fails', async () => {
      mockChangedFiles.mockRejectedValue(new Error('git failed'));
      mockBuildEnforcementError.mockReturnValue(
        new Error('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE: git failed'),
      );
      await expect(currentChangedFilesForRisk(() => '/tmp/repo')).rejects.toThrow(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidenceUnavailableRiskDecision
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidenceUnavailableRiskDecision', () => {
  describe('GOOD', () => {
    it('produces correct blocked decision shape', () => {
      const state = makeRiskState({ claimedTaskClass: 'TRIVIAL' });
      const decision = evidenceUnavailableRiskDecision(state, 'worktree missing');

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
      expect(decision.reason).toBe('worktree missing');
      expect(decision.claimedTaskClass).toBe('TRIVIAL');
      expect(decision.minimumTaskClass).toBe('HIGH-RISK');
      expect(decision.touchedSurfaces).toEqual(['risk-classification-evidence']);
      expect(decision.changedFiles).toEqual([]);
      expect(decision.decisionId).toMatch(/^RISK-\d+-evidence-unavailable$/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// persistRiskDecisionBlock
// ═══════════════════════════════════════════════════════════════════════════════

describe('persistRiskDecisionBlock', () => {
  const state = makeRiskState();
  const decision: RiskClassificationDecision = {
    allowed: false,
    code: 'RISK_X',
    reason: 'blocked',
    decisionId: 'd-1',
    claimedTaskClass: 'STANDARD',
    minimumTaskClass: 'HIGH-RISK',
    touchedSurfaces: ['src/foo.ts'],
    changedFiles: ['src/foo.ts'],
  };

  describe('GOOD', () => {
    it('persists state with riskGate blocked and appends audit', async () => {
      await persistRiskDecisionBlock('/tmp/sess', state, decision, 'RISK_X', 'reason text');

      expect(mockWriteState).toHaveBeenCalledTimes(1);
      const writtenState = mockWriteState.mock.calls[0]![1] as SessionState;
      expect(writtenState.riskGate).toEqual({
        status: 'blocked',
        code: 'RISK_X',
        message: 'reason text',
        blockedAt: expect.any(String),
        lastDecisionId: 'd-1',
      });

      expect(mockAppendReviewAuditEvent).toHaveBeenCalledTimes(1);
      expect(mockAppendReviewAuditEvent.mock.calls[0]![0]).toBe('/tmp/sess');
    });
  });

  describe('BAD', () => {
    it('propagates writeState persistence failure', async () => {
      mockWriteState.mockRejectedValue(new Error('disk full'));
      await expect(
        persistRiskDecisionBlock('/tmp/sess', state, decision, 'RISK_X', 'msg'),
      ).rejects.toThrow('disk full');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// appendRiskDecisionAudit
// ═══════════════════════════════════════════════════════════════════════════════

describe('appendRiskDecisionAudit', () => {
  const state = makeRiskState({ riskGate: { status: 'clear' } as SessionState['riskGate'] });

  describe('GOOD', () => {
    it('appends risk classification audit event with correct detail', async () => {
      const decision: RiskClassificationDecision = {
        allowed: true,
        decisionId: 'd-2',
        minimumTaskClass: 'TRIVIAL',
        touchedSurfaces: [],
        changedFiles: [],
      };

      await appendRiskDecisionAudit(
        '/tmp/sess',
        state,
        decision,
        'allowed',
        'RISK_CLASSIFICATION_ALLOWED',
      );

      expect(mockAppendReviewAuditEvent).toHaveBeenCalledTimes(1);
      const detailArg = mockAppendReviewAuditEvent.mock.calls[0]![4] as Record<string, unknown>;
      expect(detailArg.decision).toBe('allowed');
      expect(detailArg.reasonCode).toBe('RISK_CLASSIFICATION_ALLOWED');
      expect(detailArg.decisionId).toBe('d-2');
      expect(detailArg.riskGateStatus).toBe('clear');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enforceRiskClassificationBefore
// ═══════════════════════════════════════════════════════════════════════════════

describe('enforceRiskClassificationBefore', () => {
  const sessDir = '/tmp/sess';
  const toolName = 'write';
  const args = { filePath: 'src/foo.ts' };

  describe('CORNER', () => {
    it('skips enforcement when enforceRiskClassification is false', async () => {
      const state = makeRiskState({
        policySnapshot: { ...makeRiskState().policySnapshot, enforceRiskClassification: false },
      });
      const deps = mockDeps();

      await enforceRiskClassificationBefore(deps, sessDir, state, toolName, args);
      expect(mockChangedFiles).not.toHaveBeenCalled();
    });
  });

  describe('GOOD', () => {
    it('returns without throw when decision is allowed', async () => {
      const state = makeRiskState();
      const deps = mockDeps();
      mockIsRiskClassificationAllowed.mockReturnValue({
        allowed: true,
        decisionId: 'ok',
        minimumTaskClass: 'TRIVIAL',
        touchedSurfaces: [],
        changedFiles: [],
      });

      await enforceRiskClassificationBefore(deps, sessDir, state, toolName, args);

      expect(mockIsRiskClassificationAllowed).toHaveBeenCalledTimes(1);
      expect(mockAppendReviewAuditEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('BAD', () => {
    it('throws when changedFiles evidence is unavailable and riskGate not already blocked', async () => {
      const state = makeRiskState();
      const deps = mockDeps();
      mockChangedFiles.mockRejectedValue(new Error('git error'));
      mockBuildEnforcementError.mockReturnValue(
        new Error('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE: git error'),
      );

      await expect(
        enforceRiskClassificationBefore(deps, sessDir, state, toolName, args),
      ).rejects.toThrow('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
      expect(mockWriteState).toHaveBeenCalledTimes(1);
    });

    it('throws without re-persisting when riskGate already blocked', async () => {
      const state = makeRiskState({
        riskGate: {
          status: 'blocked',
          code: 'PRIOR',
          message: 'x',
          blockedAt: 'now',
          lastDecisionId: 'old',
        } as SessionState['riskGate'],
      });
      const deps = mockDeps();
      mockChangedFiles.mockRejectedValue(new Error('git error'));
      mockBuildEnforcementError.mockReturnValue(
        new Error('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE: git error'),
      );

      await expect(
        enforceRiskClassificationBefore(deps, sessDir, state, toolName, args),
      ).rejects.toThrow();
      expect(mockWriteState).not.toHaveBeenCalled();
    });

    it('throws with decision code when risk classification blocks', async () => {
      const state = makeRiskState();
      const deps = mockDeps();
      mockIsRiskClassificationAllowed.mockReturnValue({
        allowed: false,
        code: 'RISK_HIGH',
        reason: 'High risk surface',
        decisionId: 'blocked-1',
        minimumTaskClass: 'HIGH-RISK' as const,
        touchedSurfaces: ['src/risk.ts'],
        changedFiles: ['src/risk.ts'],
      });
      mockBuildEnforcementError.mockReturnValue(new Error('RISK_HIGH: High risk surface'));

      await expect(
        enforceRiskClassificationBefore(deps, sessDir, state, toolName, args),
      ).rejects.toThrow('RISK_HIGH');
      expect(mockWriteState).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enforceRiskClassificationAfterBash
// ═══════════════════════════════════════════════════════════════════════════════

describe('enforceRiskClassificationAfterBash', () => {
  const sessionId = 's1';

  describe('CORNER', () => {
    it('returns early when sessDir is null', async () => {
      const deps = mockDeps({ getSessionDir: () => null });
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(mockReadState).not.toHaveBeenCalled();
      expect(output.output).toBeUndefined();
    });

    it('skips enforcement when enforceRiskClassification is false', async () => {
      const state = makeRiskState({
        policySnapshot: { ...makeRiskState().policySnapshot, enforceRiskClassification: false },
      });
      mockReadState.mockResolvedValue(state);
      const deps = mockDeps();
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(mockChangedFiles).not.toHaveBeenCalled();
    });
  });

  describe('BAD', () => {
    it('writes blocked output on readState error', async () => {
      mockReadState.mockRejectedValue(new Error('read error'));
      const deps = mockDeps();
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(output.output).toBeDefined();
      expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        expect.objectContaining({ reason: 'read error' }),
      );
    });

    it('writes blocked output when changedFiles evidence unavailable', async () => {
      const state = makeRiskState();
      mockReadState.mockResolvedValue(state);
      mockChangedFiles.mockRejectedValue(new Error('git error'));
      const deps = mockDeps();
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        expect.objectContaining({ reason: expect.stringContaining('git error') }),
      );
    });
  });

  describe('GOOD', () => {
    it('appends audit when classification is allowed after bash', async () => {
      const state = makeRiskState();
      mockReadState.mockResolvedValue(state);
      mockIsRiskClassificationAllowed.mockReturnValue({
        allowed: true,
        decisionId: 'ok-2',
        minimumTaskClass: 'TRIVIAL',
        touchedSurfaces: [],
        changedFiles: [],
      });
      const deps = mockDeps();
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(mockAppendReviewAuditEvent).toHaveBeenCalledTimes(1);
      expect(output.output).toBeUndefined();
    });

    it('writes blocked output but does NOT throw on mismatch', async () => {
      const state = makeRiskState();
      mockReadState.mockResolvedValue(state);
      mockIsRiskClassificationAllowed.mockReturnValue({
        allowed: false,
        code: 'RISK_MISMATCH',
        reason: 'mismatch after bash',
        decisionId: 'blocked-2',
        minimumTaskClass: 'HIGH-RISK' as const,
        touchedSurfaces: ['src/foo.ts'],
        changedFiles: ['src/foo.ts'],
      });
      const deps = mockDeps();
      const output: { output?: unknown } = {};

      await enforceRiskClassificationAfterBash(deps, sessionId, output);

      expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
        'RISK_MISMATCH',
        expect.objectContaining({ reason: 'mismatch after bash', sessionId }),
      );
      expect(output.output).toBeDefined();
    });
  });
});
