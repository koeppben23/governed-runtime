import { describe, expect, it } from "vitest";
import { redactDecisionReceipts, redactReviewReport } from "./export-redaction";

describe("redaction/export-redaction", () => {
  describe("HAPPY", () => {
    it("redacts reviewer identity and rationale in decision receipts", () => {
      const input = {
        schemaVersion: "decision-receipts.v1",
        receipts: [
          {
            decisionId: "DEC-001",
            decidedBy: "alice",
            rationale: "Contains private context",
          },
        ],
      };

      const output = redactDecisionReceipts(input, "basic");
      const receipt = (output.receipts as Array<Record<string, unknown>>)[0]!;
      expect(receipt.decidedBy).toBe("[REDACTED]");
      expect(receipt.rationale).toBe("[REDACTED]");
    });
  });

  describe("BAD", () => {
    it("handles missing arrays without throwing", () => {
      expect(() => redactDecisionReceipts({}, "basic")).not.toThrow();
      expect(() => redactReviewReport({}, "basic")).not.toThrow();
    });
  });

  describe("CORNER", () => {
    it("leaves payload unchanged when mode is none", () => {
      const input = {
        findings: [{ message: "plain" }],
        completeness: { fourEyes: { initiatedBy: "bob", decidedBy: null } },
      };
      const output = redactReviewReport(input, "none");
      expect(output).toEqual(input);
    });
  });

  describe("EDGE", () => {
    it("uses deterministic tokenized masks in strict mode", () => {
      const input = {
        receipts: [{ decidedBy: "alice", rationale: "same" }],
      };
      const outputA = redactDecisionReceipts(input, "strict");
      const outputB = redactDecisionReceipts(input, "strict");
      const a = (outputA.receipts as Array<Record<string, unknown>>)[0]!;
      const b = (outputB.receipts as Array<Record<string, unknown>>)[0]!;
      expect(a.decidedBy).toBe(b.decidedBy);
      expect(String(a.decidedBy)).toContain("[REDACTED:");
    });
  });
});
