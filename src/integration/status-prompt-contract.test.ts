import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { status } from './tools/index.js';
import { writeState } from '../adapters/persistence.js';
import { makeProgressedState } from '../fixtures.js';
import type { Phase } from '../state/schema.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

type CallShape = 'full' | 'whyBlocked' | 'evidence' | 'context' | 'readiness';

interface StatusContractEntry {
  readonly label: string;
  readonly phases: readonly Phase[] | '*';
  readonly callShape: CallShape;
  readonly requiredTopLevel: readonly string[];
  readonly requiredPaths?: readonly string[];
  readonly phaseGatedTopLevel?: ReadonlyArray<{ field: string; phases: readonly Phase[] }>;
}

const STATUS_CONTRACT: readonly StatusContractEntry[] = [
  {
    label: '/ticket',
    phases: ['READY', 'TICKET'],
    callShape: 'full',
    requiredTopLevel: ['phase', 'nextAction'],
  },
  {
    label: '/plan',
    phases: ['TICKET', 'PLAN'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'hasTicket',
      'verificationCandidates',
      'profileRules',
      'detectedStack',
      'discoveryHealth',
      'discoveryDrift',
    ],
  },
  {
    label: '/implement',
    phases: ['IMPLEMENTATION'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'hasPlan',
      'profileRules',
      'detectedStack',
      'verificationCandidates',
      'validationResults',
    ],
  },
  {
    label: '/validate',
    phases: ['VALIDATION'],
    callShape: 'full',
    requiredTopLevel: ['phase', 'activeChecks', 'verificationCandidates'],
    phaseGatedTopLevel: [{ field: 'remainingChecks', phases: ['VALIDATION'] }],
  },
  {
    label: '/review-decision',
    phases: ['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'],
    callShape: 'full',
    requiredTopLevel: ['phase'],
  },
  {
    label: '/review',
    phases: ['READY'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'discoveryHealth',
      'discoveryDrift',
      'detectedStack',
      'verificationCandidates',
    ],
  },
  {
    label: '/architecture',
    phases: ['READY', 'ARCHITECTURE'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'detectedStack',
      'verificationCandidates',
      'discoveryHealth',
      'discoveryDrift',
    ],
  },
  {
    label: '/archive',
    phases: ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE', 'IMPL_REVIEW'],
    callShape: 'full',
    requiredTopLevel: ['phase'],
  },
  { label: '/abort', phases: '*', callShape: 'full', requiredTopLevel: ['phase'] },
  {
    label: '/why',
    phases: '*',
    callShape: 'whyBlocked',
    requiredTopLevel: ['whyBlocked'],
    requiredPaths: [
      'whyBlocked.reasonText',
      'whyBlocked.reasonCode',
      'whyBlocked.nextResolvableCommand',
    ],
  },
];

const CHECK_ENTRY: StatusContractEntry = {
  label: '/check',
  phases: ['VALIDATION'],
  callShape: 'full',
  requiredTopLevel: ['activeChecks', 'verificationCandidates'],
  phaseGatedTopLevel: [{ field: 'remainingChecks', phases: ['VALIDATION'] }],
};

const ALL_PHASES: readonly Phase[] = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'REVIEW',
  'REVIEW_COMPLETE',
];

describe('status-prompt-contract', () => {
  let ws: TestWorkspace;
  let ctx: TestToolContext;
  let cleanupEnv: () => void;

  beforeEach(async () => {
    cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
  });

  afterEach(async () => {
    cleanupEnv();
    await ws.cleanup();
  });

  async function statusFor(phase: Phase, callShape: CallShape): Promise<Record<string, unknown>> {
    const { computeFingerprint, sessionDir } = await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    await writeState(sessionDir(fp.fingerprint, ctx.sessionID), makeProgressedState(phase));
    const args = callShape === 'full' ? {} : ({ [callShape]: true } as Record<string, boolean>);
    return parseToolResult(await status.execute(args, ctx));
  }

  function hasPath(obj: Record<string, unknown>, dottedPath: string): boolean {
    let current: unknown = obj;
    for (const part of dottedPath.split('.')) {
      if (current === null || typeof current !== 'object' || !(part in current)) return false;
      current = (current as Record<string, unknown>)[part];
    }
    return current !== undefined;
  }

  for (const entry of [...STATUS_CONTRACT, CHECK_ENTRY]) {
    const phases = entry.phases === '*' ? ALL_PHASES : entry.phases;
    it(`${entry.label}: status (${entry.callShape}) emits required fields in all allowed phases`, async () => {
      expect(phases.length).toBeGreaterThan(0);
      for (const phase of phases) {
        const result = await statusFor(phase, entry.callShape);
        for (const field of entry.requiredTopLevel) {
          expect(
            field in result,
            `${entry.label} reads top-level "${field}" but status(${entry.callShape}) in ${phase} did not emit it`,
          ).toBe(true);
        }
        for (const path of entry.requiredPaths ?? []) {
          expect(
            hasPath(result, path),
            `${entry.label} reads "${path}" but status(${entry.callShape}) in ${phase} did not emit it`,
          ).toBe(true);
        }
        for (const gated of entry.phaseGatedTopLevel ?? []) {
          if (gated.phases.includes(phase)) {
            expect(
              gated.field in result,
              `${entry.label} reads "${gated.field}" in ${phase} but status(${entry.callShape}) did not emit it`,
            ).toBe(true);
          }
        }
      }
    });
  }

  it('NEGATIVE CONTROL: a made-up field is absent from full status (guard is sharp)', async () => {
    expect('madeUpFieldThatNoPromptReads' in (await statusFor('VALIDATION', 'full'))).toBe(false);
  });

  it('Gap B: focused whyBlocked has no top-level "blocker" (reason is under whyBlocked.*)', async () => {
    const result = await statusFor('VALIDATION', 'whyBlocked');
    expect('blocker' in result).toBe(false);
    expect(hasPath(result, 'whyBlocked.reasonText')).toBe(true);
  });
});
