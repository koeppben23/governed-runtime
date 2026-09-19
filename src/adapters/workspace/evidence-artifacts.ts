/**
 * @module adapters/workspace/evidence-artifacts
 * @description Materialize and verify derived ticket/plan evidence artifacts.
 *
 * SSOT rule:
 * - `session-state.json` is authoritative.
 * - Files in `artifacts/` are derived, append-only evidence surfaces.
 *
 * Plan artifact identity is the canonical plan revision identity
 * (`PlanEvidence.recordDigest`): the derived surface carries no identity of
 * its own and does not duplicate the plan lineage rules. The state boundary
 * (`PlanRecord` in `src/state/evidence-plan.ts`) is the authoritative lineage
 * validator; this module only fails closed on artifact-specific evidence
 * (missing, mismatched, duplicated, or immutable files).
 *
 * Moved from integration/artifacts/ to adapters/workspace/ (P4b) because
 * this module's only dependencies are Node built-ins + state/schema —
 * it belongs in the adapters layer, not the integration layer.
 *
 * @version v2
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashText, hashFile } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import { atomicWrite } from '../persistence.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = 'flowguard-evidence-artifact.v1';
export const EVIDENCE_ARTIFACTS_DIR = 'artifacts';

type ArtifactType =
  'ticket' | 'plan' | 'plan-review-card' | 'review-report-card' | 'architecture-review-card';

interface EvidenceArtifactMeta {
  readonly schemaVersion: typeof EVIDENCE_ARTIFACT_SCHEMA_VERSION;
  readonly artifactType: ArtifactType;
  readonly version: number;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly phase: SessionState['phase'];
  readonly sourceStateHash: string;
  readonly contentHash: string;
  readonly markdownHash: string;
  readonly derivedFrom: 'session-state.json';
  readonly markdownPath: string;
  /**
   * Plan revision lineage identity (`PlanEvidence.recordDigest`). Artifact
   * identity is this lineage digest — never content equality. A session may
   * traverse several plan lineages (e.g. a rejected evidence review restarts
   * from the ticket), so the flat append-only artifact chain can contain
   * revisions that share `planVersion`, body, or timestamp. Absent on
   * ticket artifacts and on artifacts materialized before revision identity
   * existed; such historical entries are never used as identity for a current
   * revision.
   */
  readonly recordDigest?: string;
}

interface ArtifactFile {
  readonly markdownRelPath: string;
  readonly jsonRelPath: string;
  readonly markdownAbsPath: string;
  readonly jsonAbsPath: string;
}

/**
 * Typed evidence artifact error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type EvidenceArtifactErrorCode =
  'EVIDENCE_ARTIFACT_MISSING' | 'EVIDENCE_ARTIFACT_MISMATCH' | 'EVIDENCE_ARTIFACT_IMMUTABLE';

export class EvidenceArtifactError extends Error {
  readonly code: EvidenceArtifactErrorCode;

  constructor(code: EvidenceArtifactErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceArtifactError';
    this.code = code;
  }
}

export async function materializeEvidenceArtifacts(
  sessionDir: string,
  state: SessionState,
  preComputedStateHash?: string,
): Promise<void> {
  const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
  await fs.mkdir(artifactsDir, { recursive: true });
  // Use pre-computed hash when provided (artifacts-first ordering in writeStateWithArtifacts).
  // Falls back to reading from disk for backward compatibility with direct callers.
  const sourceStateHash =
    preComputedStateHash ?? (await hashFile(path.join(sessionDir, 'session-state.json')));
  const createdPaths: string[] = [];

  try {
    if (state.ticket) {
      await materializeTicketArtifact(artifactsDir, state, sourceStateHash, createdPaths);
    }

    if (state.plan) {
      await materializePlanArtifacts(artifactsDir, state, sourceStateHash, createdPaths);
    }
  } catch (err) {
    await cleanupCreatedArtifacts(createdPaths);
    throw err;
  }
}

/**
 * Materialize a review card as an immutable derived evidence artifact.
 *
 * Writes `artifacts/<artifactType>.<contentDigest>.md` and `.json`.
 *
 * IMPORTANT: Callers MUST persist state (writeStateWithArtifacts) BEFORE
 * calling this function. The stateHash is computed from session-state.json
 * which must reflect the CURRENT phase, not a prior one.
 *
 * @param contentDigest - unique digest of the artifact content (planDigest,
 *   obligationId, or adrDigest). Used as the version identifier in the filename.
 * @returns null on success, or { code, message } on non-fatal failure
 */
export async function materializeReviewCardArtifact(
  sessionDir: string,
  artifactType: 'plan-review-card' | 'review-report-card' | 'architecture-review-card',
  markdown: string,
  state: SessionState,
  contentDigest: string,
): Promise<{ code: string; message: string } | null> {
  const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
  const base = `${artifactType}.${contentDigest}`;
  const mdPath = path.join(artifactsDir, `${base}.md`);
  const jsonPath = path.join(artifactsDir, `${base}.json`);
  const persistedContent = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  // P0#2: hash is computed from the ACTUAL persisted content (with trailing newline).
  const markdownSha256 = hashText(persistedContent);

  try {
    await fs.mkdir(artifactsDir, { recursive: true });
    const sourceStateHash = await hashFile(path.join(sessionDir, 'session-state.json'));

    // Immutability: if the file already exists, preserve the original.
    try {
      const existing = await fs.readFile(mdPath, 'utf-8');
      const existingHash = hashText(existing);
      if (existingHash === markdownSha256) {
        // P1#3: verify .json metadata exists and matches. Recreate if missing.
        await ensureMetaJson({
          jsonPath,
          artifactType,
          state,
          stateHash: sourceStateHash,
          markdownSha256,
          base,
          contentDigest,
        });
        return null; // no-op
      }
      return {
        code: 'REVIEW_CARD_ARTIFACT_IMMUTABLE',
        message: `Artifact already exists with different content: ${base}.md`,
      };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    const meta = {
      artifactType,
      contentDigest,
      derived: true,
      source: 'presentation',
      phase: state.phase,
      sessionId: state.id,
      createdAt: new Date().toISOString(),
      stateHash: sourceStateHash,
      markdownSha256,
      path: `${EVIDENCE_ARTIFACTS_DIR}/${base}.md`,
    };

    const createdPaths: string[] = [];
    try {
      await writeImmutableFile(mdPath, persistedContent, createdPaths);
      await writeImmutableFile(jsonPath, JSON.stringify(meta, null, 2) + '\n', createdPaths);
      return null;
    } catch (err) {
      await cleanupCreatedArtifacts(createdPaths);
      throw err;
    }
  } catch (err) {
    return {
      code: 'REVIEW_CARD_ARTIFACT_WRITE_FAILED',
      message:
        `Failed to materialize review card artifact ${artifactType}: ` +
        (err instanceof Error ? err.message : String(err)),
    };
  }
}

interface EnsureMetaJsonInput {
  jsonPath: string;
  artifactType: string;
  state: SessionState;
  stateHash: string;
  markdownSha256: string;
  base: string;
  contentDigest: string;
}

/** Ensure the metadata JSON exists. Recreates it if missing after a partial write. */
async function ensureMetaJson(input: EnsureMetaJsonInput): Promise<void> {
  const { jsonPath, artifactType, state, stateHash, markdownSha256, base, contentDigest } = input;
  try {
    await fs.access(jsonPath);
  } catch {
    // .json was lost (crash between .md and .json write). Recreate it.
    const meta = {
      artifactType,
      contentDigest,
      derived: true,
      source: 'presentation',
      phase: state.phase,
      sessionId: state.id,
      createdAt: new Date().toISOString(),
      stateHash,
      markdownSha256,
      path: `${EVIDENCE_ARTIFACTS_DIR}/${base}.md`,
    };
    await atomicWrite(jsonPath, JSON.stringify(meta, null, 2) + '\n');
  }
}

export async function verifyEvidenceArtifacts(
  sessionDir: string,
  state: SessionState,
): Promise<void> {
  const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);

  if (state.ticket) {
    await verifyTicketArtifacts(artifactsDir, state);
  }

  if (state.plan) {
    await verifyPlanArtifacts(artifactsDir, state);
  }
}

async function materializeTicketArtifact(
  artifactsDir: string,
  state: SessionState,
  sourceStateHash: string,
  createdPaths: string[],
): Promise<void> {
  const ticket = state.ticket;
  if (!ticket) return;

  const existing = await readArtifactVersions(artifactsDir, 'ticket');
  const matching = existing.find((entry) => entry.meta.contentHash === ticket.digest);
  if (matching) return;

  const version = (existing[existing.length - 1]?.meta.version ?? 0) + 1;
  const file = artifactFile(artifactsDir, 'ticket', version);
  const markdown = formatTicketMarkdown(version, ticket.text, ticket.createdAt, state.id);
  const meta: EvidenceArtifactMeta = {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: 'ticket',
    version,
    sessionId: state.id,
    createdAt: ticket.createdAt,
    phase: state.phase,
    sourceStateHash,
    contentHash: ticket.digest,
    markdownHash: hashText(markdown),
    derivedFrom: 'session-state.json',
    markdownPath: file.markdownRelPath,
  };

  await writeImmutableFile(file.markdownAbsPath, markdown, createdPaths);
  await writeImmutableFile(file.jsonAbsPath, JSON.stringify(meta, null, 2) + '\n', createdPaths);
}

/**
 * Canonical revision identity of one plan revision. Artifact identity is the
 * revision's `recordDigest` (which binds content, version, predecessor,
 * obligation, reason, and minted `revisionId`), never content equality: two
 * revisions with identical bodies are still two distinct lineage artifacts.
 */
interface PlanRevisionIdentity {
  readonly planVersion: number;
  readonly body: string;
  readonly digest: string;
  readonly recordDigest: string;
  readonly createdAt: string;
}

/**
 * Order the plan revisions in lineage order (v1..vN). The plan authority is
 * `history + current`; lineage coherence (contiguity, chaining, head position)
 * is enforced by the `PlanRecord` schema refinement at the state boundary and
 * is not duplicated here.
 */
function orderedPlanRevisions(plan: NonNullable<SessionState['plan']>): PlanRevisionIdentity[] {
  return [...plan.history, plan.current].sort(
    (left, right) => left.planVersion - right.planVersion,
  );
}

async function materializePlanArtifacts(
  artifactsDir: string,
  state: SessionState,
  sourceStateHash: string,
  createdPaths: string[],
): Promise<void> {
  const plan = state.plan;
  if (!plan) return;

  const chain = orderedPlanRevisions(plan);
  let existing = await readArtifactVersions(artifactsDir, 'plan');

  // One artifact per authority revision instance, keyed by the canonical
  // revision identity (`recordDigest`). Content equality must never gate
  // materialization: an identical-body revision is a new lineage revision
  // with a new `recordDigest` and receives its own immutable artifact.
  for (const revision of chain) {
    if (findPlanRevisionArtifact(existing, revision)) continue;
    const nextVersion = (existing[existing.length - 1]?.meta.version ?? 0) + 1;
    await createPlanArtifact({
      artifactsDir,
      state,
      sourceStateHash,
      evidence: revision,
      version: nextVersion,
      createdPaths,
    });
    existing = await readArtifactVersions(artifactsDir, 'plan');
  }

  assertPlanRevisionCoverage(existing, chain);
}

interface CreatePlanArtifactInput {
  artifactsDir: string;
  state: SessionState;
  sourceStateHash: string;
  evidence: PlanRevisionIdentity;
  version: number;
  createdPaths: string[];
}

async function createPlanArtifact(input: CreatePlanArtifactInput): Promise<void> {
  const { artifactsDir, state, sourceStateHash, evidence, version, createdPaths } = input;
  const file = artifactFile(artifactsDir, 'plan', version);
  const markdown = formatPlanMarkdown(version, evidence.body, evidence.createdAt, state.id);
  const meta: EvidenceArtifactMeta = {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: 'plan',
    version,
    sessionId: state.id,
    createdAt: evidence.createdAt,
    phase: state.phase,
    sourceStateHash,
    contentHash: evidence.digest,
    recordDigest: evidence.recordDigest,
    markdownHash: hashText(markdown),
    derivedFrom: 'session-state.json',
    markdownPath: file.markdownRelPath,
  };

  await writeImmutableFile(file.markdownAbsPath, markdown, createdPaths);
  await writeImmutableFile(file.jsonAbsPath, JSON.stringify(meta, null, 2) + '\n', createdPaths);
}

/** The artifact of one exact revision instance, identified by its canonical revision identity. */
function findPlanRevisionArtifact(
  entries: Array<{ meta: EvidenceArtifactMeta; relPath: string }>,
  revision: PlanRevisionIdentity,
): { meta: EvidenceArtifactMeta; relPath: string } | undefined {
  return entries.find((candidate) => candidate.meta.recordDigest === revision.recordDigest);
}

/**
 * The artifact chain must cover the CURRENT authority lineage exactly: every
 * revision instance is identified by `recordDigest` alone, with `contentHash`
 * and `createdAt` as integrity attributes that must match the revision.
 * Artifacts from superseded lineages remain append-only history and are not
 * part of the coverage contract.
 */
function assertPlanRevisionCoverage(
  entries: Array<{ meta: EvidenceArtifactMeta; relPath: string }>,
  chain: readonly PlanRevisionIdentity[],
): void {
  if (entries.length === 0) {
    throw new EvidenceArtifactError('EVIDENCE_ARTIFACT_MISSING', 'Plan artifact chain is empty');
  }
  for (const revision of chain) {
    const matches = entries.filter(
      (candidate) => candidate.meta.recordDigest === revision.recordDigest,
    );
    const [onlyMatch] = matches;
    if (onlyMatch === undefined) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISSING',
        `Plan artifact missing for revision v${revision.planVersion}`,
      );
    }
    if (matches.length > 1) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISMATCH',
        `Plan revision v${revision.planVersion} is materialized more than once`,
      );
    }
    const artifact = onlyMatch.meta;
    if (artifact.contentHash !== revision.digest) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISMATCH',
        `Plan artifact v${revision.planVersion} contentHash does not match its revision`,
      );
    }
    if (artifact.createdAt !== revision.createdAt) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISMATCH',
        `Plan artifact v${revision.planVersion} createdAt does not match its revision`,
      );
    }
  }
}

async function verifyTicketArtifacts(artifactsDir: string, state: SessionState): Promise<void> {
  const ticket = state.ticket;
  if (!ticket) return;

  const entries = await readArtifactVersions(artifactsDir, 'ticket');
  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      'Ticket evidence artifacts are missing for current state',
    );
  }

  for (const entry of entries) {
    await assertMarkdownIntegrity(artifactsDir, entry.meta, 'ticket');
  }

  if (latest.meta.contentHash !== ticket.digest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Ticket artifact hash mismatch: state=${ticket.digest.slice(0, 12)} artifact=${latest.meta.contentHash.slice(0, 12)}`,
    );
  }
}

async function verifyPlanArtifacts(artifactsDir: string, state: SessionState): Promise<void> {
  const plan = state.plan;
  if (!plan) return;

  const chain = orderedPlanRevisions(plan);
  const entries = await readArtifactVersions(artifactsDir, 'plan');
  if (entries.length === 0) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      'Plan evidence artifact missing for current state',
    );
  }

  assertPlanRevisionCoverage(entries, chain);

  for (const entry of entries) {
    if (!entry.meta.sourceStateHash) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISMATCH',
        `Plan artifact v${entry.meta.version} is missing sourceStateHash linkage`,
      );
    }
    await assertMarkdownIntegrity(artifactsDir, entry.meta, 'plan');
  }
}

async function readArtifactVersions(
  artifactsDir: string,
  artifactType: ArtifactType,
): Promise<Array<{ meta: EvidenceArtifactMeta; relPath: string }>> {
  let files: string[];
  try {
    files = await fs.readdir(artifactsDir);
  } catch {
    return [];
  }

  const pattern = new RegExp(`^${artifactType}\\.v(\\d+)\\.json$`);
  const jsonFiles = files.filter((name) => pattern.test(name));
  const parsed: Array<{ meta: EvidenceArtifactMeta; relPath: string }> = [];

  for (const jsonFile of jsonFiles) {
    const match = pattern.exec(jsonFile);
    if (!match) continue;
    const expectedVersion = Number(match[1]);
    const expectedMarkdownPath = `${EVIDENCE_ARTIFACTS_DIR}/${artifactType}.v${expectedVersion}.md`;
    const relPath = `${EVIDENCE_ARTIFACTS_DIR}/${jsonFile}`;
    const fullPath = path.join(artifactsDir, jsonFile);
    const raw = await fs.readFile(fullPath, 'utf-8');
    const meta = parseArtifactMeta(
      raw,
      artifactType,
      relPath,
      expectedVersion,
      expectedMarkdownPath,
    );
    parsed.push({ meta, relPath });
  }

  return parsed.sort((a, b) => a.meta.version - b.meta.version);
}

function parseArtifactMeta(
  raw: string,
  expectedType: ArtifactType,
  relPath: string,
  expectedVersion: number,
  expectedMarkdownPath: string,
): EvidenceArtifactMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact metadata is not valid JSON: ${relPath}`,
    );
  }

  if (!isArtifactMeta(parsed)) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact metadata has invalid shape: ${relPath}`,
    );
  }

  if (parsed.artifactType !== expectedType) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact type mismatch in ${relPath}: expected ${expectedType}, got ${parsed.artifactType}`,
    );
  }

  if (parsed.schemaVersion !== EVIDENCE_ARTIFACT_SCHEMA_VERSION) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact schema version mismatch in ${relPath}: ${parsed.schemaVersion}`,
    );
  }

  if (parsed.version !== expectedVersion) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact version mismatch in ${relPath}: expected v${expectedVersion}, got v${parsed.version}`,
    );
  }

  if (parsed.markdownPath !== expectedMarkdownPath) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Artifact markdownPath mismatch in ${relPath}: expected ${expectedMarkdownPath}, got ${parsed.markdownPath}`,
    );
  }

  return parsed;
}

function isValidString(v: unknown): v is string {
  return typeof v === 'string';
}
function isValidNumber(v: unknown): v is number {
  return typeof v === 'number';
}
function isSha256Hex(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}
function isValidArtifactType(v: unknown): v is 'ticket' | 'plan' {
  return v === 'ticket' || v === 'plan';
}

function isArtifactMeta(input: unknown): input is EvidenceArtifactMeta {
  if (!input || typeof input !== 'object') return false;
  const c = input as Partial<EvidenceArtifactMeta>;
  return checkBaseArtifactFields(c) && checkHashAndDerivedFields(c);
}

function checkBaseArtifactFields(c: Partial<EvidenceArtifactMeta>): boolean {
  return (
    isValidString(c.schemaVersion) &&
    isValidArtifactType(c.artifactType) &&
    isValidNumber(c.version) &&
    c.version > 0 &&
    isValidString(c.sessionId) &&
    isValidString(c.createdAt) &&
    isValidString(c.phase)
  );
}

function checkHashAndDerivedFields(c: Partial<EvidenceArtifactMeta>): boolean {
  return (
    isSha256Hex(c.sourceStateHash) &&
    isValidString(c.contentHash) &&
    c.contentHash.length > 0 &&
    isSha256Hex(c.markdownHash) &&
    c.derivedFrom === 'session-state.json' &&
    isValidString(c.markdownPath) &&
    (c.recordDigest === undefined || isSha256Hex(c.recordDigest))
  );
}

function artifactFile(
  artifactsDir: string,
  artifactType: ArtifactType,
  version: number,
): ArtifactFile {
  const base = `${artifactType}.v${version}`;
  const markdownRelPath = `${EVIDENCE_ARTIFACTS_DIR}/${base}.md`;
  const jsonRelPath = `${EVIDENCE_ARTIFACTS_DIR}/${base}.json`;
  return {
    markdownRelPath,
    jsonRelPath,
    markdownAbsPath: path.join(artifactsDir, `${base}.md`),
    jsonAbsPath: path.join(artifactsDir, `${base}.json`),
  };
}

function formatTicketMarkdown(
  version: number,
  ticketText: string,
  createdAt: string,
  sessionId: string,
): string {
  return [
    `# Ticket v${version}`,
    '',
    `- Session: ${sessionId}`,
    `- Created At: ${createdAt}`,
    '',
    '## Ticket Text',
    '',
    ticketText,
    '',
  ].join('\n');
}

function formatPlanMarkdown(
  version: number,
  planBody: string,
  createdAt: string,
  sessionId: string,
): string {
  return [
    `# Plan v${version}`,
    '',
    `- Session: ${sessionId}`,
    `- Created At: ${createdAt}`,
    '',
    planBody,
    '',
  ].join('\n');
}

async function writeImmutableFile(
  filePath: string,
  content: string,
  createdPaths: string[],
): Promise<void> {
  try {
    const current = await fs.readFile(filePath, 'utf-8');
    if (current === content) return;
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_IMMUTABLE',
      `Refusing to overwrite immutable artifact: ${filePath}`,
    );
  } catch (err) {
    if (isNotFound(err)) {
      await atomicWrite(filePath, content);
      createdPaths.push(filePath);
      return;
    }
    throw err;
  }
}

async function assertMarkdownIntegrity(
  artifactsDir: string,
  meta: EvidenceArtifactMeta,
  artifactType: ArtifactType,
): Promise<void> {
  const markdownRelPath = meta.markdownPath;
  const fileName = path.basename(markdownRelPath);
  const markdownPath = path.join(artifactsDir, fileName);
  const actualHash = await hashFile(markdownPath).catch((err) => {
    getAdapterLogger().warn('evidence-artifacts', 'Failed to hash evidence artifact', {
      markdownPath,
      artifactType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!actualHash) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      `${artifactType} markdown artifact is missing: ${markdownRelPath}`,
    );
  }
  if (actualHash !== meta.markdownHash) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `${artifactType} markdown artifact hash mismatch for ${markdownRelPath}`,
    );
  }
}

async function cleanupCreatedArtifacts(createdPaths: string[]): Promise<void> {
  for (let i = createdPaths.length - 1; i >= 0; i -= 1) {
    const filePath = createdPaths[i];
    if (filePath === undefined) continue;
    try {
      await fs.unlink(filePath);
    } catch {
      /* best effort cleanup */
    }
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT',
  );
}
