/**
 * @module persistence
 * @description Core atomic file I/O infrastructure for FlowGuard state.
 *
 * This module provides path resolution, atomic writes, error types, and
 * session state + report I/O. Audit, config, discovery, and lock operations
 * have been extracted to domain-aligned sibling modules:
 *   persistence-lock.ts   — session write lock serialization
 *   persistence-audit.ts  — append-only JSONL audit trail
 *   persistence-config.ts — FlowGuard config read/write
 *   persistence-discovery.ts — discovery artifacts and snapshots
 *
 * Config files (read by readConfig, written by writeRepoConfig / writeGlobalConfig):
 *   {worktree}/.opencode/flowguard.json      # Repo-scoped config (takes priority)
 *   ~/.config/opencode/flowguard.json        # Global config (fallback)
 *
 * Session and workspace data (paths resolved by workspace.ts):
 *   ~/.config/opencode/workspaces/{fingerprint}/
 *   +-- workspace.json          # Workspace metadata (managed by workspace.ts)
 *   +-- discovery/              # Business rules etc. (future)
 *   +-- sessions/
 *       +-- {sessionId}/
 *           +-- session-state.json    # Main state (atomic read/write, Zod-validated)
 *           +-- review-report.json    # Latest review report (atomic write)
 *           +-- audit.jsonl           # Append-only audit trail
 *
 * Path resolution is delegated to workspace.ts (SSOT for all path construction).
 * This module receives pre-resolved directory paths (sessionDir, workspaceDir)
 * and performs only file I/O operations within them.
 *
 * Design:
 * - Zod validation on EVERY state write (fail-closed -- never persist invalid state)
 * - Atomic writes: temp file -> rename (safe on NTFS and ext4/xfs)
 * - Auto-creates parent directories on first write
 * - PersistenceError with typed codes for caller error handling
 * - Read returns Zod-parsed objects (schema-validated, new reference)
 *
 * Atomic write pattern:
 *   1. Serialize to JSON
 *   2. Write to {file}.{uuid}.tmp (same directory = same filesystem)
 *   3. Rename to {file} (atomic on NTFS and POSIX)
 *   4. On failure: clean up temp file
 *
 * Why not just writeFile?
 *   A crash mid-write leaves a truncated file. Atomic rename ensures
 *   the file is either fully the old version or fully the new version.
 *   For FlowGuard state in regulated environments, this is non-negotiable.
 *
 * @version v3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { SessionState } from '../state/schema.js';
import { ReviewReport } from '../state/evidence.js';
import { withSessionWriteLock } from './persistence-lock.js';
import { ensureDir, PersistenceError, isEnoent } from './persistence-core.js';

export {
  ensureDir,
  PersistenceError,
  isEnoent,
  type PersistenceErrorCode,
} from './persistence-core.js';

// -- Constants ----------------------------------------------------------------

const STATE_FILE = 'session-state.json';
const REPORT_FILE = 'review-report.json';
const AUDIT_FILE = 'audit.jsonl';
const CONFIG_FILE = 'flowguard.json';

// -- Path Helpers -------------------------------------------------------------

/** Resolve the state file path within a session directory. */
export function statePath(sessionDir: string): string {
  return path.join(sessionDir, STATE_FILE);
}

/** Resolve the review report file path within a session directory. */
export function reportPath(sessionDir: string): string {
  return path.join(sessionDir, REPORT_FILE);
}

/** Resolve the audit trail file path within a session directory. */
export function auditPath(sessionDir: string): string {
  return path.join(sessionDir, AUDIT_FILE);
}

/** Resolve the global config file path (~/.config/opencode/flowguard.json). */
export function globalConfigPath(): string {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
  return path.join(base, CONFIG_FILE);
}

/** Resolve the repo-scoped config file path ({worktree}/.opencode/flowguard.json). */
export function repoConfigPath(worktree: string): string {
  return path.join(worktree, '.opencode', CONFIG_FILE);
}

// -- Error Types --------------------------------------------------------------

// -- Atomic Write -------------------------------------------------------------

/**
 * Rename with retry for Windows EPERM/EBUSY transient failures.
 * Antivirus and file indexers can briefly lock files on NTFS.
 */
async function renameWithRetry(src: string, dest: string, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Write a file atomically: serialize -> temp file -> rename.
 *
 * The temp file is placed in the same directory as the target.
 * This guarantees same-filesystem, which is required for atomic rename
 * on both NTFS (Windows) and POSIX (Linux/macOS).
 *
 * Exported for adapter-internal reuse (evidence-artifacts, archive).
 * Not part of the public FlowGuard API surface.
 *
 * @param filePath - Absolute path to the target file.
 * @param content - String content to write.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore -- temp file may not have been created */
    }
    getAdapterLogger().error('persistence', 'Atomic write failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'WRITE_FAILED',
      `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Write a file atomically and durably: temp file -> fsync -> rename.
 *
 * Exported for adapter-internal write paths that require crash durability in
 * addition to atomic replacement. Does not acquire locks; callers that compose
 * read-modify-write sequences must hold the relevant write lock.
 */
export async function durableAtomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);

  try {
    const handle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      /* temp may not exist or may already have been renamed */
    }
    throw new PersistenceError(
      'WRITE_FAILED',
      `Durable atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// -- State Operations ---------------------------------------------------------

/**
 * Read the session state from {sessionDir}/session-state.json.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns SessionState if file exists and is valid, null if file does not exist.
 * @throws PersistenceError if file exists but cannot be read, parsed, or validated.
 *
 * Note: Zod parse creates a new object (deep copy). The caller gets a fresh
 * reference, never a shared mutable object.
 */
/**
 * Backward-compat migration: the independent-reviewer loop verdict was renamed
 * `'approve'` -> `'accept'` (LoopVerdict) to disambiguate it from the user-gate
 * `ReviewVerdict 'approve'`. Map legacy persisted reviewer verdicts so existing
 * sessions written before the rename stay readable under the new schema.
 *
 * STRICTLY path-scoped to reviewer-loop slots (selfReview/implReview verdicts,
 * reviewFindings[].overallVerdict, and captured invocation evidence). It NEVER
 * touches the user-gate `reviewDecision.verdict` or audit decision verdicts,
 * which legitimately remain `'approve'`. Mutates the freshly-parsed (local) JSON
 * in place and reports whether any value was migrated.
 */
function migrateLegacyReviewerVerdicts(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const acc = { migrated: false };
  const s = json as Record<string, unknown>;
  mapVerdictField(s.selfReview, acc);
  mapVerdictField(s.implReview, acc);
  mapFindingsArray(findingsOf(s.plan), acc);
  mapFindingsArray(findingsOf(s.architecture), acc);
  mapFindingsArray(s.implReviewFindings, acc);
  migrateAssuranceVerdicts(s.reviewAssurance, acc);
  return acc.migrated;
}

function migrateLegacyValidationOutcomes(json: unknown): void {
  if (!json || typeof json !== 'object') return;
  walk(json);
}

function walk(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (
    typeof obj.checkId === 'string' &&
    typeof obj.passed === 'boolean' &&
    typeof obj.executedAt === 'string' &&
    obj.outcome === undefined
  ) {
    obj.outcome = obj.passed ? 'supported' : 'inconclusive';
  }
  for (const v of Object.values(obj)) walk(v);
}

function isLegacyApprove(v: unknown): boolean {
  return v === 'approve';
}

function findingsOf(node: unknown): unknown {
  return node && typeof node === 'object'
    ? (node as Record<string, unknown>).reviewFindings
    : undefined;
}

function mapVerdictField(node: unknown, acc: { migrated: boolean }): void {
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (isLegacyApprove(o.verdict)) {
      o.verdict = 'accept';
      acc.migrated = true;
    }
  }
}

function mapFindingsArray(arr: unknown, acc: { migrated: boolean }): void {
  if (!Array.isArray(arr)) return;
  for (const f of arr) {
    if (
      f &&
      typeof f === 'object' &&
      isLegacyApprove((f as Record<string, unknown>).overallVerdict)
    ) {
      (f as Record<string, unknown>).overallVerdict = 'accept';
      acc.migrated = true;
    }
  }
}

function migrateAssuranceVerdicts(node: unknown, acc: { migrated: boolean }): void {
  if (!node || typeof node !== 'object') return;
  const invocations = (node as Record<string, unknown>).invocations;
  if (!Array.isArray(invocations)) return;
  for (const inv of invocations) {
    if (!inv || typeof inv !== 'object') continue;
    const o = inv as Record<string, unknown>;
    if (isLegacyApprove(o.capturedVerdict)) {
      o.capturedVerdict = 'accept';
      acc.migrated = true;
    }
    const raw = o.capturedRawFindings;
    if (
      raw &&
      typeof raw === 'object' &&
      isLegacyApprove((raw as Record<string, unknown>).overallVerdict)
    ) {
      (raw as Record<string, unknown>).overallVerdict = 'accept';
      acc.migrated = true;
    }
  }
}

const LegacyPlanClaimZ = z
  .object({
    claimId: z.string().uuid(),
    statement: z.string().min(1),
    critical: z.boolean(),
    authoritySectionId: z.string().min(1),
    expectedCheckId: z.string().min(1),
    counterexampleCheckId: z.string().min(1).optional(),
    structuralSurface: z.string().min(1).optional(),
    mutationProfile: z.string().min(1).optional(),
  })
  .strict();

function migrateLegacyPlanClaims(json: unknown): void {
  if (!json || typeof json !== 'object') return;
  const s = json as Record<string, unknown>;
  const plan = s.plan;
  if (!plan || typeof plan !== 'object') return;
  const p = plan as Record<string, unknown>;
  const declarations = p.claimDeclarations;
  if (!declarations || typeof declarations !== 'object') return;
  const d = declarations as Record<string, unknown>;
  const claims = d.claims;
  if (!Array.isArray(claims)) return;

  let hasLegacy = false;
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue;
    const c = claim as Record<string, unknown>;
    if (c.counterexampleCheckId === undefined) continue;

    const parsed = LegacyPlanClaimZ.safeParse(claim);
    if (!parsed.success) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Legacy plan claim failed frozen schema validation: ${parsed.error.message}`,
      );
    }

    hasLegacy = true;
    c.counterexampleRequirement = {
      mode: 'check',
      checkId: c.counterexampleCheckId,
    };
    delete c.counterexampleCheckId;
  }

  if (hasLegacy) {
    delete p.approvalCertificate;
  }
}

// ─── Legacy Assertion Identity Migration ──────────────────────────────────────

const LEGACY_PROVIDER_BY_PREFIX: Readonly<Record<string, string>> = {
  junit: 'junit',
  vitest: 'vitest',
  jest: 'jest',
  pytest: 'pytest',
  go: 'go_test',
  go_test: 'go_test',
};

const LegacyAssertionRequirementZ = z
  .object({
    mode: z.literal('assertion'),
    checkId: z.string().min(1),
    assertionId: z.string().min(1),
  })
  .strict();

const LegacyStructuredAssertionEvidenceZ = z
  .object({
    assertionId: z.string().min(1),
    framework: z.string().min(1),
    status: z.enum(['passed', 'failed', 'errored', 'skipped']),
    testName: z.string(),
    suiteName: z.string().optional(),
    sourceFile: z.string().optional(),
    durationMs: z.number().optional(),
    failure: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
        detailDigest: z.string().optional(),
      })
      .optional(),
  })
  .strict();

function migrateLegacyAssertionIdentities(json: unknown): void {
  if (!json || typeof json !== 'object') return;
  const s = json as Record<string, unknown>;

  migrateClaimDeclarationAssertions(s);
  migrateEvidenceAssertions(s);
}

function migrateClaimDeclarationAssertions(s: Record<string, unknown>): void {
  const plan = s.plan;
  if (!plan || typeof plan !== 'object') return;
  const p = plan as Record<string, unknown>;
  const declarations = p.claimDeclarations;
  if (!declarations || typeof declarations !== 'object') return;
  const d = declarations as Record<string, unknown>;
  const claims = d.claims;
  if (!Array.isArray(claims)) return;

  let hasLegacyAssertion = false;
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue;
    const c = claim as Record<string, unknown>;
    const req = c.counterexampleRequirement;
    if (!req || typeof req !== 'object') continue;
    const r = req as Record<string, unknown>;
    if (r.mode !== 'assertion') continue;
    if (r.assertionId !== undefined && r.assertion !== undefined) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        'Legacy assertion claim has both assertionId and assertion fields',
      );
    }
    if (r.assertionId === undefined) continue;

    const parsed = LegacyAssertionRequirementZ.safeParse(req);
    if (!parsed.success) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Legacy assertion requirement failed frozen schema validation: ${parsed.error.message}`,
      );
    }

    const parts = parsed.data.assertionId.split(':');
    if (parts.length < 2) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Legacy assertionId missing prefix: ${parsed.data.assertionId}`,
      );
    }
    const prefix = parts[0]!;
    const localId = parts.slice(1).join(':');
    const providerId = LEGACY_PROVIDER_BY_PREFIX[prefix];
    if (!providerId) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Unknown legacy assertion prefix '${prefix}:' in ${parsed.data.assertionId}`,
      );
    }

    hasLegacyAssertion = true;
    r.assertion = { providerId, localId };
    delete r.assertionId;
  }

  if (hasLegacyAssertion) {
    delete p.approvalCertificate;
  }
}

function migrateEvidenceAssertions(s: Record<string, unknown>): void {
  const attempts = s.validationAttempts;
  if (!Array.isArray(attempts)) return;

  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object') continue;
    const a = attempt as Record<string, unknown>;
    const result = a.result;
    if (!result || typeof result !== 'object') continue;
    const r = result as Record<string, unknown>;
    const extraction = r.assertionExtraction;
    if (!extraction || typeof extraction !== 'object') continue;
    const e = extraction as Record<string, unknown>;
    if (e.status !== 'extracted') continue;
    const assertions = e.assertions;
    if (!Array.isArray(assertions)) continue;

    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== 'object') continue;
      const asr = assertion as Record<string, unknown>;
      if (asr.assertionId !== undefined && asr.assertion !== undefined) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          'Legacy assertion evidence has both assertionId and assertion fields',
        );
      }
      if (asr.framework !== undefined && asr.providerId !== undefined) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          'Legacy assertion evidence has both framework and providerId fields',
        );
      }
      if (asr.assertionId !== undefined && asr.framework === undefined) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          'Legacy assertion evidence has assertionId but missing framework field',
        );
      }
      if (asr.assertionId === undefined) continue;

      const parsed = LegacyStructuredAssertionEvidenceZ.safeParse(assertion);
      if (!parsed.success) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          `Legacy assertion evidence failed frozen schema validation: ${parsed.error.message}`,
        );
      }

      const parts = parsed.data.assertionId.split(':');
      if (parts.length < 2) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          `Legacy assertionId missing prefix: ${parsed.data.assertionId}`,
        );
      }
      const prefix = parts[0]!;

      const providerId = LEGACY_PROVIDER_BY_PREFIX[prefix];
      if (!providerId) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          `Unknown legacy assertion prefix '${prefix}:' in ${parsed.data.assertionId}`,
        );
      }
      if (providerId !== LEGACY_PROVIDER_BY_PREFIX[parsed.data.framework]) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          `Legacy assertion prefix '${prefix}:' does not match framework '${parsed.data.framework}'`,
        );
      }

      asr.assertion = { providerId, localId: parts.slice(1).join(':') };
      asr.providerId = providerId;
      delete asr.assertionId;
      delete asr.framework;
    }
  }
}

export async function readState(sessionDir: string): Promise<SessionState | null> {
  const filePath = statePath(sessionDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    getAdapterLogger().error('persistence', 'Failed to read state file', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read state file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `State file is not valid JSON: ${filePath}`);
  }

  const migrated = migrateLegacyReviewerVerdicts(json);
  if (migrated) {
    getAdapterLogger().warn(
      'persistence',
      "Migrated legacy reviewer verdict 'approve' -> 'accept' on read",
      { filePath },
    );
  }

  migrateLegacyValidationOutcomes(json);

  migrateLegacyPlanClaims(json);

  migrateLegacyAssertionIdentities(json);

  const result = SessionState.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `State file failed Zod validation: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Write the session state atomically — does NOT acquire the session write lock.
 *
 * Only call from code that already holds {@link withSessionWriteLock}.
 * Prefer {@link writeState} for normal callers.
 *
 * Invariants:
 * 1. Zod-validates BEFORE writing (fail-closed -- invalid state never hits disk)
 * 2. Creates session directory if missing
 * 3. Uses atomic write (temp -> rename)
 * 4. Pretty-prints JSON (2-space indent) for human readability
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param state - SessionState to persist.
 * @throws PersistenceError if validation fails or write fails.
 */
export async function writeStateAlreadyLocked(
  sessionDir: string,
  state: SessionState,
): Promise<void> {
  const result = SessionState.safeParse(state);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + '\n';
  await atomicWrite(statePath(sessionDir), json);
}

/**
 * Write the session state atomically under the session write lock.
 *
 * Acquires the lock, then delegates to {@link writeStateAlreadyLocked}.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param state - SessionState to persist.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds).
 * @throws PersistenceError if validation fails, write fails, or lock times out.
 */
export async function writeState(
  sessionDir: string,
  state: SessionState,
  timeoutMs?: number,
): Promise<void> {
  return withSessionWriteLock(
    sessionDir,
    () => writeStateAlreadyLocked(sessionDir, state),
    timeoutMs,
  );
}

/**
 * Check if a FlowGuard session state file exists.
 * Does NOT validate the file contents.
 *
 * @param sessionDir - Absolute path to the session directory.
 */
export async function stateExists(sessionDir: string): Promise<boolean> {
  try {
    await fs.access(statePath(sessionDir));
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return false;
    getAdapterLogger().warn('persistence', 'Failed to check state existence', {
      filePath: statePath(sessionDir),
      code: code ?? 'unknown',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// -- Report Operations --------------------------------------------------------

/**
 * Write a review report atomically.
 * Same guarantees as writeState: Zod-validated, atomic, pretty-printed.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param report - ReviewReport to persist.
 */
export async function writeReport(sessionDir: string, report: ReviewReport): Promise<void> {
  const result = ReviewReport.safeParse(report);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid report: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + '\n';
  await atomicWrite(reportPath(sessionDir), json);
}

/**
 * Read the latest review report. Returns null if none exists.
 *
 * @param sessionDir - Absolute path to the session directory.
 */
export async function readReport(sessionDir: string): Promise<ReviewReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath(sessionDir), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    getAdapterLogger().error('persistence', 'Failed to read report file', {
      filePath: reportPath(sessionDir),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read report: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `Report file is not valid JSON`);
  }

  const result = ReviewReport.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Report file failed Zod validation: ${result.error.message}`,
    );
  }

  return result.data;
}
