/**
 * @module discovery/discovery.test
 * @description Tests for the Discovery system — types, collectors, orchestrator, and archive types.
 *
 * Tests split into individual files per module:
 *   - discovery-types.test.ts        (discovery types + archive types schema validation)
 *   - discovery-stack-core.test.ts   (stack detection core)
 *   - discovery-version.test.ts      (version extraction)
 *   - discovery-artifact.test.ts     (artifact detection — pom.xml / build.gradle)
 *   - discovery-ecosystem.test.ts    (JS/TS/Python/Rust/Go ecosystem detection)
 *   - discovery-collectors.test.ts   (topology, surface, domain, code-surface collectors)
 *   - discovery-orchestrator.test.ts (runDiscovery, extractDiscoverySummary, computeDiscoveryDigest)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPLIT_FILES = [
  'discovery-types.test.ts',
  'discovery-stack-core.test.ts',
  'discovery-version.test.ts',
  'discovery-artifact.test.ts',
  'discovery-ecosystem.test.ts',
  'discovery-collectors.test.ts',
  'discovery-orchestrator.test.ts',
];

describe('discovery.test.ts — facade', () => {
  it('all split test files exist', () => {
    for (const f of SPLIT_FILES) {
      const exists = fs.existsSync(path.join(__dirname, f));
      expect(exists, `missing: ${f}`).toBe(true);
    }
  });
});
