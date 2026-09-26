/**
 * @module documentation/developer-docs-symbols
 * @description Targeted drift guards for the corrected developer documents.
 *
 * These tests pin the specific claims fixed with the documentation integrity
 * pass: PERF budget key names, the reason-code module inventory, the plugin
 * hook composition surface, the challenge-binding call paths, and the
 * canonical-authority precedence. They derive lists from the repository where
 * possible instead of restating them.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERF_BUDGETS } from '../../test-policy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('developer documentation symbols', () => {
  it('names the real PERF_BUDGETS keys in the testing strategy', () => {
    const docs = read('docs/testing-strategy.md');
    const keys = [
      'stateSerializeMs',
      'stateIoRoundTripMs',
      'stateGovernedWriteMs',
      'auditChainVerify1000Ms',
    ];

    for (const key of keys) {
      expect(Object.hasOwn(PERF_BUDGETS, key), key).toBe(true);
      expect(docs, key).toContain(`\`${key}\``);
    }
    for (const stale of ['serializeRoundtripMs', 'stateIoRoundtripMs', 'auditChainVerifyMs']) {
      expect(docs, stale).not.toContain(stale);
    }
  });

  it('documents every reason-code module and the barrel/types split', () => {
    const agents = read('src/config/AGENTS.md');
    const barrel = read('src/config/reasons.ts');
    const reasonFiles = readdirSync(join(ROOT, 'src', 'config')).filter(
      (name) => /^reasons(-[a-z-]+)?\.ts$/.test(name) && !name.endsWith('.test.ts'),
    );
    const modules = reasonFiles.filter(
      (name) => name !== 'reasons.ts' && name !== 'reasons-types.ts',
    );
    const importedByBarrel = modules.filter((name) =>
      barrel.includes(`'./${name.replace(/\.ts$/, '.js')}'`),
    );

    expect(modules).toHaveLength(12);
    expect(importedByBarrel).toHaveLength(6);
    for (const moduleFile of modules) {
      expect(agents, moduleFile).toContain(moduleFile);
    }
    expect(agents).toContain('reasons.ts');
    expect(agents).toContain('reasons-types.ts');
    expect(agents).not.toContain('re-exported through the barrel');
  });

  it('points hook registration at the real composition surface', () => {
    const agents = read('src/integration/AGENTS.md');
    const plugin = read('src/integration/plugin.ts');
    const orchestrator = read('src/integration/plugin-orchestrator.ts');

    expect(plugin).toContain('createFlowGuardPluginHooks');
    expect(orchestrator).toContain('export type { OrchestratorDeps }');
    expect(agents).toContain('plugin.ts');
    expect(agents).toContain('createFlowGuardPluginHooks');
    expect(agents).not.toContain('register it in the plugin orchestrator');
  });

  it('describes the real challenge-binding call paths', () => {
    const review = read('docs/independent-review.md');

    expect(review).not.toContain('resolveHostTaskFindings');
    expect(review).not.toContain('resolveHostTaskEffectiveFindings');
    expect(review).toContain('resolveStructuredFindings');
    expect(review).toContain('resolveStructuredEffectiveFindings');
    expect(review).toContain('validatePreBindFindings');

    expect(read('src/integration/review/validation/review-validation.ts')).toContain(
      'export function resolveStructuredEffectiveFindings',
    );
    expect(
      read('src/integration/review/validation/review-validation-structured-evidence.ts'),
    ).toContain('export function resolveStructuredFindings');
    expect(read('src/integration/review/observations/pre-bind-findings.ts')).toContain(
      'export function validatePreBindFindings',
    );
  });

  it('keeps AGENTS.md canonical and the layer table a projection', () => {
    const map = read('docs/development/architecture-map.md');
    const agents = read('AGENTS.md');

    expect(agents).toContain('## Canonical Authorities');
    expect(map).toContain('canonical authority list lives in');
    expect(map).toContain('AGENTS.md');
    expect(map).toContain('projection of');
  });

  it('labels AGENTS.md as local contributor guidance in the docs index', () => {
    expect(read('docs/index.md')).toContain('Local contributor guidance');
  });
});
