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
 * The shared primitives, metadata read model, markdown rendering, and the
 * ticket/plan materialization flows live in sibling `evidence-artifact-*`
 * modules and are re-exported through this canonical import surface.
 *
 * @version v2
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashText, hashFile } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import { atomicWrite } from '../persistence.js';
import {
  EVIDENCE_ARTIFACTS_DIR,
  cleanupCreatedArtifacts,
  isNotFound,
  writeImmutableFile,
} from './evidence-artifact-core.js';
import { materializePlanArtifacts, verifyPlanArtifacts } from './evidence-artifact-plan.js';
import { materializeTicketArtifact, verifyTicketArtifacts } from './evidence-artifact-ticket.js';

// Defined in evidence-artifact-core.ts; re-exported here so the canonical
// evidence-artifacts module keeps its published constant surface.
export { EVIDENCE_ARTIFACT_SCHEMA_VERSION } from './evidence-artifact-core.js';
export { EVIDENCE_ARTIFACTS_DIR, EvidenceArtifactError } from './evidence-artifact-core.js';
export type { EvidenceArtifactErrorCode } from './evidence-artifact-core.js';

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
