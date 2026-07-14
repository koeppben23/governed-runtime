import { describe, expect, it } from 'vitest';
import {
  redactDecisionReceipts,
  redactReviewReport,
  redactSessionState,
  redactAuditDetail,
} from './export-redaction.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

type ReceiptOutput = { receipts: Array<Record<string, unknown>> };
type ReportOutput = { findings: Array<Record<string, unknown>> };

function recordArray(output: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = output[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'object' && item !== null)) {
    throw new TypeError(`expected ${key} record array`);
  }
  return value as Array<Record<string, unknown>>;
}

function redactedReceipts(input: Record<string, unknown>, mode: 'basic' | 'strict'): ReceiptOutput {
  return { receipts: recordArray(redactDecisionReceipts(input, mode), 'receipts') };
}

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
      const output = redactedReceipts(input, 'basic');
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
      const output = redactedReceipts(input, 'basic');
      expect((output.receipts[0] as Record<string, unknown>).decidedBy).toBe(
        (output.receipts[1] as Record<string, unknown>).decidedBy,
      );
      expect((output.receipts[0] as Record<string, unknown>).decidedBy).toBe('[REDACTED]');
    });

    it('redacts strict mode with deterministic tokenized masks', () => {
      const input = { receipts: [{ decidedBy: 'alice', rationale: 'same' }] };
      const outA = redactedReceipts(input, 'strict');
      const outB = redactedReceipts(input, 'strict');
      const a = outA.receipts[0] as Record<string, unknown>;
      const b = outB.receipts[0] as Record<string, unknown>;
      expect(a.decidedBy).toBe(b.decidedBy);
      expect(String(a.decidedBy)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strict mode produces different tokens for different inputs', () => {
      const out1 = redactedReceipts({ receipts: [{ decidedBy: 'alice' }] }, 'strict');
      const out2 = redactedReceipts({ receipts: [{ decidedBy: 'bob' }] }, 'strict');
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
      expect(recordArray(output, 'findings')[0]?.message).toBe('[REDACTED]');
    });

    it('redacts findings message in review report basic mode', () => {
      const input = { findings: [{ message: 'Contains PII: alice@example.com' }] };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect(recordArray(output, 'findings')[0]?.message).toBe('[REDACTED]');
    });

    it('redacts validationSummary detail in review report', () => {
      const input = { validationSummary: [{ checkId: 'test_quality', detail: 'secret detail' }] };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect(recordArray(output, 'validationSummary')[0]?.detail).toBe('[REDACTED]');
    });

    it('redacts references in review report basic mode', () => {
      const input = {
        references: [
          {
            ref: 'https://jira.internal.example.com/browse/SEC-123',
            type: 'ticket',
            source: 'jira',
            title: 'SEC-123: Fix credential leak',
          },
          {
            ref: 'https://github.com/private-org/secret-repo/pull/42',
            type: 'pr',
            source: 'github',
            title: 'PR #42: Update auth keys',
          },
        ],
      };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const refs = output.references as Array<Record<string, unknown>>;
      expect(refs[0]!.ref).toBe('[REDACTED]');
      expect(refs[0]!.title).toBe('[REDACTED]');
      expect(refs[0]!.type).toBe('ticket');
      expect(refs[0]!.source).toBe('jira');
      expect(refs[1]!.ref).toBe('[REDACTED]');
      expect(refs[1]!.title).toBe('[REDACTED]');
    });

    it('redacts references in review report strict mode', () => {
      const input = {
        references: [
          { ref: 'https://jira.internal.example.com/PROJ-1', title: 'PROJ-1: Internal thing' },
        ],
      };
      const output = redactReviewReport(input, 'strict') as Record<string, unknown>;
      const refs = output.references as Array<Record<string, unknown>>;
      expect(String(refs[0]!.ref)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(String(refs[0]!.title)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('preserves reference type, source, and extractedAt during redaction', () => {
      const input = {
        references: [
          {
            ref: 'https://ado.internal.example.com/WI-5',
            type: 'ticket',
            source: 'ados',
            title: 'WI-5',
            extractedAt: '2026-01-15T10:00:00.000Z',
          },
        ],
      };
      const output = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const refs = output.references as Array<Record<string, unknown>>;
      expect(refs[0]!.ref).toBe('[REDACTED]');
      expect(refs[0]!.title).toBe('[REDACTED]');
      expect(refs[0]!.type).toBe('ticket');
      expect(refs[0]!.source).toBe('ados');
      expect(refs[0]!.extractedAt).toBe('[REDACTED]');
    });

    it('mode=none leaves references unchanged', () => {
      const input = {
        references: [{ ref: 'https://example.com/ticket/1', title: 'Ticket #1' }],
      };
      expect(redactReviewReport(input, 'none')).toEqual(input);
    });

    it('handles empty references array without throwing', () => {
      expect(() => redactReviewReport({ references: [] }, 'basic')).not.toThrow();
      expect(() => redactReviewReport({ references: [] }, 'strict')).not.toThrow();
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
      const out = redactedReceipts(input, 'basic');
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
      const out = redactedReceipts(input, 'strict');
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
      const out = redactedReceipts(input, 'basic');
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decidedBy).toBe(123);
      expect(r.rationale).toBe(false);
    });

    it('review report leaves non-string finding message unchanged', () => {
      const input = { findings: [{ message: 42 as unknown }] };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      expect(recordArray(out, 'findings')[0]?.message).toBe(42);
    });

    it('review report leaves non-string slot detail unchanged', () => {
      const input = { completeness: { slots: [{ detail: true as unknown }] } };
      const out = redactReviewReport(input, 'strict') as Record<string, unknown>;
      const slot = (
        (out.completeness as Record<string, unknown>).slots as Array<Record<string, unknown>>
      )[0]!;
      expect(slot.detail).toBe(true);
    });

    it('reference with null/undefined ref and title leaves them unchanged', () => {
      const input = {
        references: [{ ref: null as unknown, title: undefined as unknown, type: 'url' }],
      };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const refs = out.references as Array<Record<string, unknown>>;
      expect(refs[0]!.ref).toBe(null);
      expect(refs[0]!.title).toBeUndefined();
      expect(refs[0]!.type).toBe('url');
    });

    it('reference with non-string ref/title leaves them unchanged', () => {
      const input = {
        references: [{ ref: 42 as unknown, title: true as unknown }],
      };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const refs = out.references as Array<Record<string, unknown>>;
      expect(refs[0]!.ref).toBe(42);
      expect(refs[0]!.title).toBe(true);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────

  describe('EDGE', () => {
    it('strict mode token is consistent across multiple calls with same input', () => {
      const input = { receipts: [{ decidedBy: 'alice', rationale: 'trust decision' }] };
      const results = Array.from({ length: 5 }, () => redactedReceipts(input, 'strict'));
      const tokens = results.map((r) =>
        String((r.receipts[0] as Record<string, unknown>).decidedBy),
      );
      expect(new Set(tokens).size).toBe(1);
    });

    it('strict mode produces different tokens for different field values', () => {
      const out = redactedReceipts(
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
      expect(String(recordArray(out, 'findings')[0]?.message)).toMatch(
        /^\[REDACTED:[a-f0-9]{12}\]$/,
      );
    });

    it('large payload with many receipts redacts all correctly', () => {
      const receipts = Array.from({ length: 100 }, (_, i) => ({
        decisionId: `DEC-${i}`,
        decidedBy: `user-${i}`,
        rationale: `decision rationale ${i}`,
      }));
      const out = redactedReceipts({ receipts }, 'basic');
      const redacted = out.receipts;
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
      const out = redactedReceipts(input, 'basic');
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
      const out = redactedReceipts(raw, 'strict');
      const r = out.receipts[0] as Record<string, unknown>;
      const decidedByStr = String(r.decidedBy);
      const rationaleStr = String(r.rationale);
      expect(decidedByStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(rationaleStr).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(decidedByStr).not.toContain('bob');
      expect(rationaleStr).not.toContain('ghp_');
    });

    it('unknown string fields are redacted by default (default-deny)', () => {
      const input = {
        receipts: [
          {
            decisionId: 'DEC-999',
            decidedBy: 'alice',
            rationale: 'ok',
            injectedSecret: 'leaked-value',
            timestamp: '2026-04-17',
          },
        ],
      };
      const out = redactedReceipts(input, 'basic');
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decisionId).toBe('DEC-999');
      expect(r.timestamp).toBe('2026-04-17');
      expect(r.decidedBy).toBe('[REDACTED]');
      expect(r.rationale).toBe('[REDACTED]');
      expect(r.injectedSecret).toBe('[REDACTED]');
    });

    it('unknown nested string fields are deep-walked and redacted', () => {
      const input = {
        findings: [
          {
            checkId: 'c1',
            message: 'contains secret',
            extra: { nestedSecret: 'should-be-redacted' },
          },
        ],
      };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const finding = (out.findings as Array<Record<string, unknown>>)[0]!;
      expect(finding.checkId).toBe('c1');
      expect(finding.message).toBe('[REDACTED]');
      const extra = finding.extra as Record<string, unknown>;
      expect(extra.nestedSecret).toBe('[REDACTED]');
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

  // ─── SECURITY PATTERNS ──────────────────────────────────────────────────

  describe('SECURITY PATTERNS', () => {
    it('redacts explicit token formats in basic and strict modes', () => {
      const input = {
        receipts: [
          {
            decidedBy: 'ci-bot',
            rationale:
              'Used ghp_abcdefghijklmnopqrstuvwxyz123456 for auth ' +
              'and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in step 2 ' +
              'and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in step 2 ' +
              'and xoxb-123456789012-123456789012-abcdefghijklmnopqrstuv for slack',
          },
        ],
      };
      const outBasic = redactDecisionReceipts(input, 'basic') as ReceiptOutput;
      const rBasic = outBasic.receipts[0]!;
      expect(rBasic.decidedBy).toBe('[REDACTED]');
      expect(rBasic.rationale).toBe('[REDACTED]');

      const outStrict = redactDecisionReceipts(input, 'strict') as ReceiptOutput;
      const rStrict = outStrict.receipts[0]!;
      expect(String(rStrict.decidedBy)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(String(rStrict.rationale)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('JWK-like key material in review finding message is redacted', () => {
      const input = {
        findings: [
          {
            checkId: 'secret_detection',
            message:
              'JWK: {"kty":"RSA","n":"AAAAvT8u...","e":"AQAB","d":"c2VjcmV0LWtleS1tYXRlcmlhbA==","p":"...","q":"..."}',
          },
        ],
      };
      const out = redactReviewReport(input, 'strict') as ReportOutput;
      const finding = out.findings[0]!;
      expect(String(finding.message)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(String(finding.message)).not.toContain('RSA');
    });

    it('file paths in rationale are fully redacted', () => {
      const input = {
        receipts: [
          {
            decidedBy: 'alice',
            rationale:
              'Approved based on review of /home/user/.ssh/id_rsa and /etc/ssl/private/key.pem',
          },
        ],
      };
      const out = redactDecisionReceipts(input, 'basic') as ReceiptOutput;
      const r = out.receipts[0]!;
      expect(r.rationale).toBe('[REDACTED]');
      expect(String(r.rationale)).not.toContain('id_rsa');
      expect(String(r.rationale)).not.toContain('/home/user');
    });

    it('same value across artifacts produces same strict token', () => {
      const sharedValue = 'alice@corp.com';
      const receiptInput = { receipts: [{ decidedBy: 'bot', rationale: sharedValue }] };
      const reportInput = { findings: [{ checkId: 'c1', message: sharedValue }] };

      const receiptOut = redactDecisionReceipts(receiptInput, 'strict') as ReceiptOutput;
      const reportOut = redactReviewReport(reportInput, 'strict') as ReportOutput;

      const receiptToken = String(receiptOut.receipts[0]!.rationale);
      const reportToken = String(reportOut.findings[0]!.message);

      expect(receiptToken).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(receiptToken).toBe(reportToken);
    });

    it('mixed sensitive patterns in one field: email, token, URL, path', () => {
      const input = {
        receipts: [
          {
            decidedBy: 'alice@corp.com',
            rationale:
              'alice@corp.com approved via token ghp_abcdefghijklmnopqrstuvwxyz123456 ' +
              'from https://auth.internal.example.com at /home/alice/config',
          },
        ],
      };

      const outBasic = redactDecisionReceipts(input, 'basic') as ReceiptOutput;
      const rBasic = outBasic.receipts[0]!;
      expect(rBasic.decidedBy).toBe('[REDACTED]');
      expect(rBasic.rationale).toBe('[REDACTED]');

      const outStrict = redactDecisionReceipts(input, 'strict') as ReceiptOutput;
      const rStrict = outStrict.receipts[0]!;
      expect(String(rStrict.decidedBy)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(String(rStrict.rationale)).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);

      const outStrictB = redactDecisionReceipts(input, 'strict') as ReceiptOutput;
      const rStrictB = outStrictB.receipts[0]!;
      expect(rStrictB.rationale).toBe(rStrict.rationale);
    });

    it('documents current non-object payload behavior', () => {
      // mode=none: returns input as-is (reference equality)
      expect(redactDecisionReceipts(null as unknown as Record<string, unknown>, 'none')).toBe(null);
      expect(redactReviewReport(null as unknown as Record<string, unknown>, 'none')).toBe(null);

      // mode !== none on null → returns null (no fields to redact)
      expect(redactDecisionReceipts(null as unknown as Record<string, unknown>, 'basic')).toBe(
        null,
      );
      expect(redactReviewReport(null as unknown as Record<string, unknown>, 'basic')).toBe(null);

      // string primitive: structuredClone returns the string, deep walk
      // treats it as a value to redact (default-deny for unknown strings).
      expect(redactDecisionReceipts('string' as unknown as Record<string, unknown>, 'basic')).toBe(
        '[REDACTED]',
      );
      expect(redactReviewReport('string' as unknown as Record<string, unknown>, 'basic')).toBe(
        '[REDACTED]',
      );

      // array: structuredClone([]) = []; .receipts/.findings → undefined; returns []
      expect(redactDecisionReceipts([] as unknown as Record<string, unknown>, 'basic')).toEqual([]);
      expect(redactReviewReport([] as unknown as Record<string, unknown>, 'basic')).toEqual([]);
    });
  });

  // ─── DEFAULT-DENY DEEP WALK ──────────────────────────────────────────

  describe('DEFAULT-DENY DEEP WALK', () => {
    it('supports ordinary objects inside arrays', () => {
      const input = { receipts: [{ decisionId: 'DEC-001' }] };
      const out = redactedReceipts(input, 'basic');
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.decisionId).toBe('DEC-001');
    });

    it('supports repeated references that are not circular', () => {
      const shared = { decisionId: 'DEC-001' };
      const value = { left: shared, right: shared };
      expect(() => redactReviewReport(value, 'basic')).not.toThrow();
    });

    it('throws on circular reference', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => redactReviewReport(cyclic, 'basic')).toThrow(/circular/i);
    });

    it('does not throw on circular reference with mode none', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => redactReviewReport(cyclic, 'none')).not.toThrow();
    });

    it('string array elements are always redacted', () => {
      const input = { source: ['safe-enum', 'Bearer ghp_secret', { injectedSecret: 'leaked' }] };
      const out = redactReviewReport(input, 'basic') as Record<string, unknown>;
      const arr = out.source as unknown[];
      expect(arr[0]).toBe('[REDACTED]');
      expect(arr[1]).toBe('[REDACTED]');
      expect((arr[2] as Record<string, unknown>).injectedSecret).toBe('[REDACTED]');
    });

    it('throws on excessive nesting depth', () => {
      let value: unknown = 'leaf';
      for (let i = 0; i < 65; i++) {
        value = { child: value };
      }
      expect(() => redactReviewReport(value as Record<string, unknown>, 'basic')).toThrow(/depth/);
    });

    it('allows 63 nested levels (64 nodes)', () => {
      let value: unknown = 'leaf';
      for (let i = 0; i < 63; i++) {
        value = { child: value };
      }
      expect(() => redactReviewReport(value as Record<string, unknown>, 'basic')).not.toThrow();
    });
  });

  // ─── STRUCTURAL REDACTION ──────────────────────────────────────────────

  describe('STRUCTURAL REDACTION', () => {
    it('sensitive keys are masked exactly once in strict mode', () => {
      const result = redactReviewReport({ findings: [{ message: 'secret finding' }] }, 'strict');
      const message = (result.findings as Array<Record<string, unknown>>)[0]?.message;
      expect(message).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('sensitive keys in decision receipts are masked once', () => {
      const result = redactDecisionReceipts(
        { receipts: [{ decidedBy: 'alice', rationale: 'secret rationale' }] },
        'strict',
      );
      const r = (result.receipts as Array<Record<string, unknown>>)[0]!;
      expect(r.decidedBy).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(r.rationale).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(String(r.decidedBy)).not.toContain('alice');
    });

    it('sentinel-shaped value on unknown field is redacted', () => {
      const result = redactReviewReport({ injectedSecret: '[REDACTED:deadbeefcafe]' }, 'strict');
      expect(result.injectedSecret).not.toBe('[REDACTED:deadbeefcafe]');
      expect(result.injectedSecret).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('sentinel-shaped value on unknown field in receipts is redacted', () => {
      const out = redactedReceipts(
        {
          receipts: [
            {
              decisionId: 'x',
              decidedBy: 'alice',
              rationale: 'ok',
              injectedSecret: '[REDACTED:deadbeefcafe]',
            },
          ],
        },
        'basic',
      );
      const r = out.receipts[0] as Record<string, unknown>;
      expect(r.injectedSecret).toBe('[REDACTED]');
    });

    it('sentinel-shaped value on unknown audit detail field is redacted', () => {
      const result = redactAuditDetail(
        { kind: 'tool_call', injected: '[REDACTED:deadbeefcafe]' },
        'basic',
      );
      expect(result.injected).toBe('[REDACTED]');
    });
  });

  // ─── SESSION-STATE REDACTION ──────────────────────────────────────────

  describe('SESSION-STATE REDACTION', () => {
    it('redacts identity fields in session state', () => {
      const result = redactSessionState(
        {
          id: 'session-1',
          phase: 'PLAN',
          initiatedBy: 'alice',
          schemaVersion: 'v1',
          actorInfo: { id: 'actor-1', email: 'alice@example.test' },
        },
        'basic',
      );
      expect(result.phase).toBe('PLAN');
      expect(result.schemaVersion).toBe('v1');
      expect(result.initiatedBy).toBe('[REDACTED]');
      const ai = result.actorInfo as Record<string, unknown>;
      expect(ai.id).toBe('[REDACTED]');
      expect(ai.email).toBe('[REDACTED]');
    });

    it('strict identity masking remains stable through the deep walk', () => {
      const result = redactSessionState(
        {
          initiatedBy: 'alice',
          actorInfo: { id: 'actor-1', email: 'alice@example.test' },
        },
        'strict',
      );
      expect(result.initiatedBy).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      const ai = result.actorInfo as Record<string, unknown>;
      expect(ai.id).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('redacts path-bearing fields in session state', () => {
      const result = redactSessionState(
        {
          worktree: '/home/alice/project',
          reviewReportPath: '/tmp/reviews/report.json',
          sessionDir: '/home/alice/.config/sessions/abc',
        },
        'basic',
      );
      expect(result.worktree).toBe('[REDACTED]');
      expect(result.reviewReportPath).toBe('[REDACTED]');
      expect(result.sessionDir).toBe('[REDACTED]');
    });

    it('preserves structured enum fields in session state', () => {
      const result = redactSessionState(
        {
          phase: 'COMPLETE',
          status: 'clear',
          mode: 'regulated',
          kind: 'lifecycle',
          action: 'session_completed',
          event: 'APPROVE',
          verdict: 'approve',
        },
        'basic',
      );
      expect(result.phase).toBe('COMPLETE');
      expect(result.status).toBe('clear');
      expect(result.mode).toBe('regulated');
      expect(result.kind).toBe('lifecycle');
      expect(result.action).toBe('session_completed');
      expect(result.event).toBe('APPROVE');
      expect(result.verdict).toBe('approve');
    });

    it('mode=none returns session state unchanged', () => {
      const input = { initiatedBy: 'alice', worktree: '/home/alice' };
      const result = redactSessionState(input, 'none');
      expect(result).toBe(input);
    });

    it('unknown string fields in session state are default-denied', () => {
      const result = redactSessionState(
        { injectedSecret: 'should-not-leak', phase: 'PLAN' },
        'basic',
      );
      expect(result.phase).toBe('PLAN');
      expect(result.injectedSecret).toBe('[REDACTED]');
    });
  });

  // ─── AUDIT-DETAIL REDACTION ────────────────────────────────────────────

  describe('AUDIT-DETAIL REDACTION', () => {
    it('preserves structural audit detail fields', () => {
      const result = redactAuditDetail(
        {
          kind: 'tool_call',
          tool: 'bash',
          success: true,
          errorPhase: 'IMPLEMENTATION',
          event: 'APPROVE',
          verdict: 'approve',
        },
        'basic',
      );
      expect(result.kind).toBe('tool_call');
      expect(result.tool).toBe('bash');
      expect(result.event).toBe('APPROVE');
      expect(result.verdict).toBe('approve');
    });

    it('redacts unknown string fields in audit detail', () => {
      const result = redactAuditDetail(
        { kind: 'tool_call', injectedSecret: 'leaked', diagnostic: '/home/user/secret' },
        'basic',
      );
      expect(result.kind).toBe('tool_call');
      expect(result.injectedSecret).toBe('[REDACTED]');
      expect(result.diagnostic).toBe('[REDACTED]');
    });

    it('sanitizes and preserves errorMessage', () => {
      const result = redactAuditDetail(
        { kind: 'error', errorMessage: '/home/user/.ssh/id_rsa: EACCES' },
        'strict',
      );
      expect(result.errorMessage).toContain('[path:id_rsa]');
      expect(result.errorMessage).not.toContain('/home/user');
      expect(result.errorMessage).not.toMatch(/^\[REDACTED/);
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
