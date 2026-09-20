/**
 * @module adapters/workspace/evidence-artifact-plan
 * @description Plan evidence artifact materialization and verification.
 *
 * Plan artifact identity is the canonical plan revision identity
 * (`PlanEvidence.recordDigest`): the derived surface carries no identity of
 * its own and does not duplicate the plan lineage rules. The state boundary
 * (`PlanRecord` in `src/state/evidence-plan.ts`) is the authoritative lineage
 * validator; this module only fails closed on artifact-specific evidence
 * (missing, mismatched, duplicated, or immutable files).
 *
 * @version v1
 */

import { hashText } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import {
  EvidenceArtifactError,
  EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  artifactFile,
  writeImmutableFile,
  type EvidenceArtifactMeta,
} from './evidence-artifact-core.js';
import { assertMarkdownIntegrity, readArtifactVersions } from './evidence-artifact-metadata.js';
import { formatPlanMarkdown } from './evidence-artifact-format.js';

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

export async function materializePlanArtifacts(
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

export async function verifyPlanArtifacts(
  artifactsDir: string,
  state: SessionState,
): Promise<void> {
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
