/**
 * @module workspace/archive-layout
 * @description Canonical Archive Layout v2 paths for the complete audit package.
 */

import * as path from 'node:path';

export const ARCHIVE_MANIFEST_FILE = 'archive-manifest.json';

export const ARCHIVE_LAYOUT = {
  state: 'state/session-state.json',
  audit: 'audit/audit.jsonl',
  receipts: 'audit/decision-receipts.v1.json',
  discovery: 'context/discovery-snapshot.json',
  profileResolution: 'context/profile-resolution-snapshot.json',
  reviewReport: 'reports/review-report.json',
} as const;

export function archiveArtifactPath(filename: string): string {
  if (filename.startsWith('ticket.')) return `artifacts/ticket/${filename}`;
  if (filename.startsWith('plan.')) return `artifacts/plan/${filename}`;
  if (filename.includes('review-card.')) return `artifacts/reviews/${filename}`;
  if (filename.startsWith('ADR-')) return `artifacts/architecture/${filename}`;
  return `artifacts/other/${filename}`;
}

export function archiveImplementationPath(filename: string): string {
  return `implementation/${filename}`;
}

export function archivePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}
