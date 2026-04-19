/**
 * @module integration/artifacts/evidence-artifacts
 * @description Materialize and verify derived ticket/plan evidence artifacts.
 *
 * SSOT rule:
 * - `session-state.json` is authoritative.
 * - Files in `artifacts/` are derived, append-only evidence surfaces.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionState } from '../../state/schema';

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = 'flowguard-evidence-artifact.v1';
export const EVIDENCE_ARTIFACTS_DIR = 'artifacts';

type ArtifactType = 'ticket' | 'plan';

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
}

interface ArtifactFile {
  readonly markdownRelPath: string;
  readonly jsonRelPath: string;
  readonly markdownAbsPath: string;
  readonly jsonAbsPath: string;
}

class EvidenceArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvidenceArtifactError';
    this.code = code;
  }
}

export async function materializeEvidenceArtifacts(
  sessionDir: string,
  state: SessionState,
): Promise<void> {
  const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
  await fs.mkdir(artifactsDir, { recursive: true });
  const sourceStateHash = await hashFile(path.join(sessionDir, 'session-state.json'));
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

async function materializePlanArtifacts(
  artifactsDir: string,
  state: SessionState,
  sourceStateHash: string,
  createdPaths: string[],
): Promise<void> {
  const plan = state.plan;
  if (!plan) return;

  let existing = await readArtifactVersions(artifactsDir, 'plan');

  if (existing.length === 0) {
    const ordered = [...plan.history].reverse().concat(plan.current);
    let version = 1;
    for (const evidence of ordered) {
      await createPlanArtifact(
        artifactsDir,
        state,
        sourceStateHash,
        evidence,
        version,
        createdPaths,
      );
      version += 1;
    }
    return;
  }

  const latest = existing[existing.length - 1];
  if (!latest || latest.meta.contentHash !== plan.current.digest) {
    const nextVersion = (latest?.meta.version ?? 0) + 1;
    await createPlanArtifact(
      artifactsDir,
      state,
      sourceStateHash,
      plan.current,
      nextVersion,
      createdPaths,
    );
    existing = await readArtifactVersions(artifactsDir, 'plan');
  }

  await assertPlanHistoryCoverage(
    existing,
    plan.history,
    existing[existing.length - 1]?.meta.version ?? 0,
  );
}

async function createPlanArtifact(
  artifactsDir: string,
  state: SessionState,
  sourceStateHash: string,
  evidence: { body: string; digest: string; createdAt: string },
  version: number,
  createdPaths: string[],
): Promise<void> {
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
    markdownHash: hashText(markdown),
    derivedFrom: 'session-state.json',
    markdownPath: file.markdownRelPath,
  };

  await writeImmutableFile(file.markdownAbsPath, markdown, createdPaths);
  await writeImmutableFile(file.jsonAbsPath, JSON.stringify(meta, null, 2) + '\n', createdPaths);
}

async function assertPlanHistoryCoverage(
  entries: Array<{ meta: EvidenceArtifactMeta; relPath: string }>,
  history: Array<{ digest: string }>,
  latestVersion: number,
): Promise<void> {
  if (entries.length === 0) {
    throw new EvidenceArtifactError('EVIDENCE_ARTIFACT_MISSING', 'Plan artifact chain is empty');
  }

  for (let index = 0; index < history.length; index += 1) {
    const expected = history[index]!;
    const found = entries.some(
      (entry) => entry.meta.contentHash === expected.digest && entry.meta.version < latestVersion,
    );
    if (!found) {
      throw new EvidenceArtifactError(
        'EVIDENCE_ARTIFACT_MISSING',
        `Plan history artifact missing for digest ${expected.digest.slice(0, 12)}...`,
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

  const entries = await readArtifactVersions(artifactsDir, 'plan');
  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISSING',
      'Plan evidence artifact missing for current state',
    );
  }

  if (latest.meta.contentHash !== plan.current.digest) {
    throw new EvidenceArtifactError(
      'EVIDENCE_ARTIFACT_MISMATCH',
      `Plan artifact hash mismatch for latest revision: state=${plan.current.digest.slice(0, 12)} artifact=${latest.meta.contentHash.slice(0, 12)}`,
    );
  }

  await assertPlanHistoryCoverage(entries, plan.history, latest.meta.version);

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

function isArtifactMeta(input: unknown): input is EvidenceArtifactMeta {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<EvidenceArtifactMeta>;
  const isSha256Hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  return (
    typeof candidate.schemaVersion === 'string' &&
    (candidate.artifactType === 'ticket' || candidate.artifactType === 'plan') &&
    typeof candidate.version === 'number' &&
    candidate.version > 0 &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.phase === 'string' &&
    isSha256Hex(candidate.sourceStateHash) &&
    typeof candidate.contentHash === 'string' &&
    candidate.contentHash.length > 0 &&
    isSha256Hex(candidate.markdownHash) &&
    candidate.derivedFrom === 'session-state.json' &&
    typeof candidate.markdownPath === 'string'
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
      await fs.writeFile(filePath, content, 'utf-8');
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
  const actualHash = await hashFile(markdownPath).catch(() => null);
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
    const filePath = createdPaths[i]!;
    try {
      await fs.unlink(filePath);
    } catch {
      /* best effort cleanup */
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT',
  );
}
