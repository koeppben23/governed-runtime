/**
 * @module workspace/archive-artifact-binding
 * @description Contract only — shared types and constants for artifact binding
 *              events. Defines the wire format between the build pipeline (which
 *              writes binding events into the audit log) and the verification
 *              pipeline (which cross-validates bound artifacts). No archive
 *              build authority. No archive verification authority.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashBuffer } from '../../shared/hashing.js';

/** Shape of a single artifact-to-hash binding recorded in the audit log. */
export interface ArtifactBindingEntry {
  readonly path: string;
  readonly sha256: string;
  readonly artifactType: string | null;
}

export const ARTIFACT_BINDING_EVENT = 'archive:artifacts_bound';

export const ARTIFACT_BINDING_SCHEMA_VERSION = 'flowguard-archive-artifact-binding.v1';

/** Digest-bound authority appended only after the final archive is published. */
export interface ArchivePublicationBinding {
  readonly publicationId: string;
  readonly archiveFile: string;
  readonly archiveDigest: string;
  readonly sidecarDigest: string;
  readonly manifestContentDigest: string;
}

export const ARCHIVE_PUBLICATION_BINDING_EVENT = 'archive:publication_bound';

export const ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION =
  'flowguard-archive-publication-binding.v1';

export function archivePublicationBinding(
  archive: Buffer,
  sidecar: Buffer,
  archiveFile: string,
  manifestContentDigest: string,
): ArchivePublicationBinding {
  const archiveDigest = hashBuffer(archive);
  const sidecarDigest = hashBuffer(sidecar);
  const publicationId = hashBuffer(
    Buffer.from(
      canonicalJsonStringify({ archiveFile, archiveDigest, sidecarDigest, manifestContentDigest }),
      'utf8',
    ),
  );
  return { publicationId, archiveFile, archiveDigest, sidecarDigest, manifestContentDigest };
}
