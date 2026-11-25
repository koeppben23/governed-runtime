/**
 * @module audit/iso27001/render-markdown.test
 * @description Injection-safety and determinism tests for the Markdown view.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { parseIso27001EvidenceMapping, mappingDigestOf } from './mapping-schema.js';
import { projectIso27001Report } from './project.js';
import {
  escapeMarkdownCell,
  escapeMarkdownText,
  renderIso27001Markdown,
} from './render-markdown.js';
import {
  makeIsoState,
  makeVerifiedSnapshot,
  MATCHING_LIVE_BINDING,
} from './iso27001-test-helpers.js';

const HOSTILE = 'x|`**<script>alert(1)</script>**\u0007[link](https://evil.example)';

function hostileReport() {
  const result = parseIso27001EvidenceMapping({
    mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
    framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
    organizationId: 'acme-secdev',
    ismsScopeId: 'isms-prod-2026',
    mappingVersion: '1.0',
    owner: 'owner',
    approval: {
      reference: 'ref',
      approvedAt: '2026-01-15T10:00:00.000Z',
      assertedBy: 'asserted',
    },
    rules: [
      {
        ruleId: 'injection',
        controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.25' },
        policyRequirementId: 'SDLC-01',
        applicability: 'asserted_applicable',
        evidence: [{ kind: 'validation.check_supported', checkId: HOSTILE }],
      },
    ],
  });
  if (!result.ok) throw new Error('fixture mapping invalid');
  const snapshot = makeVerifiedSnapshot(makeIsoState(), []);
  return projectIso27001Report({
    mapping: result.mapping,
    mappingDigest: mappingDigestOf(result.mapping),
    verified: snapshot,
    liveBinding: MATCHING_LIVE_BINDING,
    generatedAt: '2026-02-01T00:00:00.000Z',
  });
}

describe('audit/iso27001/render-markdown', () => {
  describe('HAPPY — the document carries the required boundary language', () => {
    it('renders the disclaimer, evidence package identity and limitations', () => {
      const markdown = renderIso27001Markdown(hostileReport());
      expect(markdown).toContain('# ISO/IEC 27001:2022 Evidence-to-Control Report');
      expect(markdown).toContain('not');
      expect(markdown).toContain('ISO/IEC 27001 conformity assessment');
      expect(markdown).toContain('## Evidence package');
      expect(markdown).toContain('## Limitations (not attested by FlowGuard)');
      expect(markdown).toContain('EXTERNAL_AUTHENTICITY_NOT_ANCHORED');
      expect(markdown).toContain('## Referenced ownership');
    });

    it('is deterministic for identical reports', () => {
      const report = hostileReport();
      expect(renderIso27001Markdown(report)).toBe(renderIso27001Markdown(report));
    });
  });

  describe('BAD — hostile values cannot inject structure, HTML or links', () => {
    it('neutralizes markdown structure, HTML and link syntax', () => {
      const markdown = renderIso27001Markdown(hostileReport());
      expect(markdown).not.toContain('<script>');
      expect(markdown).not.toContain('[link](https://evil.example)');
      expect(markdown).not.toContain('\u0007');
      expect(markdown).toContain('&lt;script&gt;');
    });

    it('escapes representative hostile text and cell values', () => {
      expect(escapeMarkdownText(HOSTILE)).not.toMatch(/<script>/);
      expect(escapeMarkdownText(HOSTILE)).toContain('\\`');
      expect(escapeMarkdownCell(HOSTILE)).toContain('\\|');
      expect(escapeMarkdownText('a|b')).toBe('a|b');
      expect(escapeMarkdownCell('a|b')).toBe('a\\|b');
      expect(escapeMarkdownText('line1\nline2')).toBe('line1 line2');
    });
  });

  describe('CORNER — bounds and control characters', () => {
    it('bounds value length and replaces terminal control characters', () => {
      const long = 'a'.repeat(1000);
      expect(escapeMarkdownText(long).length).toBeLessThanOrEqual(200);
      expect(escapeMarkdownText('a\u001b[31mb')).toBe('a \\[31mb');
    });

    it('keeps table rows well-formed with escaped pipes', () => {
      const markdown = renderIso27001Markdown(hostileReport());
      const tableLines = markdown.split('\n').filter((line) => line.startsWith('| A.8.25'));
      expect(tableLines.length).toBe(1);
      const cells = tableLines[0]!.split(/(?<!\\)\|/);
      expect(cells.length).toBe(7);
    });
  });

  describe('EDGE — non-ASCII and empty values stay readable', () => {
    it('preserves normal unicode and renders empty detail-free findings', () => {
      expect(escapeMarkdownText('Sicherheitsprüfung')).toBe('Sicherheitsprüfung');
      const markdown = renderIso27001Markdown(hostileReport());
      expect(markdown).toContain('EVIDENCE_MISSING');
      expect(markdown.endsWith('\n')).toBe(true);
    });

    it('never renders a raw actor identity, only its digest', () => {
      const markdown = renderIso27001Markdown(hostileReport());
      expect(markdown).not.toContain('reviewer');
      expect(markdown).not.toContain('@');
    });
  });
});
