/**
 * @module architecture/audit-authority-guard
 * @description Pins the canonical audit authority chain: one trail append/read
 * surface, one private JSONL parser, a pure read-model layer, and reconciliation
 * through the audit port. No parallel audit writer or tolerance layer may
 * appear.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRelative } from './repo-path.js';

const SRC = join(process.cwd(), 'src');
const CANONICAL_TRAIL_ADAPTER = 'adapters/persistence-audit.ts';
const CANONICAL_RECONCILER = 'integration/plugin-audit-reconcile.ts';

function listProductionSources(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listProductionSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

function relative(path: string): string {
  return repoRelative(SRC, path);
}

function productionSources(): { readonly rel: string; readonly content: string }[] {
  return listProductionSources(SRC).map((file) => ({
    rel: relative(file),
    content: readFileSync(file, 'utf8'),
  }));
}

describe('canonical audit authority chain', () => {
  it('defines the trail append/read surface in exactly one module', () => {
    const definers = productionSources()
      .filter(
        ({ content }) =>
          content.includes('export async function appendAuditEvent(') ||
          content.includes('export async function readAuditTrail('),
      )
      .map(({ rel }) => rel);
    expect(definers).toEqual([CANONICAL_TRAIL_ADAPTER]);
  });

  it('keeps the JSONL parser private to the canonical trail adapter', () => {
    const definers = productionSources()
      .filter(({ content }) => /function\s+parseAuditTrail\s*\(/.test(content))
      .map(({ rel }) => rel);
    expect(definers).toEqual([CANONICAL_TRAIL_ADAPTER]);
  });

  it('keeps the audit read-model layer free of adapter I/O', () => {
    const query = productionSources().find(({ rel }) => rel === 'audit/query.ts');
    expect(query).toBeDefined();
    expect(query!.content).not.toMatch(/from\s+['"][^'"]*adapters\//);
    expect(query!.content).not.toMatch(/from\s+['"][^'"]*integration\//);
  });

  it('routes state-to-audit reconciliation through the audit port, never a direct writer', () => {
    const reconciler = productionSources().find(({ rel }) => rel === CANONICAL_RECONCILER);
    expect(reconciler).toBeDefined();
    expect(reconciler!.content).toContain('export async function reconcilePendingAuditOperations');
    expect(reconciler!.content).toContain('export async function emitTransitionAudits');
    expect(reconciler!.content).toContain('export async function emitAuditBodyWithEvidence');
    expect(reconciler!.content).not.toContain('appendAuditEvent');
  });
});
