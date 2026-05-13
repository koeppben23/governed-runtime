/**
 * @module barrel-exports.test
 * @description Regression tests for adapters/workspace and presentation barrel exports.
 *
 * Proves:
 * - Barrels export exactly the expected public symbols (no API expansion)
 * - Barrels do NOT export private/internal symbols
 * - Integration files use barrel imports (not deep paths)
 *
 * Test categories: HAPPY, BAD, CORNER, EDGE, SMOKE, E2E.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '.');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// adapters/workspace/index.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('adapters/workspace/index.ts barrel', () => {
  const EXPECTED_EVIDENCE_ARTIFACT_EXPORTS = [
    'materializeEvidenceArtifacts',
    'materializeReviewCardArtifact',
    'verifyEvidenceArtifacts',
  ] as const;

  const INTERNAL_SYMBOLS = [
    'EvidenceArtifactErrorCode',
    'EvidenceArtifactError',
    'EVIDENCE_ARTIFACT_SCHEMA_VERSION',
  ] as const;

  describe('HAPPY — barrel exports expected symbols', () => {
    it('re-exports materializeEvidenceArtifacts', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect(typeof mod.materializeEvidenceArtifacts).toBe('function');
    });

    it('re-exports materializeReviewCardArtifact', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect(typeof mod.materializeReviewCardArtifact).toBe('function');
    });

    it('re-exports verifyEvidenceArtifacts', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect(typeof mod.verifyEvidenceArtifacts).toBe('function');
    });
  });

  describe('BAD — no API expansion', () => {
    it('does NOT export EvidenceArtifactErrorCode', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect('EvidenceArtifactErrorCode' in mod).toBe(false);
    });

    it('does NOT export EvidenceArtifactError', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect('EvidenceArtifactError' in mod).toBe(false);
    });

    it('does NOT export EVIDENCE_ARTIFACT_SCHEMA_VERSION', async () => {
      const mod = await import('./adapters/workspace/index.js');
      expect('EVIDENCE_ARTIFACT_SCHEMA_VERSION' in mod).toBe(false);
    });
  });

  describe('CORNER — index.ts contains explicit evidence-artifacts re-exports', () => {
    it('index.ts has evidence-artifacts import', () => {
      const source = readSource('adapters/workspace/index.ts');
      expect(source).toContain("from './evidence-artifacts.js'");
    });

    it('index.ts re-exports all 3 evidence artifact symbols', () => {
      const source = readSource('adapters/workspace/index.ts');
      for (const sym of EXPECTED_EVIDENCE_ARTIFACT_EXPORTS) {
        expect(source).toContain(sym);
      }
    });
  });

  describe('EDGE — internal symbols not mentioned in index.ts', () => {
    it('index.ts does not mention internal symbols', () => {
      const source = readSource('adapters/workspace/index.ts');
      for (const sym of INTERNAL_SYMBOLS) {
        expect(source).not.toContain(sym);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// presentation/index.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('presentation/index.ts barrel', () => {
  const EXPECTED_EXPORTS = [
    'PHASE_LABELS',
    'buildProductNextAction',
    'buildPlanReviewCard',
    'buildArchitectureReviewCard',
    'buildReviewReportCard',
  ] as const;

  const INTERNAL_SYMBOLS = [
    'PlanReviewCardInput',
    'ArchitectureReviewCardInput',
    'ReviewReportCardInput',
    'PRODUCT_GUIDANCE',
  ] as const;

  describe('HAPPY — barrel exports expected symbols', () => {
    it('re-exports PHASE_LABELS', async () => {
      const mod = await import('./presentation/index.js');
      expect(typeof mod.PHASE_LABELS).toBe('object');
      expect(mod.PHASE_LABELS.READY).toBe('Ready');
    });

    it('re-exports buildProductNextAction', async () => {
      const mod = await import('./presentation/index.js');
      expect(typeof mod.buildProductNextAction).toBe('function');
    });

    it('re-exports buildPlanReviewCard', async () => {
      const mod = await import('./presentation/index.js');
      expect(typeof mod.buildPlanReviewCard).toBe('function');
    });

    it('re-exports buildArchitectureReviewCard', async () => {
      const mod = await import('./presentation/index.js');
      expect(typeof mod.buildArchitectureReviewCard).toBe('function');
    });

    it('re-exports buildReviewReportCard', async () => {
      const mod = await import('./presentation/index.js');
      expect(typeof mod.buildReviewReportCard).toBe('function');
    });
  });

  describe('BAD — no API expansion', () => {
    it('does NOT export PlanReviewCardInput', async () => {
      const mod = await import('./presentation/index.js');
      expect('PlanReviewCardInput' in mod).toBe(false);
    });

    it('does NOT export ArchitectureReviewCardInput', async () => {
      const mod = await import('./presentation/index.js');
      expect('ArchitectureReviewCardInput' in mod).toBe(false);
    });

    it('does NOT export ReviewReportCardInput', async () => {
      const mod = await import('./presentation/index.js');
      expect('ReviewReportCardInput' in mod).toBe(false);
    });

    it('does NOT export internal PRODUCT_GUIDANCE', async () => {
      const mod = await import('./presentation/index.js');
      expect('PRODUCT_GUIDANCE' in mod).toBe(false);
    });
  });

  describe('CORNER — index.ts uses explicit named exports (no export *)', () => {
    it('index.ts has explicit named re-exports from each module', () => {
      const source = readSource('presentation/index.ts');
      expect(source).toContain("from './phase-labels.js'");
      expect(source).toContain("from './next-action-copy.js'");
      expect(source).toContain("from './plan-review-card.js'");
      expect(source).toContain("from './architecture-review-card.js'");
      expect(source).toContain("from './review-report-card.js'");
    });

    it('index.ts does NOT use export *', () => {
      const source = readSource('presentation/index.ts');
      expect(source).not.toContain('export *');
    });
  });

  describe('EDGE — index.ts exports exactly 5 symbols', () => {
    it('exports only the expected set', async () => {
      const mod = await import('./presentation/index.js');
      const keys = Object.keys(mod).sort();
      const expected = [...EXPECTED_EXPORTS].sort();
      expect(keys).toEqual(expected);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration import path regression (SMOKE)
// ═══════════════════════════════════════════════════════════════════════════════

describe('integration tools use barrel imports', () => {
  const INTEGRATION_FILES = [
    'integration/tools/helpers.ts',
    'integration/tools/plan.ts',
    'integration/tools/architecture.ts',
    'integration/tools/simple-tools.ts',
  ] as const;

  describe('SMOKE — no deep imports to presentation', () => {
    it('no integration file deep-imports phase-labels.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../presentation/phase-labels.js');
      }
    });

    it('no integration file deep-imports next-action-copy.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../presentation/next-action-copy.js');
      }
    });

    it('no integration file deep-imports plan-review-card.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../presentation/plan-review-card.js');
      }
    });

    it('no integration file deep-imports architecture-review-card.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../presentation/architecture-review-card.js');
      }
    });

    it('no integration file deep-imports review-report-card.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../presentation/review-report-card.js');
      }
    });
  });

  describe('SMOKE — no deep imports to adapters/workspace/evidence-artifacts', () => {
    it('no integration file deep-imports evidence-artifacts.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).not.toContain('../../adapters/workspace/evidence-artifacts.js');
      }
    });
  });

  describe('HAPPY — integration files use barrel imports', () => {
    it('all 4 files import from presentation/index.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).toContain('../../presentation/index.js');
      }
    });

    it('helpers, plan, architecture, simple-tools import from workspace/index.js', () => {
      for (const file of INTEGRATION_FILES) {
        const source = readSource(file);
        expect(source).toContain('../../adapters/workspace/index.js');
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E2E — symbol identity preservation through barrel
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E — symbol identity through barrel', () => {
  it('PHASE_LABELS direct import equals barrel import', async () => {
    const direct = await import('./presentation/phase-labels.js');
    const barrel = await import('./presentation/index.js');
    expect(barrel.PHASE_LABELS).toBe(direct.PHASE_LABELS);
  });

  it('buildProductNextAction direct import equals barrel import', async () => {
    const direct = await import('./presentation/next-action-copy.js');
    const barrel = await import('./presentation/index.js');
    expect(barrel.buildProductNextAction).toBe(direct.buildProductNextAction);
  });

  it('buildPlanReviewCard direct import equals barrel import', async () => {
    const direct = await import('./presentation/plan-review-card.js');
    const barrel = await import('./presentation/index.js');
    expect(barrel.buildPlanReviewCard).toBe(direct.buildPlanReviewCard);
  });

  it('buildArchitectureReviewCard direct import equals barrel import', async () => {
    const direct = await import('./presentation/architecture-review-card.js');
    const barrel = await import('./presentation/index.js');
    expect(barrel.buildArchitectureReviewCard).toBe(direct.buildArchitectureReviewCard);
  });

  it('buildReviewReportCard direct import equals barrel import', async () => {
    const direct = await import('./presentation/review-report-card.js');
    const barrel = await import('./presentation/index.js');
    expect(barrel.buildReviewReportCard).toBe(direct.buildReviewReportCard);
  });

  it('materializeEvidenceArtifacts direct import equals barrel import', async () => {
    const direct = await import('./adapters/workspace/evidence-artifacts.js');
    const barrel = await import('./adapters/workspace/index.js');
    expect(barrel.materializeEvidenceArtifacts).toBe(direct.materializeEvidenceArtifacts);
  });

  it('materializeReviewCardArtifact direct import equals barrel import', async () => {
    const direct = await import('./adapters/workspace/evidence-artifacts.js');
    const barrel = await import('./adapters/workspace/index.js');
    expect(barrel.materializeReviewCardArtifact).toBe(direct.materializeReviewCardArtifact);
  });

  it('verifyEvidenceArtifacts direct import equals barrel import', async () => {
    const direct = await import('./adapters/workspace/evidence-artifacts.js');
    const barrel = await import('./adapters/workspace/index.js');
    expect(barrel.verifyEvidenceArtifacts).toBe(direct.verifyEvidenceArtifacts);
  });
});
