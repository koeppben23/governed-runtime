/**
 * @module workspace/upgrade-preflight
 * @description Read-only pre-upgrade preflight read model.
 *
 * Answers exactly one question for the current workspace: must it be cleaned
 * up before a hard-cut upgrade? It inventories every session directory
 * (including sessions without an audit trail) and every archive, and
 * classifies them against the current contracts. It never migrates, re-seals,
 * or fully verifies archives — full integrity verification stays with
 * `verifyArchive`, and historical archives never block upgrade readiness.
 *
 * The caller passes the canonically resolved workspace identity; a resolvable
 * worktree without an initialized FlowGuard workspace fails closed instead of
 * reporting an empty inventory, and prior workspace evidence under a different
 * fingerprint (identity change) blocks instead of being silently skipped.
 *
 * @version v3
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyChain } from '../../audit/integrity.js';
import { ARCHIVE_MANIFEST_SCHEMA_VERSION, ArchiveManifestSchema } from '../../archive/types.js';
import { TERMINAL } from '../../machine/topology.js';
import type { SessionState } from '../../state/schema.js';
import { auditPath, readState, repoConfigPath } from '../persistence.js';
import { readAuditTrail } from '../persistence-audit.js';
import { inspectArchiveTar, readArchiveTextMember } from './archive-tar.js';
import { ARCHIVE_MANIFEST_FILE } from './archive-layout.js';
import { sessionDir, workspaceDir } from './init.js';
import { scanWorktreeWorkspaces } from './upgrade-preflight-identity.js';
import { validateSessionId } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type UpgradeFindingSeverity = 'blocker' | 'warning';

export interface UpgradeCheckFinding {
  readonly severity: UpgradeFindingSeverity;
  readonly code: string;
  readonly message: string;
  readonly recovery?: readonly string[];
}

export type LiveStateStatus = 'ok' | 'incompatible' | 'unreadable' | 'missing';
export type LiveAuditStatus = 'ok' | 'invalid' | 'unreadable' | 'missing';
export type ArchiveContractStatus = 'compatible' | 'incompatible' | 'invalid' | 'unknown';
export type ArchiveExtractable = 'yes' | 'no';

export interface SessionCheckEntry {
  readonly sessionId: string;
  readonly state: LiveStateStatus;
  readonly phase: string | null;
  readonly terminal: boolean | null;
  readonly audit: LiveAuditStatus;
  readonly findings: readonly UpgradeCheckFinding[];
}

export interface ArchiveCheckEntry {
  readonly file: string;
  readonly sessionId: string | null;
  readonly extractable: ArchiveExtractable;
  readonly currentContract: ArchiveContractStatus;
  readonly findings: readonly UpgradeCheckFinding[];
}

export interface UpgradeCheckReport {
  readonly scope: 'workspace';
  /** `null` only on the fail-closed WORKSPACE_UNRESOLVED path. */
  readonly workspaceFingerprint: string | null;
  readonly upgradeReady: boolean;
  readonly summary: {
    readonly sessions: number;
    readonly archives: number;
    readonly blockers: number;
    readonly warnings: number;
  };
  readonly sessions: readonly SessionCheckEntry[];
  readonly archives: readonly ArchiveCheckEntry[];
  /** Top-level findings for reports that fail before per-session discovery. */
  readonly findings?: readonly UpgradeCheckFinding[];
}

/** Canonically resolved workspace identity (worktree root + fingerprint). */
export interface WorkspaceIdentity {
  readonly fingerprint: string;
  readonly worktreeRoot: string;
  readonly normalizedRoot: string;
}

export type UpgradePreflightResult =
  | { readonly kind: 'ok'; readonly report: UpgradeCheckReport }
  | { readonly kind: 'inventory-unreadable'; readonly detail: string }
  | { readonly kind: 'workspace-not-initialized'; readonly detail: string }
  | { readonly kind: 'workspace-identity-changed'; readonly detail: string };

// ─── Pure classification ─────────────────────────────────────────────────────

/**
 * Combine manifest and audit-admissibility into one archive contract status.
 * Integrity under the current contract (`invalid`) outranks expected legacy
 * incompatibility (`incompatible`); anything not fully assessed is `unknown`.
 */
export function combineArchiveContract(
  manifest: ArchiveContractStatus,
  audit: ArchiveContractStatus,
): ArchiveContractStatus {
  const statuses = [manifest, audit];
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('incompatible')) return 'incompatible';
  if (statuses.every((status) => status === 'compatible')) return 'compatible';
  return 'unknown';
}

/** Classify a manifest member read against the current archive contract. */
export function classifyManifestMember(
  member: { readonly kind: 'ok'; readonly content: string } | { readonly kind: 'blocked' },
): ArchiveContractStatus {
  if (member.kind !== 'ok') return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(member.content);
  } catch {
    return 'unknown';
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== ARCHIVE_MANIFEST_SCHEMA_VERSION
  ) {
    return 'incompatible';
  }
  return ArchiveManifestSchema.safeParse(parsed).success ? 'compatible' : 'invalid';
}

/** Classify an archived audit member against the current audit contract. */
export function classifyAuditMember(
  member: { readonly kind: 'ok'; readonly content: string } | { readonly kind: 'blocked' },
): ArchiveContractStatus {
  if (member.kind !== 'ok') return 'unknown';
  const records = parseJsonLines(member.content);
  if (records === null) return 'unknown';
  const chain = verifyChain(records);
  if (chain.valid) return 'compatible';
  return chain.reason === 'AUDIT_ENVELOPE_INVALID' ? 'incompatible' : 'invalid';
}

function parseJsonLines(raw: string): Record<string, unknown>[] | null {
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    records.push(value as Record<string, unknown>);
  }
  return records;
}

// ─── Live session classification ─────────────────────────────────────────────

interface LiveStateClassification {
  readonly status: LiveStateStatus;
  readonly phase: string | null;
  readonly terminal: boolean | null;
  readonly findings: readonly UpgradeCheckFinding[];
}

async function classifyLiveState(
  sessDir: string,
  sessionId: string,
): Promise<LiveStateClassification> {
  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'UNKNOWN';
    const status: LiveStateStatus =
      code === 'SESSION_STATE_INCOMPATIBLE' ? 'incompatible' : 'unreadable';
    return {
      status,
      phase: null,
      terminal: null,
      findings: [
        {
          severity: 'blocker',
          code: `STATE_${status.toUpperCase()}`,
          message: `Session ${sessionId} state cannot be read under the current contract (${code}).`,
          recovery: [
            'Recover the session with the release that wrote it: complete active sessions normally.',
            'Archive terminal sessions only when the archive preflight permits it; preserve aborted or otherwise non-exportable evidence unchanged.',
            'Do not edit persisted state to bridge the contract boundary.',
          ],
        },
      ],
    };
  }

  if (state === null) return { status: 'missing', phase: null, terminal: null, findings: [] };

  const terminal = TERMINAL.has(state.phase);
  const findings: UpgradeCheckFinding[] = terminal
    ? []
    : [
        {
          severity: 'blocker',
          code: 'ACTIVE_SESSION',
          message: `Session ${sessionId} is active in phase ${state.phase}.`,
          recovery: [
            'Complete the session with the currently installed version; archiving requires a terminal phase.',
            'Then run the upgrade.',
          ],
        },
      ];
  return { status: 'ok', phase: state.phase, terminal, findings };
}

async function classifyLiveAudit(
  sessDir: string,
  sessionId: string,
  state: LiveStateClassification,
): Promise<{
  readonly status: LiveAuditStatus;
  readonly findings: readonly UpgradeCheckFinding[];
}> {
  if (!existsSync(auditPath(sessDir))) {
    return { status: 'missing', findings: auditMissingFindings(sessionId, state) };
  }

  const findings: UpgradeCheckFinding[] = [];
  if (state.status === 'missing') {
    findings.push({
      severity: 'blocker',
      code: 'STATE_MISSING_WITH_AUDIT',
      message: `Session ${sessionId} has an audit trail but no readable state.`,
      recovery: [
        'Restore the missing session state from a matching backup if one exists.',
        'Otherwise preserve the audit trail as evidence and document the unresolved blocker; do not fabricate state.',
      ],
    });
  }

  try {
    const chain = verifyChain(await readAuditTrail(sessDir));
    if (chain.valid) return { status: 'ok', findings };
    return {
      status: 'invalid',
      findings: [
        ...findings,
        {
          severity: 'blocker',
          code: 'AUDIT_INVALID',
          message: `Session ${sessionId} live audit trail is not admissible (${chain.reason ?? 'invalid'}).`,
          recovery: ['Inspect the audit trail with the currently installed version.'],
        },
      ],
    };
  } catch (error) {
    return {
      status: 'unreadable',
      findings: [
        ...findings,
        {
          severity: 'blocker',
          code: 'AUDIT_UNREADABLE',
          message: `Session ${sessionId} live audit trail cannot be read: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        },
      ],
    };
  }
}

function auditMissingFindings(
  sessionId: string,
  state: LiveStateClassification,
): readonly UpgradeCheckFinding[] {
  if (state.status === 'missing') {
    return [
      {
        severity: 'warning',
        code: 'EMPTY_SESSION_DIR',
        message: `Session directory ${sessionId} contains neither state nor audit trail.`,
      },
    ];
  }
  if (state.status === 'ok' && state.terminal === true) {
    return [
      {
        severity: 'warning',
        code: 'AUDIT_MISSING',
        message: `Session ${sessionId} has no audit trail.`,
        recovery: [
          'Verify whether this session keeps evidence that must be preserved before the upgrade.',
        ],
      },
    ];
  }
  return [];
}

async function checkSession(fingerprint: string, sessionId: string): Promise<SessionCheckEntry> {
  const sessDir = sessionDir(fingerprint, sessionId);
  const state = await classifyLiveState(sessDir, sessionId);
  const audit = await classifyLiveAudit(sessDir, sessionId, state);
  return {
    sessionId,
    state: state.status,
    phase: state.phase,
    terminal: state.terminal,
    audit: audit.status,
    findings: [...state.findings, ...audit.findings],
  };
}

// ─── Archive classification ──────────────────────────────────────────────────

/**
 * Confirm the session root from the tar contents. The file name is only a
 * hint: `regulated-<sid>.tar.gz` is ambiguous when a session id itself starts
 * with `regulated-`, so both candidates are tested. Extractability requires at
 * least one safely confirmed root; no confirmed root is `no` (a warning, never
 * a blocker), and more than one is an ambiguous mapping.
 */
async function confirmArchiveSessionRoot(
  archivePath: string,
  file: string,
): Promise<{ sessionId: string | null; extractable: ArchiveExtractable }> {
  const base = file.endsWith('.tar.gz') ? file.slice(0, -'.tar.gz'.length) : file;
  const candidates = base.startsWith('regulated-')
    ? [base, base.slice('regulated-'.length)]
    : [base];

  const okCandidates: string[] = [];
  for (const candidate of candidates) {
    const inspection = await inspectArchiveTar(archivePath, candidate);
    if (inspection.kind === 'ok') okCandidates.push(candidate);
  }
  return {
    sessionId: okCandidates.length === 1 ? (okCandidates[0] ?? null) : null,
    extractable: okCandidates.length >= 1 ? 'yes' : 'no',
  };
}

async function classifyArchiveContractMembers(
  archivePath: string,
  sessionId: string,
): Promise<ArchiveContractStatus> {
  const manifest = classifyManifestMember(
    await readArchiveTextMember(archivePath, sessionId, `${sessionId}/${ARCHIVE_MANIFEST_FILE}`),
  );
  const audit = classifyAuditMember(
    await readArchiveTextMember(archivePath, sessionId, `${sessionId}/audit/audit.jsonl`),
  );
  return combineArchiveContract(manifest, audit);
}

const ARCHIVE_CONTRACT_FINDING_CODES: Readonly<
  Record<Exclude<ArchiveContractStatus, 'compatible'>, string>
> = {
  incompatible: 'ARCHIVE_CONTRACT_INCOMPATIBLE',
  invalid: 'ARCHIVE_CONTRACT_INVALID',
  unknown: 'ARCHIVE_CONTRACT_UNKNOWN',
};

async function checkArchive(archiveDir: string, file: string): Promise<ArchiveCheckEntry> {
  const archivePath = join(archiveDir, file);
  const { sessionId, extractable } = await confirmArchiveSessionRoot(archivePath, file);
  const findings: UpgradeCheckFinding[] = [];

  if (extractable === 'no') {
    findings.push({
      severity: 'warning',
      code: 'ARCHIVE_UNREADABLE',
      message: `Archive ${file} has no safely confirmed session root (unreadable, unsafe, or non-regular members).`,
    });
    return { file, sessionId: null, extractable, currentContract: 'unknown', findings };
  }
  if (sessionId === null) {
    findings.push({
      severity: 'warning',
      code: 'ARCHIVE_MAPPING_UNKNOWN',
      message: `Archive ${file} cannot be unambiguously mapped to a session root.`,
    });
    return { file, sessionId: null, extractable, currentContract: 'unknown', findings };
  }

  const currentContract = await classifyArchiveContractMembers(archivePath, sessionId);
  if (currentContract !== 'compatible') {
    findings.push({
      severity: 'warning',
      code: ARCHIVE_CONTRACT_FINDING_CODES[currentContract],
      message: `Archive ${file} is ${currentContract} under the current archive contract.`,
      recovery: [
        'Historical archives are expected to be incompatible after a contract change.',
        'Use the previously installed artifact when an old archive must be re-verified.',
      ],
    });
  }
  return { file, sessionId, extractable, currentContract, findings };
}

// ─── Report assembly ─────────────────────────────────────────────────────────

function invalidSessionNameEntry(name: string): SessionCheckEntry {
  return {
    sessionId: name,
    state: 'unreadable',
    phase: null,
    terminal: null,
    audit: 'missing',
    findings: [
      {
        severity: 'blocker',
        code: 'SESSION_DIR_NAME_INVALID',
        message: `Session directory "${name}" is not a valid FlowGuard session id and cannot be classified.`,
        recovery: [
          'Inspect the directory and rename or remove it if it is not a FlowGuard session.',
        ],
      },
    ],
  };
}

function unclassifiableSessionEntry(name: string, error: unknown): SessionCheckEntry {
  return {
    sessionId: name,
    state: 'unreadable',
    phase: null,
    terminal: null,
    audit: 'missing',
    findings: [
      {
        severity: 'blocker',
        code: 'INVENTORY_UNREADABLE',
        message: `Session ${name} cannot be classified reliably: ${
          error instanceof Error ? error.message : String(error)
        }.`,
        recovery: ['Check filesystem permissions and re-run the preflight.'],
      },
    ],
  };
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isValidSessionName(name: string): boolean {
  try {
    validateSessionId(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * A workspace is managed when the fingerprint has a workspace store or the
 * resolved worktree carries a repo-scoped FlowGuard config. Both checks are
 * read-only; a filesystem error is never silently treated as an empty store.
 */
function isManagedWorkspace(identity: WorkspaceIdentity): boolean {
  return (
    existsSync(workspaceDir(identity.fingerprint)) ||
    existsSync(repoConfigPath(identity.worktreeRoot))
  );
}

type IdentityBlocker = Extract<
  UpgradePreflightResult,
  { kind: 'inventory-unreadable' | 'workspace-not-initialized' | 'workspace-identity-changed' }
>;

/**
 * Classify identity-level blockers before any inventory is read: unreadable
 * store metadata, prior workspace evidence under another fingerprint (identity
 * change), or a resolvable worktree that is not initialized at all.
 */
async function classifyWorkspaceIdentity(
  identity: WorkspaceIdentity,
): Promise<IdentityBlocker | null> {
  const scan = await scanWorktreeWorkspaces(identity);
  if (scan.status === 'unreadable') {
    return { kind: 'inventory-unreadable', detail: scan.detail };
  }
  const foreignFingerprints = scan.fingerprints.filter(
    (fingerprint) => fingerprint !== identity.fingerprint,
  );
  if (foreignFingerprints.length > 0) {
    return {
      kind: 'workspace-identity-changed',
      detail: `prior workspace fingerprint(s) for this worktree: ${foreignFingerprints.join(', ')}`,
    };
  }
  if (!isManagedWorkspace(identity)) {
    return {
      kind: 'workspace-not-initialized',
      detail: `no workspace store at ${workspaceDir(identity.fingerprint)} and no repo config for ${identity.worktreeRoot}`,
    };
  }
  return null;
}

/**
 * Run the workspace upgrade preflight and return its structured report.
 *
 * A worktree whose identity changed (for example a remote was added or
 * removed) keeps its prior workspace under a different fingerprint. That prior
 * evidence is reported as a blocker instead of being treated as an empty
 * inventory, and a repo config alone only counts as a never-used workspace.
 */
export async function runUpgradePreflight(
  identity: WorkspaceIdentity,
): Promise<UpgradePreflightResult> {
  const identityBlocker = await classifyWorkspaceIdentity(identity);
  if (identityBlocker !== null) return identityBlocker;

  const sessionsRoot = join(workspaceDir(identity.fingerprint), 'sessions');
  const archiveDir = join(sessionsRoot, 'archive');

  let sessionNames: string[];
  try {
    sessionNames = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // No sessions directory is a valid empty inventory, not an upgrade blocker.
    if (!isEnoent(error)) {
      return { kind: 'inventory-unreadable', detail: `sessions directory: ${String(error)}` };
    }
    sessionNames = [];
  }

  const sessions: SessionCheckEntry[] = [];
  for (const name of sessionNames) {
    if (!isValidSessionName(name)) {
      sessions.push(invalidSessionNameEntry(name));
      continue;
    }
    try {
      sessions.push(await checkSession(identity.fingerprint, name));
    } catch (error) {
      sessions.push(unclassifiableSessionEntry(name, error));
    }
  }

  let archiveFiles: string[] = [];
  if (existsSync(archiveDir)) {
    try {
      archiveFiles = readdirSync(archiveDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      return { kind: 'inventory-unreadable', detail: `archive directory: ${String(error)}` };
    }
  }

  const archives: ArchiveCheckEntry[] = [];
  for (const file of archiveFiles) {
    try {
      archives.push(await checkArchive(archiveDir, file));
    } catch (error) {
      return { kind: 'inventory-unreadable', detail: `archive ${file}: ${String(error)}` };
    }
  }

  const findings = [...sessions.flatMap((s) => s.findings), ...archives.flatMap((a) => a.findings)];
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
  return {
    kind: 'ok',
    report: {
      scope: 'workspace',
      workspaceFingerprint: identity.fingerprint,
      upgradeReady: blockers === 0,
      summary: {
        sessions: sessions.length,
        archives: archives.length,
        blockers,
        warnings: findings.length - blockers,
      },
      sessions,
      archives,
    },
  };
}
