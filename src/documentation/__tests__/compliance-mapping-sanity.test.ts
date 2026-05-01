/**
 * @module documentation/__tests__/compliance-mapping-sanity
 * @description Sanity guards for compliance mapping documentation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Phase } from '../../state/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const COMPLIANCE_MAPPINGS = [
  'docs/bsi-c5-mapping.md',
  'docs/marisk-mapping.md',
  'docs/ba-it-mapping.md',
  'docs/dora-mapping.md',
  'docs/gobd-mapping.md',
] as const;

function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

describe('documentation/compliance-mapping-sanity', () => {
  describe('HAPPY — mappings are linked from docs index', () => {
    it('docs/index.md links every compliance mapping', () => {
      const index = readDoc('docs/index.md');
      for (const mapping of COMPLIANCE_MAPPINGS) {
        expect(index).toContain(`./${mapping.replace('docs/', '')}`);
      }
    });
  });

  describe('BAD — mappings cannot claim certification or full control satisfaction', () => {
    it('each mapping contains explicit building-block / organization-responsibility language', () => {
      for (const mapping of COMPLIANCE_MAPPINGS) {
        const content = readDoc(mapping);
        expect(
          content.toLowerCase(),
          `${mapping} must avoid certification positioning`,
        ).not.toContain('certified compliant');
        expect(content, `${mapping} must state FlowGuard alone is insufficient`).toContain(
          'FlowGuard alone does not satisfy',
        );
        expect(content, `${mapping} must assign residual controls to the organization`).toContain(
          'Organization Must Provide',
        );
      }
    });
  });

  describe('CORNER — runtime facts in mappings stay current', () => {
    it('does not contain stale phase-count or event-kind claims', () => {
      for (const mapping of COMPLIANCE_MAPPINGS) {
        const content = readDoc(mapping);
        expect(content).not.toContain('8-phase');
        expect(content).not.toContain('4 structured event kinds');
        if (content.includes('explicit workflow phases')) {
          expect(content).toContain(`${Phase.options.length} explicit workflow phases`);
        }
      }
    });
  });

  describe('EDGE — mapping tables use relevance taxonomy consistently', () => {
    it('each mapping has a summary and at least one direct or partial contribution', () => {
      for (const mapping of COMPLIANCE_MAPPINGS) {
        const content = readDoc(mapping);
        expect(content).toMatch(/## (Domain )?Mapping Summary/);
        expect(content).toMatch(/\*\*Direct\*\*|Partial/);
        expect(content).toContain('Not Applicable');
      }
    });
  });
});
