/**
 * @module integration/tools/observe-repository
 * @description flowguard_observe_repository — the sanctioned reviewer
 *              observation capability.
 *
 * The ONLY path through which a reviewer can obtain frozen repository bytes
 * that may later be cited as a Finding evidenceLocation:
 *
 * ```text
 * reviewer echoes host-minted capability + revision + path
 *   → host resolves the exact frozen repository target
 *   → host acquires immutable bytes (local git object DB / remote commit blob)
 *   → bytes delivered
 *   → transport capture appended to the capability-namespaced ledger
 * ```
 *
 * Read/Glob/Grep investigation output never produces governance authority;
 * only this tool does, and only the parent replay turns a capture into an
 * authoritative `RepositoryObservation`.
 *
 * @version v1
 */

import { z } from 'zod';
import type { ToolDefinition } from './helpers.js';
import { formatBlocked, getWorktree, resolveWorkspacePaths } from './helpers.js';
import { formatError } from './error-format.js';
import { workspacesHome } from '../../adapters/workspace/index.js';
import {
  FrozenRepositoryError,
  acquireFrozenRepositoryContent,
} from '../../adapters/frozen-repository.js';
import {
  appendObservationCapture,
  observationCapabilityDigest,
  observationLedgerRoot,
} from '../../adapters/persistence-observation-ledger.js';
import { resolveFrozenRevisionTarget } from '../../state/evidence.js';
import { normalizeRepositoryPath } from '../../state/repository-path.js';
import { resolveAttemptByCapability } from '../review/observation-resolution.js';
import {
  buildObservationToolResponse,
  classifyRepresentation,
  contentDigestOf,
  repositoryIdentityDigest,
  responseDigestOf,
} from '../review/observation-service.js';

const ARGS = z
  .object({
    capability: z
      .string()
      .min(1)
      .describe('The host-minted observation capability from your review prompt.'),
    revision: z
      .enum(['base', 'head'])
      .describe('Frozen revision alias — never a SHA, never a branch name.'),
    path: z
      .string()
      .min(1)
      .describe('Repository-relative path of the file to observe at the frozen revision.'),
  })
  .strict();

function frozenErrorToBlocked(err: FrozenRepositoryError): string {
  switch (err.code) {
    case 'OVERSIZED_BLOB':
      return formatBlocked('REVIEW_OBSERVATION_OVERSIZED', { reason: err.message });
    case 'UNSUPPORTED_ENTRY':
      return formatBlocked('REVIEW_OBSERVATION_UNSUPPORTED_ENTRY', { reason: err.message });
    case 'PATH_NOT_IN_TREE':
    case 'OBJECT_UNAVAILABLE':
    case 'FREEZE_FAILED':
    case 'IDENTITY_UNAVAILABLE':
    case 'ACQUISITION_FAILED':
    default:
      return formatBlocked('REVIEW_OBSERVATION_UNAVAILABLE', { reason: err.message });
  }
}

export const observe_repository: ToolDefinition = {
  description:
    'Obtain the exact frozen repository bytes for a revision ("base" | "head") and ' +
    'repository-relative path, bound to your review attempt via the observation ' +
    'capability from your review prompt. This is the ONLY sanctioned source for ' +
    'repository evidenceLocations; ordinary read/glob/grep output is investigation ' +
    'only and cannot prove repository evidence.',
  args: {
    capability: ARGS.shape.capability,
    revision: ARGS.shape.revision,
    path: ARGS.shape.path,
  },
  async execute(args, context) {
    try {
      const parsed = ARGS.safeParse(args);
      if (!parsed.success) {
        return formatBlocked('REVIEW_OBSERVATION_INVALID_ARGS', {
          reason: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const { capability, revision, path: rawPath } = parsed.data;
      const worktree = getWorktree(context);
      const { fingerprint } = await resolveWorkspacePaths(context);

      const normalized = normalizeRepositoryPath(rawPath);
      if (!normalized) {
        return formatBlocked('REVIEW_OBSERVATION_PATH_INVALID', { path: rawPath });
      }

      // The child session has no state of its own: resolve the capability to
      // its exact owning attempt + obligation via the workspace registry.
      const resolution = await resolveAttemptByCapability({
        workspaceHome: workspacesHome(),
        fingerprint,
        capability,
      });
      if (!resolution) {
        return formatBlocked('REVIEW_OBSERVATION_CAPABILITY_UNKNOWN', {
          reason: 'The observation capability is unknown or its attempt is not currently usable.',
        });
      }

      const target = resolveFrozenRevisionTarget(resolution.obligation, revision);
      if (!target) {
        return formatBlocked('REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE', {
          revision,
          obligationId: resolution.obligation.obligationId,
        });
      }

      let acquired;
      try {
        acquired = acquireFrozenRepositoryContent(worktree, target, normalized);
      } catch (err) {
        if (err instanceof FrozenRepositoryError) return frozenErrorToBlocked(err);
        throw err;
      }

      const representation = classifyRepresentation(acquired.bytes);
      const content =
        representation === 'utf8_text'
          ? acquired.bytes.toString('utf-8')
          : acquired.bytes.toString('base64');
      const response = buildObservationToolResponse({
        path: normalized,
        revision,
        representation,
        content,
      });

      const capture = {
        capabilityDigest: observationCapabilityDigest(capability),
        path: normalized,
        revision,
        resolvedObjectSha: target.objectSha,
        repositoryIdentityDigest: repositoryIdentityDigest(target.repositoryIdentity),
        contentDigest: contentDigestOf(acquired.bytes),
        byteLength: acquired.bytes.length,
        representation,
        acquisitionKind: acquired.kind,
        responseDigest: responseDigestOf(response),
        capturedAt: new Date().toISOString(),
      };
      await appendObservationCapture(
        observationLedgerRoot(workspacesHome(), fingerprint),
        capture.capabilityDigest,
        capture,
      );

      // The returned string is EXACTLY the payload hashed as responseDigest —
      // the parent replay rebuilds it byte-identically to prove delivery.
      return response;
    } catch (error) {
      return formatError(error);
    }
  },
};
