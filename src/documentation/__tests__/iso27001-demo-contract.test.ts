/**
 * @module documentation/__tests__/iso27001-demo-contract
 * @description Keeps the offline ISO/IEC 27001:2022 demo, its seed files, its
 * mappings, and its README aligned with the product contracts.
 *
 * The end-to-end execution of the demo runs in the smoke project
 * (`src/cli/iso27001-demo.smoke.test.ts`); this suite fails fast on schema
 * drift, mapping drift, or documentation drift without requiring a build.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyChain } from '../../audit/integrity.js';
import { parseIso27001EvidenceMapping } from '../../audit/iso27001/mapping-schema.js';
import { AuditEvent } from '../../state/evidence-audit.js';
import type { AssertionExtractionResult } from '../../state/evidence-validation.js';
import { hasCurrentPlanApprovalCertificateForState } from '../../state/proofgraph-approval-context.js';
import { SessionState } from '../../state/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const DEMO_DIR = join(REPO_ROOT, 'demos', 'iso27001-evidence-mapping');
const README_PATH = join(DEMO_DIR, 'README.md');
const SCRIPT_PATH = join(DEMO_DIR, 'run-demo.mjs');
const SEED_DIR = join(DEMO_DIR, 'seed');

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readText(filePath)) as unknown;
}

describe('documentation/iso27001-demo-contract', () => {
  describe('HAPPY — the documented single call runs all three scenarios', () => {
    it('README documents the offline command, the boundaries and all scenarios', () => {
      const readme = readText(README_PATH);
      expect(readme).toContain('node demos/iso27001-evidence-mapping/run-demo.mjs');
      expect(readme).toContain('npm run build');
      expect(readme).toContain('temporary, standalone foreign git repository');
      expect(readme).toContain('synthetic');
      expect(readme).toContain('not** an ISO/IEC 27001 conformity');
      expect(readme).toContain('Positive');
      expect(readme).toContain('Negative');
      expect(readme).toContain('Tampered');
      expect(readme).toContain('EVIDENCE_LINKED_VERIFIED');
      expect(readme).toContain('ASSERTION_SKIPPED');
      expect(readme).toContain('ASSERTION_BINDING_NOT_ATTESTED');
      expect(readme).toContain('PACKAGE_UNVERIFIABLE');
    });

    it('the demo script uses the canonical export and verification adapters', () => {
      const script = readText(SCRIPT_PATH);
      expect(script).toContain('archiveCompletionExport');
      expect(script).toContain('verifyCompletionExport');
      expect(script).toContain('materializeEvidenceArtifacts');
      expect(script).toContain('appendAuditEvent');
      expect(script).toContain('planApprovalCertificateIdentity');
      // The demo runs from the checkout's dist build; it must not depend on an
      // installed @flowguard/core package.
      expect(script).not.toContain("from '@flowguard/core'");
      expect(script).not.toContain('from "@flowguard/core"');
    });

    it('the demo script parses as a Node module', () => {
      expect(() => execFileSync(process.execPath, ['--check', SCRIPT_PATH])).not.toThrow();
    });
  });

  describe('BAD — seed mappings stay strict and cover the required scenarios', () => {
    it('parses the positive mapping with the full change-control rule', () => {
      const parsed = parseIso27001EvidenceMapping(
        readJson(join(SEED_DIR, 'mapping.positive.json')),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const ruleIds = parsed.mapping.rules.map((rule) => rule.ruleId);
      expect(ruleIds).toEqual(['sec-testing', 'change-control', 'export-evidence']);
      const changeControl = parsed.mapping.rules.find((rule) => rule.ruleId === 'change-control');
      expect(changeControl?.controlRef.controlId).toBe('A.8.32');
      expect(changeControl?.evidence.map((selector) => selector.kind)).toEqual([
        'plan.approved',
        'implementation.revision',
        'review.human_approval_decision',
      ]);
    });

    it('parses the negative mapping with isolated checks per denial mode', () => {
      const parsed = parseIso27001EvidenceMapping(
        readJson(join(SEED_DIR, 'mapping.negative.json')),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const byId = new Map(parsed.mapping.rules.map((rule) => [rule.ruleId, rule]));
      const skipped = byId.get('skipped-assertion');
      const aggregate = byId.get('aggregate-not-attested');
      expect(skipped).toBeDefined();
      expect(aggregate).toBeDefined();
      // Distinct checks keep the last-attempt semantics isolated per selector.
      const checkIdOf = (kind: string, rule: (typeof parsed.mapping.rules)[number]): string => {
        const selector = rule.evidence.find((entry) => entry.kind === kind);
        if (selector === undefined || selector.kind !== 'validation.assertion_passed') {
          throw new Error(`missing assertion selector in ${rule.ruleId}`);
        }
        return selector.checkId;
      };
      expect(checkIdOf('validation.assertion_passed', skipped!)).toBe('integration');
      expect(checkIdOf('validation.assertion_passed', aggregate!)).toBe('regression');
    });
  });

  describe('CORNER — the seeded state is schema-valid with a current certificate', () => {
    const state = SessionState.parse(readJson(join(SEED_DIR, 'session-state.template.json')));

    it('seeds the documented pre-completion boundary', () => {
      expect(state.phase).toBe('EXPORT_READY');
      expect(state.binding.worktree).toBe('__DEMO_WORKTREE__');
      expect(state.exportCompletionEvidence).toBeNull();
    });

    it('carries a current plan approval certificate for its own binding', () => {
      expect(hasCurrentPlanApprovalCertificateForState(state)).toBe(true);
    });

    it('isolates passed, skipped and aggregate evidence on distinct checks', () => {
      const byCheck = new Map(
        state.validationAttempts.map((attempt) => [attempt.result.checkId, attempt]),
      );
      const test = byCheck.get('test');
      const integration = byCheck.get('integration');
      const regression = byCheck.get('regression');
      expect(test?.result.assertionExtraction).toMatchObject({
        status: 'extracted',
        bindingCapability: 'assertion',
      });
      expect(integration?.result.assertionExtraction).toMatchObject({
        status: 'extracted',
        bindingCapability: 'assertion',
      });
      expect(regression?.result.assertionExtraction).toMatchObject({
        status: 'extracted',
        bindingCapability: 'aggregate',
      });
      const assertionStatus = (
        extraction: AssertionExtractionResult | undefined,
      ): string | undefined =>
        extraction?.status === 'extracted' ? extraction.assertions[0]?.status : undefined;
      expect(assertionStatus(test?.result.assertionExtraction)).toBe('passed');
      expect(assertionStatus(integration?.result.assertionExtraction)).toBe('skipped');
    });
  });

  describe('EDGE — the seeded audit trail is a valid chain ending at the export gate', () => {
    const events = readText(join(SEED_DIR, 'audit.jsonl'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => AuditEvent.parse(JSON.parse(line) as unknown));

    it('parses as canonical audit-chain.v3 events and verifies', () => {
      expect(events.length).toBeGreaterThanOrEqual(6);
      expect(events.every((event) => event.auditFormatVersion === 'audit-chain.v3')).toBe(true);
      expect(verifyChain(events).valid).toBe(true);
    });

    it('ends with the canonical EVIDENCE_REVIEW approval into EXPORT_READY', () => {
      const last = events.at(-1);
      expect(last?.event).toBe('decision:DEC-002');
      expect(last?.detail.gatePhase).toBe('EVIDENCE_REVIEW');
      expect(last?.detail.fromPhase).toBe('EVIDENCE_REVIEW');
      expect(last?.detail.toPhase).toBe('EXPORT_READY');
      expect(last?.detail.transitionEvent).toBe('APPROVE');
    });
  });
});
