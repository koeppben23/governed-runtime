/**
 * @module architecture/review-zone-policy.test
 * @description Negative fixtures and contract proofs for the review zone
 * policy. The real-tree activation (declared edge set measured on the final
 * decomposition) is asserted here once the zones exist.
 *
 * @version v1
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_PLACEMENT_ZONES,
  type IntegrationPlacementZone,
} from './integration-placement-policy.js';
import { collectProductionSources } from './production-source.js';
import {
  analyzeReviewZonePolicy,
  DECLARED_REVIEW_ZONE_EDGES,
  describeZoneEdges,
  resolveSpecifier,
  zoneEdgeKey,
  type ReviewZoneSource,
} from './review-zone-policy.js';

const ZONES: readonly IntegrationPlacementZone[] = [
  { id: 'root', dir: 'integration', description: 'fixture integration root' },
  { id: 'review', dir: 'integration/review', description: 'fixture review root' },
  { id: 'review/dispatch', dir: 'integration/review/dispatch', description: 'fixture dispatch' },
  { id: 'review/evidence', dir: 'integration/review/evidence', description: 'fixture evidence' },
  { id: 'tools', dir: 'integration/tools', description: 'fixture tools' },
];

function source(rel: string, content: string): ReviewZoneSource {
  return { rel, content };
}

function analyze(sources: readonly ReviewZoneSource[], declared: readonly string[]): string[] {
  return analyzeReviewZonePolicy({
    sources,
    zones: ZONES,
    declaredEdges: new Set(declared),
  }).map((violation) => violation.rule);
}

describe('review zone policy', () => {
  it('renders zone edges deterministically for diagnostics', () => {
    expect(describeZoneEdges(['review/b -> review/c', 'review/a -> review/b'])).toBe(
      'review/a -> review/b\nreview/b -> review/c',
    );
  });

  it('resolves relative specifiers including extensionless facade paths', () => {
    expect(resolveSpecifier('integration/review/dispatch/a.ts', '../index.js')).toBe(
      'integration/review/index.ts',
    );
    expect(resolveSpecifier('integration/tools/plan/x.ts', '../../review/index')).toBe(
      'integration/review/index.ts',
    );
    expect(resolveSpecifier('integration/tools/z.ts', './index.js')).toBe(
      'integration/tools/index.ts',
    );
  });

  it('accepts an observed edge exactly equal to the declared edge', () => {
    expect(
      analyze(
        [source('integration/review/dispatch/a.ts', `import { x } from '../evidence/b.js';`)],
        [zoneEdgeKey('review/dispatch', 'review/evidence')],
      ),
    ).toEqual([]);
  });

  it('fires on an undeclared observed edge', () => {
    expect(
      analyze(
        [source('integration/review/dispatch/a.ts', `import { x } from '../evidence/b.js';`)],
        [],
      ),
    ).toEqual(['undeclared-zone-edge']);
  });

  it('fires on a stale declared edge', () => {
    expect(analyze([], [zoneEdgeKey('review/dispatch', 'review/evidence')])).toEqual([
      'stale-zone-edge',
    ]);
  });

  it('fires on every production import of the facade', () => {
    expect(
      analyze(
        [
          source('integration/review/dispatch/a.ts', `import { x } from '../index.js';`),
          source('integration/review/b.ts', `import { x } from './index.js';`),
          source('integration/tools/plan/x.ts', `import { x } from '../../review/index.js';`),
          source('integration/tools/plan/y.ts', `import { x } from '../../review/index';`),
        ],
        [],
      ),
    ).toEqual([
      'production-facade-import',
      'production-facade-import',
      'production-facade-import',
      'production-facade-import',
    ]);
  });

  it('detects facade imports whose specifier is separated by a comment', () => {
    expect(
      analyze(
        [
          source('integration/review/dispatch/a.ts', `import { x } from /* c */ '../index.js';`),
          source('integration/review/dispatch/b.ts', `export { x } from /* c */ '../index.js';`),
          source('integration/review/dispatch/c.ts', `await import(/* c */ '../index.js');`),
          source('integration/review/dispatch/d.ts', `const x = require(/* c */ '../index.js');`),
        ],
        [],
      ),
    ).toEqual([
      'production-facade-import',
      'production-facade-import',
      'production-facade-import',
      'production-facade-import',
    ]);
  });

  it('detects import-equals require references to the facade and other zones', () => {
    expect(
      analyze(
        [source('integration/review/dispatch/a.ts', `import review = require('../index.js');`)],
        [],
      ),
    ).toEqual(['production-facade-import']);

    expect(
      analyze(
        [
          source(
            'integration/review/dispatch/b.ts',
            `import evidence = require('../evidence/b.js');`,
          ),
        ],
        [],
      ),
    ).toEqual(['undeclared-zone-edge']);
  });

  it('ignores commented-out imports and import-looking string content', () => {
    expect(
      analyze(
        [
          source('integration/review/dispatch/a.ts', `// import { x } from '../index.js';`),
          source(
            'integration/review/dispatch/b.ts',
            `const text = "import { x } from '../index.js'";`,
          ),
          source('integration/review/dispatch/c.ts', `/* export * from '../evidence/b.js'; */`),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('detects a zone edge whose specifier is separated by a comment', () => {
    expect(
      analyze(
        [
          source(
            'integration/review/dispatch/d.ts',
            `import { x } from /* comment */ '../evidence/b.js';`,
          ),
        ],
        [],
      ),
    ).toEqual(['undeclared-zone-edge']);
  });

  it('does not flag a same-named index outside the review facade', () => {
    expect(
      analyze(
        [
          source('integration/tools/z.ts', `import { x } from './index.js';`),
          source('integration/tools/w.ts', `import { x } from '../review/types.js';`),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('excludes the facade outgoing edges from the zone graph', () => {
    expect(
      analyze([source('integration/review/index.ts', `export * from './evidence/b.js';`)], []),
    ).toEqual([]);
  });

  it('ignores test sources', () => {
    expect(
      analyze(
        [source('integration/review/dispatch/a.test.ts', `import { x } from '../evidence/b.js';`)],
        [],
      ),
    ).toEqual([]);
  });
});

describe('review zone policy — real tree', () => {
  const sources = collectProductionSources(join(process.cwd(), 'src'));

  it('keeps the observed zone graph exactly equal to the declared edge set', () => {
    const violations = analyzeReviewZonePolicy({
      sources,
      zones: INTEGRATION_PLACEMENT_ZONES,
      declaredEdges: DECLARED_REVIEW_ZONE_EDGES,
    });
    if (violations.length > 0) {
      console.error(
        'review zone violations:\n' +
          violations.map((violation) => `  - ${violation.file}: ${violation.message}`).join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });

  it('is non-vacuous: the policy declares edges and every review zone is populated and budgeted', () => {
    expect(DECLARED_REVIEW_ZONE_EDGES.size).toBeGreaterThan(0);

    const reviewZones = INTEGRATION_PLACEMENT_ZONES.filter(
      (zone) => zone.id === 'review' || zone.id.startsWith('review/'),
    );
    expect(reviewZones.length).toBe(9);

    const productionFiles = sources.map((source) => source.rel);
    for (const zone of reviewZones) {
      const files = productionFiles.filter(
        (rel) =>
          rel.startsWith('integration/review/') &&
          rel.split('/').slice(0, -1).join('/') === zone.dir,
      );
      expect(files.length, zone.id).toBeGreaterThan(0);
      expect(zone.maxProductionFiles, zone.id).toBeDefined();
      expect(files.length, zone.id).toBeLessThanOrEqual(zone.maxProductionFiles ?? 0);
    }
  });
});
