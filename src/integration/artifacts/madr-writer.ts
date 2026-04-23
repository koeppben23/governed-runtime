/**
 * @module integration/artifacts/madr-writer
 * @description Write a MADR (Markdown Architecture Decision Record) artifact
 *              to the session directory on ARCH_COMPLETE.
 *
 * Called by the decision tool handler when a review-decision transitions
 * to ARCH_COMPLETE. The MADR file is a standalone Markdown artifact
 * suitable for archival and version control.
 *
 * File naming: {id}.md (e.g., ADR-1.md)
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ArchitectureDecision } from '../../state/evidence.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MADR_SCHEMA_VERSION = 'madr-artifact.v1';

// ─── MADR Content ─────────────────────────────────────────────────────────────

/**
 * Format an ArchitectureDecision into MADR Markdown content.
 * The output follows the MADR template with FlowGuard metadata header.
 */
export function formatMadrContent(adr: ArchitectureDecision): string {
  return [
    `# ${adr.id}: ${adr.title}`,
    '',
    `- Status: ${adr.status}`,
    `- Date: ${adr.createdAt}`,
    `- Schema: ${MADR_SCHEMA_VERSION}`,
    `- Digest: ${adr.digest}`,
    '',
    adr.adrText,
    '', // trailing newline
  ].join('\n');
}

/**
 * Derive the MADR filename from the ADR id.
 * Example: "ADR-1" -> "ADR-1.md"
 */
export function madrFileName(id: string): string {
  return `${id}.md`;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Write a MADR artifact to the session directory.
 *
 * Uses atomic write (temp -> rename) for consistency with all FlowGuard
 * file operations. The file is written to {sessionDir}/{id}.md.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param adr - The ArchitectureDecision to write.
 * @returns The absolute path to the written MADR file.
 */
export async function writeMadrArtifact(
  sessionDir: string,
  adr: ArchitectureDecision,
): Promise<string> {
  const fileName = madrFileName(adr.id);
  const filePath = path.join(sessionDir, fileName);
  const content = formatMadrContent(adr);

  // Atomic write: temp -> rename (same pattern as persistence.ts)
  await fs.mkdir(sessionDir, { recursive: true });
  const tempPath = path.join(sessionDir, `.${fileName}.${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error(
      `Failed to write MADR artifact: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return filePath;
}
