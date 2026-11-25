/**
 * @module workspace/upgrade-preflight-archive-contract
 * @description Pure classification of archived members under the current
 * evidence contract. Read-only and filesystem-free.
 *
 * An archive member that is present but carries no record cannot be treated as
 * compatible evidence: `verifyChain([])` is vacuously valid, so the empty case
 * is decided here. It is `unknown` rather than `invalid` so that an empty
 * member never masks a genuine legacy (`incompatible`) classification of the
 * remaining members.
 *
 * @version v1
 */

import { verifyChain } from '../../audit/integrity.js';
import { ARCHIVE_MANIFEST_SCHEMA_VERSION, ArchiveManifestSchema } from '../../archive/types.js';
import { assessPersistedStateDocument } from '../persistence.js';

export type ArchiveContractStatus = 'compatible' | 'incompatible' | 'invalid' | 'unknown';

type MemberRead = { readonly kind: 'ok'; readonly content: string } | { readonly kind: 'blocked' };

/**
 * Combine the archive member classifications (manifest, audit, session state)
 * into one archive contract status. Integrity under the current contract
 * (`invalid`) outranks expected legacy incompatibility (`incompatible`);
 * anything not fully assessed is `unknown`.
 */
export function combineArchiveContract(
  ...statuses: readonly ArchiveContractStatus[]
): ArchiveContractStatus {
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('incompatible')) return 'incompatible';
  if (statuses.every((status) => status === 'compatible')) return 'compatible';
  return 'unknown';
}

/**
 * Classify the archived state member through the canonical boundary authority
 * the live read uses; a pre-cut payload must not be reported compatible.
 */
export function classifyStateMember(member: MemberRead): ArchiveContractStatus {
  if (member.kind !== 'ok') return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(member.content);
  } catch {
    return 'invalid';
  }
  const assessment = assessPersistedStateDocument(parsed);
  if (assessment.kind === 'incompatible') return 'incompatible';
  return assessment.kind === 'invalid' || assessment.kind === 'integrity_mismatch'
    ? 'invalid'
    : 'compatible';
}

/** Classify a manifest member read against the current archive contract. */
export function classifyManifestMember(member: MemberRead): ArchiveContractStatus {
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
export function classifyAuditMember(member: MemberRead): ArchiveContractStatus {
  if (member.kind !== 'ok') return 'unknown';
  const records = parseJsonLines(member.content);
  if (records === null) return 'unknown';
  if (records.length === 0) return 'unknown';
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
