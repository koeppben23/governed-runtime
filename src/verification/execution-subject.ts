/**
 * @module verification/execution-subject
 * @description Execution Subject Attestation — types and pure attestation logic.
 *
 * The canonical schema for ExecutionSubjectInput lives in
 * state/discovery-schemas.ts so it can be persisted as part of the
 * verification plan. This module provides the runtime attestation functions
 * that verify surfaces before and after execution.
 *
 * Implementation re-attestation re-computes the governed implementation
 * digest from actual worktree file contents and compares it with the
 * session-state digest. Configuration-surface attestation is incomplete:
 * config files (vitest.config.*, jest.config.*, etc.) are not yet covered.
 * See KNOWN_ISSUES.md.
 *
 * @version v2
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashText } from '../shared/hashing.js';
import { hashWorktreeFiles } from '../adapters/git.js';
import type { ExecutionSubjectInput as InputFromSchema } from '../state/discovery-schemas.js';
import { computeContentDigest } from '../state/evidence-candidate.js';
import type { RepositoryPath } from '../state/evidence-review.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExecutionSubjectInput = InputFromSchema;

export interface ExecutionSubjectAttestation {
  readonly inputs: readonly ExecutionSubjectInput[];
  readonly digest: string;
  readonly surfaceDigests: ReadonlyMap<string, string>;
}

export type AttestationResult =
  | { readonly kind: 'ok'; readonly attestation: ExecutionSubjectAttestation }
  | {
      readonly kind: 'subject_changed';
      readonly component: 'implementation' | 'execution_surface';
      readonly phase: 'pre_execution' | 'post_execution';
      readonly detail: string;
    };

// ─── Attestation ────────────────────────────────────────────────────────────

export async function attestExecutionSubject(
  inputs: readonly ExecutionSubjectInput[],
  worktree: string,
  implementationDigest: string,
  changedFiles: readonly string[],
): Promise<AttestationResult> {
  if (inputs.length === 0) {
    return {
      kind: 'ok',
      attestation: { inputs, digest: hashText('no-surfaces'), surfaceDigests: new Map() },
    };
  }

  const surfaceDigests = new Map<string, string>();
  const parts: string[] = [];

  for (const input of inputs) {
    if (input.kind === 'implementation') {
      if (changedFiles.length === 0) continue;
      const sortedFiles = [...changedFiles].sort();
      const hashes = await hashWorktreeFiles(worktree, sortedFiles);
      const entries = sortedFiles.map((f) => ({
        path: f as RepositoryPath,
        state: (hashes[f] !== null ? 'present' : 'deleted') as 'present' | 'deleted',
        blobDigest: hashes[f] ?? null,
      }));
      const digest = computeContentDigest(entries);
      if (digest !== implementationDigest) {
        return {
          kind: 'subject_changed',
          component: 'implementation',
          phase: 'pre_execution',
          detail: `implementation digest mismatch: expected ${implementationDigest.slice(0, 8)}..., computed ${digest.slice(0, 8)}...`,
        };
      }
      surfaceDigests.set('implementation', digest);
      parts.push(`implementation:${digest}`);
    } else if (input.kind === 'file') {
      try {
        const content = readFileSync(join(worktree, input.path), 'utf-8');
        const digest = hashText(content);
        surfaceDigests.set(input.path, digest);
        parts.push(`${input.path}:${digest}`);
      } catch {
        return {
          kind: 'subject_changed',
          component: 'execution_surface',
          phase: 'pre_execution',
          detail: `cannot read execution surface: ${input.path}`,
        };
      }
    }
  }

  return {
    kind: 'ok',
    attestation: {
      inputs,
      digest: hashText(parts.sort().join('\n')),
      surfaceDigests,
    },
  };
}

export async function reattestExecutionSubject(
  inputs: readonly ExecutionSubjectInput[],
  worktree: string,
  preAttestation: ExecutionSubjectAttestation,
  implementationDigest: string,
  changedFiles: readonly string[],
): Promise<AttestationResult> {
  for (const input of inputs) {
    if (input.kind === 'implementation') {
      if (changedFiles.length === 0) continue;
      const sortedFiles = [...changedFiles].sort();
      const hashes = await hashWorktreeFiles(worktree, sortedFiles);
      const entries = sortedFiles.map((f) => ({
        path: f as RepositoryPath,
        state: (hashes[f] !== null ? 'present' : 'deleted') as 'present' | 'deleted',
        blobDigest: hashes[f] ?? null,
      }));
      const digest = computeContentDigest(entries);
      const expected = preAttestation.surfaceDigests.get('implementation');
      if (expected !== undefined && digest !== expected) {
        return {
          kind: 'subject_changed',
          component: 'implementation',
          phase: 'post_execution',
          detail: `implementation digest changed during execution: expected ${expected.slice(0, 8)}..., computed ${digest.slice(0, 8)}...`,
        };
      }
    } else if (input.kind === 'file') {
      try {
        const content = readFileSync(join(worktree, input.path), 'utf-8');
        const digest = hashText(content);
        const expected = preAttestation.surfaceDigests.get(input.path);
        if (expected !== undefined && digest !== expected) {
          return {
            kind: 'subject_changed',
            component: 'execution_surface',
            phase: 'post_execution',
            detail: `${input.path} changed during execution`,
          };
        }
      } catch {
        return {
          kind: 'subject_changed',
          component: 'execution_surface',
          phase: 'post_execution',
          detail: `cannot re-read execution surface: ${input.path}`,
        };
      }
    }
  }
  return {
    kind: 'ok',
    attestation: preAttestation,
  };
}
