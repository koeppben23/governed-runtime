/**
 * @module integration/test-helpers
 * @description Shared test infrastructure for integration and E2E tests.
 *
 * Provides:
 * - TestToolContext: structural type matching the internal ToolContext in tools.ts
 * - createToolContext(): factory for building tool execution contexts
 * - createTestWorkspace(): tmpDir + OPENCODE_CONFIG_DIR setup with cleanup
 * - isTarAvailable(): capability gate for archive tests
 * - GIT_MOCK_DEFAULTS: default return values for git adapter mocks
 * - parseToolResult(): parse JSON tool output into typed object
 *
 * Design:
 * - TestToolContext is defined structurally (not imported from tools.ts).
 *   This keeps the production API surface unchanged.
 * - All filesystem operations use real temp directories with OPENCODE_CONFIG_DIR
 *   redirection, following the pattern established in workspace.test.ts.
 * - Git adapter functions (remoteOriginUrl, changedFiles, listRepoSignals) are
 *   expected to be mocked via vi.mock() at the test-file level. This module
 *   provides only the default values, not the mock setup itself.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import type { ReviewFindings, ReviewObligationType } from '../state/evidence.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  findLatestObligation,
  hashFindings,
  hashText,
} from './review-assurance.js';

// ─── Safety Guards ───────────────────────────────────────────────────────────

/**
 * Assert that OPENCODE_CONFIG_DIR is set and points to a temporary directory.
 *
 * Tests that mutate workspace state MUST run with an isolated config root.
 * This guard prevents accidental writes to the production workspace registry
 * (~/.config/opencode/workspaces/) during test execution.
 *
 * Uses path.relative against the resolved OS temp root, not a substring check.
 *
 * Called automatically by createTestWorkspace() after redirecting the env var.
 * Can also be called explicitly in tests that spawn child processes.
 *
 * @throws Error if OPENCODE_CONFIG_DIR is unset or not under os.tmpdir().
 */
export function assertTestConfigDir(): void {
  const dir = process.env.OPENCODE_CONFIG_DIR;
  if (!dir) {
    throw new Error(
      `Unsafe OPENCODE_CONFIG_DIR for test: <unset>. ` +
        `Tests must redirect workspace operations via createTestWorkspace().`,
    );
  }
  const tmpRoot = path.resolve(os.tmpdir());
  const resolvedDir = path.resolve(dir);
  if (resolvedDir === tmpRoot) return;
  const rel = path.relative(tmpRoot, resolvedDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Unsafe OPENCODE_CONFIG_DIR for test: ${resolvedDir} must be under temp directory ${tmpRoot}. ` +
        `Tests must redirect workspace operations via createTestWorkspace().`,
    );
  }
}

// ─── Tool Context ────────────────────────────────────────────────────────────

/**
 * Structural type matching the internal ToolContext in tools.ts.
 *
 * Defined here (not exported from tools.ts) to avoid widening the
 * production API surface for test purposes.
 *
 * Fields match tools.ts lines 65-73 exactly.
 */
export interface TestToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

/**
 * Create a ToolContext for test use.
 *
 * Provides sensible defaults for all fields. Override any field via the
 * `overrides` parameter. `worktree` and `directory` should typically be
 * set to the test's tmpDir.
 *
 * @param overrides - Partial overrides for any context field.
 */
export function createToolContext(overrides: Partial<TestToolContext> = {}): TestToolContext {
  return {
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    messageID: 'msg-test-1',
    agent: 'test-agent',
    directory: overrides.worktree ?? '/tmp/test-dir',
    worktree: '/tmp/test-worktree',
    abort: new AbortController().signal,
    metadata: () => {},
    ...overrides,
  };
}

// ─── Test Workspace Setup ────────────────────────────────────────────────────

/**
 * Result of createTestWorkspace().
 * Provides the tmpDir path and a cleanup function that restores env state.
 */
export interface TestWorkspace {
  /** Absolute path to the temp directory (used as OPENCODE_CONFIG_DIR). */
  tmpDir: string;
  /** Restore OPENCODE_CONFIG_DIR and remove tmpDir. */
  cleanup: () => Promise<void>;
}

/**
 * Create a temp directory and set OPENCODE_CONFIG_DIR to redirect all
 * workspace registry operations into it.
 *
 * Call `cleanup()` in afterEach to restore the original env and remove
 * the temp directory.
 *
 * Pattern follows workspace.test.ts.
 */
export async function createTestWorkspace(): Promise<TestWorkspace> {
  const originalEnv = process.env.OPENCODE_CONFIG_DIR;
  const originalGuard = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-integ-'));
  process.env.OPENCODE_CONFIG_DIR = tmpDir;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  assertTestConfigDir();

  // Make tmpDir look like a real worktree so the plugin's `isUsableWorktree`
  // check (fail-closed: rejects non-repo paths to avoid creating rogue
  // workspace folders) accepts it. Tests that pass `worktree: ws.tmpDir` to
  // the plugin rely on this marker.
  await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

  return {
    tmpDir,
    cleanup: async () => {
      // Restore env
      if (originalEnv !== undefined) {
        process.env.OPENCODE_CONFIG_DIR = originalEnv;
      } else {
        delete process.env.OPENCODE_CONFIG_DIR;
      }
      if (originalGuard !== undefined) {
        process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalGuard;
      } else {
        delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
      }
      // Best-effort removal (Windows file locks may prevent full cleanup)
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    },
  };
}

// ─── Tar Capability Gate ─────────────────────────────────────────────────────

let tarAvailableCache: boolean | null = null;

/**
 * Check whether system `tar` is available.
 *
 * Result is cached after first call. Use with vitest's `it.skipIf()`:
 *
 *   const tarOk = await isTarAvailable();
 *   it.skipIf(!tarOk)("creates tar.gz archive", async () => { ... });
 */
export async function isTarAvailable(): Promise<boolean> {
  if (tarAvailableCache !== null) return tarAvailableCache;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('tar', ['--version'], {
      timeout: 5_000,
      windowsHide: true,
    });
    tarAvailableCache = true;
  } catch {
    tarAvailableCache = false;
  }

  return tarAvailableCache;
}

// ─── Git Mock Defaults ───────────────────────────────────────────────────────

/**
 * Default return values for mocked git adapter functions.
 *
 * Usage in test files:
 *
 *   vi.mock("../adapters/git", async (importOriginal) => {
 *     const original = await importOriginal<typeof import("../adapters/git.js")>();
 *     return {
 *       ...original,
 *       remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
 *       changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
 *       listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
 *     };
 *   });
 *
 * Override per-test:
 *   vi.mocked(remoteOriginUrl).mockResolvedValueOnce(null); // repo without remote
 */
export const GIT_MOCK_DEFAULTS = {
  /** Standard HTTPS remote — produces a deterministic fingerprint. */
  remoteOriginUrl: 'https://github.com/test/repo.git',
  /** Standard set of changed files for implement tool tests. */
  changedFiles: ['src/foo.ts', 'src/bar.ts'],
  /**
   * Standard repo signals — triggers TypeScript profile detection.
   * Must match the RepoSignals shape returned by the real listRepoSignals().
   */
  repoSignals: {
    files: ['tsconfig.json', 'package.json', 'src/index.ts'],
    packageFiles: ['package.json'],
    configFiles: ['tsconfig.json'],
  },
} as const;

// ─── Tool Result Parsing ─────────────────────────────────────────────────────

/**
 * Parse a JSON tool result string into a typed object.
 *
 * Tools always return `Promise<string>` containing JSON.
 * This helper parses it and provides a typed view for assertions.
 *
 * @throws if the string is not valid JSON (indicates a tool bug).
 */
export function parseToolResult<T = Record<string, unknown>>(jsonStr: string): T {
  // Tool output may include a "\nNext action: ..." footer after the JSON.
  // JSON.stringify never produces literal newlines, so the first \n is the boundary.
  const idx = jsonStr.indexOf('\n');
  const jsonPart = idx >= 0 ? jsonStr.slice(0, idx) : jsonStr;
  return JSON.parse(jsonPart) as T;
}

/**
 * Common shape of a successful tool result.
 * Tools may include additional fields beyond these.
 */
export interface ToolSuccessResult {
  phase: string;
  status: string;
  next?: string;
  _audit?: {
    transitions: Array<{
      from: string;
      to: string;
      event: string;
      at: string;
    }>;
  };
}

/**
 * Common shape of a blocked/error tool result.
 */
export interface ToolBlockedResult {
  error: true;
  code: string;
  message: string;
  recovery?: string[];
  quickFix?: string;
}

/**
 * Type guard: check if a parsed tool result is an error/blocked response.
 */
export function isBlockedResult(result: Record<string, unknown>): boolean {
  return result.error === true && typeof result.code === 'string';
}

/**
 * Fulfill a strict independent-review obligation in tool execution tests.
 *
 * Production fulfillment is performed by the OpenCode plugin orchestrator. Direct
 * tool tests do not run plugin hooks, so they use this helper to set the same
 * mandate-bound evidence before submitting ReviewFindings to the tool.
 */
export async function fulfillStrictReviewObligation(
  sessDir: string,
  input: {
    obligationType: ReviewObligationType;
    iteration: number;
    planVersion: number;
    overallVerdict?: 'approve' | 'changes_requested';
    childSessionId?: string;
  },
): Promise<ReviewFindings> {
  const state = await readState(sessDir);
  if (!state) throw new Error('No test session state found');

  const assurance = state.reviewAssurance ?? { obligations: [], invocations: [] };
  const obligation = findLatestObligation(
    assurance.obligations,
    input.obligationType,
    input.iteration,
    input.planVersion,
  );
  if (!obligation) throw new Error('No matching review obligation found');

  const findings: ReviewFindings = {
    iteration: input.iteration,
    planVersion: input.planVersion,
    reviewMode: 'subagent',
    overallVerdict: input.overallVerdict ?? 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: input.childSessionId ?? `ses_${input.obligationType}_reviewer` },
    reviewedAt: new Date().toISOString(),
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligation.obligationId,
      iteration: input.iteration,
      planVersion: input.planVersion,
      reviewedBy: 'flowguard-reviewer',
    },
  };

  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: input.obligationType,
    parentSessionId: 'ses_test_parent',
    childSessionId: findings.reviewedBy.sessionId,
    promptHash: hashText(`${input.obligationType}:${input.iteration}:${input.planVersion}`),
    findingsHash: hashFindings(findings),
    invokedAt: new Date().toISOString(),
    fulfilledAt: new Date().toISOString(),
  });

  await writeState(sessDir, {
    ...state,
    reviewAssurance: {
      obligations: assurance.obligations.map((item) =>
        item.obligationId === obligation.obligationId
          ? {
              ...item,
              pluginHandshakeAt: new Date().toISOString(),
              status: 'fulfilled' as const,
              invocationId: invocation.invocationId,
              fulfilledAt: new Date().toISOString(),
            }
          : item,
      ),
      invocations: [...assurance.invocations, invocation],
    },
  });

  return findings;
}

/**
 * Add strict subagent ReviewFindings to direct tool-test verdict calls.
 *
 * Production evidence is injected by plugin hooks. Direct integration tests call
 * tools without those hooks, so tests that drive unrelated lifecycle behavior
 * use this helper to satisfy the same strict obligation contract.
 */
export async function withStrictReviewFindings(sessDir: string, args: unknown): Promise<unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (record.reviewFindings) return args;

  const planVerdict = record.selfReviewVerdict;
  const implVerdict = record.reviewVerdict;
  const verdict = planVerdict ?? implVerdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested') return args;

  const state = await readState(sessDir);
  if (!state) return args;

  // F13 slice 7c: selfReviewVerdict is shared between plan and architecture
  // tools. Distinguish by inspecting the active obligation: if a pending
  // architecture obligation exists, route as 'architecture'; otherwise
  // default to 'plan'. The reviewVerdict path remains 'implement'.
  const allObligations = state.reviewAssurance?.obligations ?? [];
  const findPending = (type: ReviewObligationType) =>
    [...allObligations]
      .reverse()
      .find(
        (item) =>
          item.obligationType === type &&
          item.status !== 'consumed' &&
          item.consumedAt == null,
      );

  let obligationType: ReviewObligationType;
  let obligation;
  if (planVerdict) {
    const archPending = findPending('architecture');
    if (archPending) {
      obligationType = 'architecture';
      obligation = archPending;
    } else {
      obligationType = 'plan';
      obligation = findPending('plan');
    }
  } else {
    obligationType = 'implement';
    obligation = findPending('implement');
  }
  if (!obligation) return args;

  const reviewFindings = await fulfillStrictReviewObligation(sessDir, {
    obligationType,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    overallVerdict: verdict,
  });

  return { ...record, reviewFindings };
}
