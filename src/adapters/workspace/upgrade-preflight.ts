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
 * @version v1
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyChain } from '../../audit/integrity.js';
import { ARCHIVE_MANIFEST_SCHEMA_VERSION, ArchiveManifestSchema } from '../../archive/types.js';
import { TERMINAL } from '../../machine/topology.js';
import type { SessionState } from '../../state/schema.js';
import { auditPath, readState } from '../persistence.js';
import { readAuditTrail } from '../persistence-audit.js';
import { inspectArchiveTar, readArchiveTextMember } from './archive-tar.js';
import { ARCHIVE_MANIFEST_FILE } from './archive-layout.js';
import { sessionDir, workspaceDir } from './init.js';

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
  readonly workspaceFingerprint: string;
  readonly upgradeReady: boolean;
  readonly summary: {
    readonly sessions: number;
    readonly archives: number;
    readonly blockers: number;
    readonly warnings: number;
  };
  readonly sessions: readonly SessionCheckEntry[];
  readonly archives: readonly ArchiveCheckEntry[];
}

export type UpgradePreflightResult =
  | { readonly kind: 'ok'; readonly report: UpgradeCheckReport }
  | { readonly kind: 'inventory-unreadable'; readonly detail: string };

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
            'Archive or complete the session with the currently installed version.',
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
            'Complete the session or archive it with the currently installed version.',
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
        'Archive or complete the session with the currently installed version before upgrading.',
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
        recovery: ['Verify whether this session must be archived before the upgrade.'],
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
 * with `regulated-`, so both candidates are tested and exactly one accepted
 * root wins.
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
  let unreachable = false;
  for (const candidate of candidates) {
    const inspection = await inspectArchiveTar(archivePath, candidate);
    if (inspection.kind === 'ok') okCandidates.push(candidate);
    else if (inspection.reason.startsWith('cannot inspect archive members')) unreachable = true;
  }
  const extractable: ArchiveExtractable = unreachable && okCandidates.length === 0 ? 'no' : 'yes';
  return { sessionId: okCandidates.length === 1 ? (okCandidates[0] ?? null) : null, extractable };
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

async function checkArchive(archiveDir: string, file: string): Promise<ArchiveCheckEntry> {
  const archivePath = join(archiveDir, file);
  const { sessionId, extractable } = await confirmArchiveSessionRoot(archivePath, file);
  const findings: UpgradeCheckFinding[] = [];

  if (extractable === 'no') {
    findings.push({
      severity: 'warning',
      code: 'ARCHIVE_UNREADABLE',
      message: `Archive ${file} cannot be inspected as a tar.gz container.`,
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
      code: `ARCHIVE_CONTRACT_${currentContract.toUpperCase()}`,
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

/** Run the workspace upgrade preflight and return its structured report. */
export async function runUpgradePreflight(fingerprint: string): Promise<UpgradePreflightResult> {
  const sessionsRoot = join(workspaceDir(fingerprint), 'sessions');
  const archiveDir = join(sessionsRoot, 'archive');

  let sessionIds: string[];
  try {
    sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return { kind: 'inventory-unreadable', detail: `sessions directory: ${String(error)}` };
  }

  const sessions: SessionCheckEntry[] = [];
  for (const sessionId of sessionIds) sessions.push(await checkSession(fingerprint, sessionId));

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
  for (const file of archiveFiles) archives.push(await checkArchive(archiveDir, file));

  const findings = [...sessions.flatMap((s) => s.findings), ...archives.flatMap((a) => a.findings)];
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
  return {
    kind: 'ok',
    report: {
      scope: 'workspace',
      workspaceFingerprint: fingerprint,
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
