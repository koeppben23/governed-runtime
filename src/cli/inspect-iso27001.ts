/**
 * @module cli/inspect-iso27001
 * @description `flowguard inspect --iso27001-mapping <file>` — read-only
 * ISO/IEC 27001:2022 evidence-to-control projection.
 *
 * The command is opt-in and strictly read-only for the session and its
 * artifacts:
 * 1. the organization mapping is read from a regular file (bounded, no network)
 * 2. the immutable completion export is verified and read from the verified
 *    snapshot (sidecar required)
 * 3. the current workspace session contributes only the explicit
 *    `export.completion` live binding
 * 4. the report is projected deterministically and rendered
 *
 * Exit codes:
 * - 0: a report was produced (even when it lists missing evidence)
 * - 1: invalid arguments, mapping, or output path
 * - 2: the completion export is missing or failed verification
 *
 * @version v1
 */

import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readAuditTrail } from '../adapters/persistence-audit.js';
import { readState } from '../adapters/persistence.js';
import { evaluateLiveExportBinding } from '../audit/iso27001/live-binding.js';
import { workspacesHome } from '../adapters/workspace/init.js';
import {
  describeBlockedExport,
  readVerifiedCompletionExport,
} from '../adapters/workspace/archive-read-verified.js';
import { mappingDigestOf, parseIso27001EvidenceMapping } from '../audit/iso27001/mapping-schema.js';
import { projectIso27001Report } from '../audit/iso27001/project.js';
import { renderIso27001Markdown } from '../audit/iso27001/render-markdown.js';
import type { VerifiedEvidenceSnapshot, LiveExportBinding } from '../audit/iso27001/evidence.js';

/** Bounded mapping input: a mapping is a small declarative document. */
const MAX_MAPPING_BYTES = 1024 * 1024;

export interface Iso27001InspectInput {
  readonly fingerprint: string;
  /** Canonically resolved session directory (owned by the inspect command). */
  readonly sessDir: string;
  readonly sessionId: string;
  readonly mappingPath: string;
  readonly json: boolean;
  readonly outputPath?: string;
}

function reportError(message: string): number {
  console.error(`[error] ${message}`);
  return 1;
}

async function readMappingFile(
  mappingPath: string,
): Promise<{ ok: true; content: string } | { ok: false; exitCode: number }> {
  let stats;
  try {
    stats = await lstat(mappingPath);
  } catch {
    return { ok: false, exitCode: reportError(`Cannot read mapping file: ${mappingPath}`) };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      exitCode: reportError(`Mapping path is not a regular file: ${mappingPath}`),
    };
  }
  if (stats.size > MAX_MAPPING_BYTES) {
    return {
      ok: false,
      exitCode: reportError(
        `Mapping file exceeds the ${MAX_MAPPING_BYTES}-byte limit: ${mappingPath}`,
      ),
    };
  }
  try {
    return { ok: true, content: await readFile(mappingPath, 'utf-8') };
  } catch {
    return { ok: false, exitCode: reportError(`Cannot read mapping file: ${mappingPath}`) };
  }
}

export interface VerifiedLiveBindingInput {
  readonly sessDir: string;
  /** FlowGuard session identity taken from the VERIFIED archive state. */
  readonly flowguardSessionId: string;
  /** Audit event count anchored in the verified archive manifest. */
  readonly archiveAuditEventCount: number;
  /** Audit chain head anchored in the verified archive manifest. */
  readonly archiveAuditChainHead: string;
}

/**
 * Read the live (mutable) session facts and evaluate the export binding
 * through the pure audit authority. This function performs I/O only; the
 * binding policy (canonical session-bound chain verification, archive-anchor
 * extension, canonical materialization event) lives in
 * `audit/iso27001/live-binding`.
 */
async function readVerifiedLiveBinding(
  input: VerifiedLiveBindingInput,
): Promise<LiveExportBinding> {
  let stateAvailable = false;
  let packageDigest: string | null = null;
  try {
    const state = await readState(input.sessDir);
    if (state !== null) {
      stateAvailable = true;
      packageDigest = state.exportCompletionEvidence?.packageDigest ?? null;
    }
  } catch {
    stateAvailable = false;
  }

  let auditReadable = true;
  let liveEvents: Awaited<ReturnType<typeof readAuditTrail>> = [];
  try {
    liveEvents = await readAuditTrail(input.sessDir);
  } catch {
    auditReadable = false;
  }

  return evaluateLiveExportBinding({
    stateAvailable,
    exportCompletionPackageDigest: packageDigest,
    auditReadable,
    liveEvents,
    flowguardSessionId: input.flowguardSessionId,
    archiveAuditEventCount: input.archiveAuditEventCount,
    archiveAuditChainHead: input.archiveAuditChainHead,
  });
}

/**
 * Refuse to write the companion report into the FlowGuard config workspace.
 * Returns the resolved path, or an error message without throwing.
 */
function safeOutputPath(
  outputPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = path.resolve(outputPath);
  const home = path.resolve(workspacesHome());
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    return {
      ok: false,
      error: 'Refusing to write the companion report inside the FlowGuard config workspace',
    };
  }
  return { ok: true, path: resolved };
}

async function writeCompanionReport(outputPath: string, content: string): Promise<number> {
  const safe = safeOutputPath(outputPath);
  if (!safe.ok) return reportError(safe.error);
  const resolved = safe.path;
  try {
    await writeFile(resolved, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') {
      return reportError(`Refusing to overwrite existing file: ${resolved}`);
    }
    return reportError(
      `Cannot write companion report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.error(`[ok] Companion report written: ${resolved}`);
  return 0;
}

export async function runIso27001Inspect(input: Iso27001InspectInput): Promise<number> {
  const mappingFile = await readMappingFile(input.mappingPath);
  if (!mappingFile.ok) return mappingFile.exitCode;

  let parsed: unknown;
  try {
    parsed = JSON.parse(mappingFile.content);
  } catch {
    return reportError(`Mapping file is not valid JSON: ${input.mappingPath}`);
  }

  const mappingResult = parseIso27001EvidenceMapping(parsed);
  if (!mappingResult.ok) {
    console.error(`[error] Invalid ISO/IEC 27001 mapping: ${input.mappingPath}`);
    for (const issue of mappingResult.issues) {
      console.error(`[error]   ${issue.path}: ${issue.message}`);
    }
    return 1;
  }
  const mapping = mappingResult.mapping;

  const read = await readVerifiedCompletionExport(input.fingerprint, input.sessionId);
  if (read.kind === 'blocked') {
    console.error(
      `[error] Completion export cannot back verified evidence: ${describeBlockedExport(read)}`,
    );
    return 2;
  }

  const snapshot: VerifiedEvidenceSnapshot = {
    integrity: read.integrity,
    sessionId: read.manifest.sessionId,
    fingerprint: read.manifest.fingerprint,
    packageSha256: read.packageSha256,
    sidecarSha256: read.sidecarSha256,
    manifestContentDigest: read.manifest.contentDigest,
    manifestSchemaVersion: read.manifest.schemaVersion,
    manifestPolicyMode: read.manifest.policyMode,
    auditChainHead: read.manifest.auditChainHead,
    auditEventCount: read.manifest.auditEventCount,
    fileDigests: read.manifest.fileDigests,
    state: read.state,
    events: read.events,
  };

  const liveBinding = await readVerifiedLiveBinding({
    sessDir: input.sessDir,
    flowguardSessionId: read.state.flowguardSessionId,
    archiveAuditEventCount: read.manifest.auditEventCount,
    archiveAuditChainHead: read.manifest.auditChainHead,
  });
  const report = projectIso27001Report({
    mapping,
    mappingDigest: mappingDigestOf(mapping),
    verified: snapshot,
    liveBinding,
    generatedAt: new Date().toISOString(),
  });

  const content = input.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderIso27001Markdown(report)}\n`;

  if (input.outputPath !== undefined) {
    const writeExit = await writeCompanionReport(input.outputPath, content);
    if (writeExit !== 0) return writeExit;
  }
  process.stdout.write(content);
  return 0;
}
