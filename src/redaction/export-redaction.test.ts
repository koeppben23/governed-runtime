import { describe, expect, it } from 'vitest';
import { redactDecisionReceipts, redactReviewReport } from './export-redaction';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';

describe('redaction/export-redaction', () => {
  // ─── HAPPY ────────────────────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('redacts reviewer identity and rationale in decision receipts', () => {
      const input = {
        schemaVersion: 'decision-receipts.v1',
        receipts: [
          { decisionId: 'DEC-001', decidedBy: 'alice', rationale: 'Contains private context' },
        ],
      };
      const output = redactDecisionReceipts(input, 'basic');
      const receipt = output.receipts[0] as Record<string, unknown>;
      expect(receipt.decidedBy).toBe('[REDACTED]');
      expect(receipt.rationale).toBe('[REDACTED]');
    });

    it('redacts basic mode with consistent token for same input', () => {
      const input = {
        receipts: [
          { decidedBy: 'alice', rationale: 'same rationale text' },
          { decidedBy: 'alice', rationale: 'same rationale text' },
        ],
      };
      const output = redactDecisionReceipts(input, 'basic');
      expect((output.receipts[0] as Record<string, unknown>).decidedBy).toBe(
        (output.receipts[1] as Record<string, unknown>).decidedBy,
      );
      expect((output.receipts[0] as Record<string, unknown>).decidedBy).toBe('[REDACTED]');
    });

    it('redacts strict mode with deterministic tokenized masks', () => {
      const input = { receipts: [{ decidedBy: 'alice', rationale: 'same' }] };
      const outA = redactDecisionReceipts(input, 'strict');
      const outB = redactDecisionReceipts(input, 'strict');
      const a = outA.receipts[0] as Record<string, unknown>;
      const b = outB.receipts[0] as Record<string, unknown>;
      expect(a.decidedBy).toBe(b.decidedBy);
      expect(String(a.decidedBy)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strict mode produces different tokens for different inputs', () => {
      const out1 = redactDecisionReceipts({ receipts: [{ decidedBy: 'alice' }] }, 'strict');
      const out2 = redactDecisionReceipts({ receipts: [{ decidedBy: 'bob' }] }, 'strict');
      expect(out1.receipts[0]).not.toEqual(out2.receipts[0]);
    });

    it('mode=none leaves decision receipts unchanged', () => {
      const input = {
        receipts: [{ decisionId: 'DEC-001', decidedBy: 'alice', rationale: 'original' }],
      };
      expect(redactDecisionReceipts(input, 'none')).toEqual(input);
    });

    it('redacts fourEyes initiatedBy and decidedBy in review report', () => {
      const input = {
        findings: [{ checkId: 'test_quality', message: 'contains secret info', passed: true }],
        completeness: {
          fourEyes: { initiatedBy: 'alice', decidedBy: 'bob', detail: 'lgtm' },
        },
      };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const fe = (output.completeness as Record<string, unknown>).fourEyes as Record<
        string,
        unknown
      >;
      expect(fe.initiatedBy).toBe('[REDACTED]');
      expect(fe.decidedBy).toBe('[REDACTED]');
      expect(fe.detail).toBe('[REDACTED]');
      expect((output.findings[0] as Record<string, unknown>).message).toBe('[REDACTED]');
    });

    it('redacts findings message in review report basic mode', () => {
      const input = { findings: [{ message: 'Contains PII: alice@example.com' }] };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect((output.findings[0] as Record<string, unknown>).message).toBe('[REDACTED]');
    });

    it('redacts validationSummary detail in review report', () => {
      const input = { validationSummary: [{ checkId: 'test_quality', detail: 'secret detail' }] };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect((output.validationSummary[0] as Record<string, unknown>).detail).toBe('[REDACTED]');
    });

    it('redacts completeness slots detail in review report', () => {
      const input = {
        completeness: { slots: [{ slot: 'ticket', detail: 'internal note' }] },
      };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const slots = (output.completeness as Record<string, unknown>).slots as Array<
        Record<string, unknown>
      >;
      expect(slots[0]!.detail).toBe('[REDACTED]');
    });

    it('mode=none leaves review report unchanged', () => {
      const input = {
        findings: [{ message: 'plain' }],
        completeness: { fourEyes: { initiatedBy: 'bob', decidedBy: null as unknown } },
      };
      expect(redactReviewReport(input, 'none')).toEqual(input);
    });

    it('redacts deep copies without mutating original', () => {
      const input = {
        receipts: [{ decidedBy: 'alice', rationale: 'original' }],
        findings: [{ message: 'also secret' }],
      };
      redactDecisionReceipts(input, 'basic');
      redactReviewReport(input, 'basic');
      expect(input.receipts[0]).toEqual({ decidedBy: 'alice', rationale: 'original' });
      expect((input.findings[0] as Record<string, unknown>).message).toBe('also secret');
    });
  });

  // ─── BAD ─────────────────────────────────────────────────────────────────

  describe('BAD', () => {
    it('handles missing receipts array without throwing', () => {
      expect(() => redactDecisionReceipts({}, 'basic')).not.toThrow();
    });

    it('handles empty receipts array without throwing', () => {
      expect(() => redactDecisionReceipts({ receipts: [] }, 'basic')).not.toThrow();
      expect(() => redactDecisionReceipts({ receipts: [] }, 'strict')).not.toThrow();
    });

    it('handles null findings in review report without throwing', () => {
      expect(() => redactReviewReport({}, 'basic')).not.toThrow();
      expect(() => redactReviewReport({ findings: null as unknown }, 'strict')).not.toThrow();
    });

    it('handles null completeness without throwing', () => {
      expect(() => redactReviewReport({ completeness: null as unknown }, 'basic')).not.toThrow();
    });

    it('handles non-array receipts gracefully', () => {
      const input = { receipts: 'not-an-array' } as unknown as Record<string, unknown>;
      expect(() => redactDecisionReceipts(input, 'basic')).not.toThrow();
    });

    it('handles non-string decidedBy/rationale gracefully', () => {
      const input = { receipts: [{ decidedBy: 42, rationale: true }] };
      expect(() => redactDecisionReceipts(input, 'basic')).not.toThrow();
    });

    it('mode=none returns input reference without deep clone overhead', () => {
      const input = { receipts: [{ decidedBy: 'alice' }] };
      const result = redactDecisionReceipts(input, 'none');
      expect(result).toBe(input);
    });

    it('mode=none on review report returns input reference', () => {
      const input = { findings: [{ message: 'ok' }] };
      const result = redactReviewReport(input, 'none');
      expect(result).toBe(input);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    it('handles null/undefined decidedBy without throwing (left unchanged)', () => {
      const input = { receipts: [{ decidedBy: null, rationale: undefined }] };
      expect(() => redactDecisionReceipts(input, 'basic')).not.toThrow();
      const out = redactDecisionReceipts(input, 'basic') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decidedBy).toBe(null);
      expect(r.rationale).toBeUndefined();
    });

    it('handles non-string decidedBy/rationale without throwing (left unchanged)', () => {
      const input = { receipts: [{ decidedBy: 42, rationale: true }] };
      expect(() => redactDecisionReceipts(input, 'basic')).not.toThrow();
    });

    it('handles empty string values', () => {
      const input = { receipts: [{ decidedBy: '', rationale: '' }] };
      const out = redactDecisionReceipts(input, 'strict') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      expect(String(r.decidedBy)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('handles deeply nested completeness without throwing', () => {
      const input = {
        completeness: {
          fourEyes: {
            initiatedBy: 'alice',
            decidedBy: 'bob',
            detail: 'approved',
            extra: { nested: 'value' },
          },
        },
      };
      expect(() => redactReviewReport(input, 'basic')).not.toThrow();
    });

    it('strict mode handles empty string deterministically', () => {
      const out1 = redactDecisionReceipts({ receipts: [{ decidedBy: '' }] }, 'strict');
      const out2 = redactDecisionReceipts({ receipts: [{ decidedBy: '' }] }, 'strict');
      expect(out1).toEqual(out2);
    });

    it('non-string decidedBy/rationale are left unchanged (type guard)', () => {
      const input = { receipts: [{ decidedBy: 123 as unknown, rationale: false as unknown }] };
      const out = redactDecisionReceipts(input, 'basic') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decidedBy).toBe(123);
      expect(r.rationale).toBe(false);
    });

    it('review report leaves non-string finding message unchanged', () => {
      const input = { findings: [{ message: 42 as unknown }] };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect((out.findings[0] as Record<string, unknown>).message).toBe(42);
    });

    it('review report leaves non-string slot detail unchanged', () => {
      const input = { completeness: { slots: [{ detail: true as unknown }] } };
      const out = redactReviewReport(input, 'strict') as Record<string, unknown>;
      const slot = (
        (out.completeness as Record<string, unknown>).slots as Array<Record<string, unknown>>
      )[0]!;
      expect(slot.detail).toBe(true);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────

  describe('EDGE', () => {
    it('strict mode token is consistent across multiple calls with same input', () => {
      const input = { receipts: [{ decidedBy: 'alice', rationale: 'trust decision' }] };
      const results = Array.from({ length: 5 }, () => redactDecisionReceipts(input, 'strict'));
      const tokens = results.map((r) =>
        String((r.receipts[0] as Record<string, unknown>).decidedBy),
      );
      expect(new Set(tokens).size).toBe(1);
    });

    it('strict mode produces different tokens for different field values', () => {
      const out = redactDecisionReceipts(
        { receipts: [{ decidedBy: 'alice', rationale: 'bob' }] },
        'strict',
      );
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decidedBy).not.toBe(r.rationale);
    });

    it('handles review report with mixed null and string fourEyes fields', () => {
      const input = {
        completeness: {
          fourEyes: { initiatedBy: null, decidedBy: null, detail: null },
        },
      };
      expect(() => redactReviewReport(input, 'basic')).not.toThrow();
    });

    it('redacts review report with empty findings array', () => {
      const input = { findings: [], completeness: {} };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect(out.findings).toEqual([]);
    });

    it('strict mode review report findings message', () => {
      const input = { findings: [{ message: 'sensitive review detail' }] };
      const out = redactReviewReport(input, 'strict') as Record<string, unknown>;
      expect(String((out.findings[0] as Record<string, unknown>).message)).toMatch(
        /^\[REDACTED:[a-f0-9]{12}\]$/,
      );
    });

    it('large payload with many receipts redacts all correctly', () => {
      const receipts = Array.from({ length: 100 }, (_, i) => ({
        decisionId: `DEC-${i}`,
        decidedBy: `user-${i}`,
        rationale: `decision rationale ${i}`,
      }));
      const out = redactDecisionReceipts({ receipts }, 'basic') as Record<string, unknown>;
      const redacted = out.receipts as Array<Record<string, unknown>>;
      expect(redacted).toHaveLength(100);
      redacted.forEach((r) => {
        expect(r.decidedBy).toBe('[REDACTED]');
        expect(r.rationale).toBe('[REDACTED]');
      });
    });

    it('sensitive patterns (emails, IPs, API keys) in rationale are redacted', () => {
      const input = {
        receipts: [
          {
            decidedBy: 'alice@example.com',
            rationale:
              'Approved for prod. API key: sk-abc123xyz. IP 192.168.1.42. User: /home/alice',
          },
        ],
      };
      const out = redactDecisionReceipts(input, 'basic') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decidedBy).toBe('[REDACTED]');
      expect(r.rationale).toBe('[REDACTED]');
      expect(String(r.decidedBy)).not.toContain('alice');
      expect(String(r.rationale)).not.toContain('sk-abc123xyz');
    });

    it('strict mode: no raw value leaks through in any field', () => {
      const raw = {
        receipts: [
          {
            decidedBy: 'bob@secret.io',
            rationale: 'Token: ghp_VERYLONGSECRET1234567890abcdef',
          },
        ],
      };
      const out = redactDecisionReceipts(raw, 'strict') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      const decidedByStr = String(r.decidedBy);
      const rationaleStr = String(r.rationale);
      expect(decidedByStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(rationaleStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(decidedByStr).not.toContain('bob');
      expect(rationaleStr).not.toContain('ghp_');
    });

    it('decisionId and other non-sensitive fields are preserved', () => {
      const input = {
        receipts: [
          {
            decisionId: 'DEC-999',
            decidedBy: 'alice',
            rationale: 'ok',
            nonSensitiveField: 'kept as-is',
            timestamp: '2026-04-17',
          },
        ],
      };
      const out = redactDecisionReceipts(input, 'basic') as Record<string, unknown>;
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decisionId).toBe('DEC-999');
      expect(r.nonSensitiveField).toBe('kept as-is');
      expect(r.timestamp).toBe('2026-04-17');
    });

    it('deep copy safety: original nested objects are never mutated', () => {
      const input = {
        receipts: [{ decidedBy: 'alice', rationale: 'original' }],
        completeness: { fourEyes: { initiatedBy: 'bob', detail: 'lgtm' } },
      };
      const snapshot = JSON.stringify(input);
      redactDecisionReceipts(input, 'basic');
      redactReviewReport(input, 'basic');
      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────────────────

  describe('PERF', () => {
    it(`basic redaction on 1000 receipts < ${PERF_BUDGETS.redactionBasic1000Ms}ms (p95)`, () => {
      const receipts = Array.from({ length: 1000 }, (_, i) => ({
        decisionId: `DEC-${i}`,
        decidedBy: `user-${i}`,
        rationale: `decision rationale for item ${i}`,
      }));
      const { p95Ms } = benchmarkSync(() => redactDecisionReceipts({ receipts }, 'basic'), 40, 8);
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.redactionBasic1000Ms);
    });

    it(`strict redaction on 100 receipts < ${PERF_BUDGETS.redactionStrict100Ms}ms (p95)`, () => {
      const receipts = Array.from({ length: 100 }, (_, i) => ({
        decidedBy: `user-${i}`,
        rationale: `rationale text ${i}`,
      }));
      const { p95Ms } = benchmarkSync(() => redactDecisionReceipts({ receipts }, 'strict'), 50, 10);
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.redactionStrict100Ms);
    });

    it('review report redaction on large payload < 50ms', () => {
      const findings = Array.from({ length: 200 }, (_, i) => ({
        checkId: `check-${i}`,
        message: `finding message ${i} with detail`,
        passed: true,
      }));
      const input = {
        findings,
        validationSummary: findings.slice(0, 50),
        completeness: {
          fourEyes: { initiatedBy: 'alice', decidedBy: 'bob', detail: 'all good' },
          slots: findings.slice(0, 100).map((f) => ({ slot: f.checkId, detail: f.message })),
        },
      };
      const start = performance.now();
      redactReviewReport(input, 'basic');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it('mode=none is near-instant (no deep clone)', () => {
      const receipts = Array.from({ length: 1000 }, (_, i) => ({
        decidedBy: `user-${i}`,
        rationale: `text ${i}`,
      }));
      const start = performance.now();
      redactDecisionReceipts({ receipts }, 'none');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5);
    });
  });
});
