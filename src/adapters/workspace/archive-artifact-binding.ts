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

/** Shape of a single artifact-to-hash binding recorded in the audit log. */
export interface ArtifactBindingEntry {
  readonly path: string;
  readonly sha256: string;
  readonly artifactType: string | null;
}

export const ARTIFACT_BINDING_EVENT = 'archive:artifacts_bound';

export const ARTIFACT_BINDING_SCHEMA_VERSION = 'flowguard-archive-artifact-binding.v1';
