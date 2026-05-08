/**
 * @module templates/mandates-schema-drift.test
 * @description Build-time guard: REVIEWER_AGENT template schema MUST require the
 * same attestation fields as the runtime ReviewAttestation Zod schema.
 *
 * Prevents B1-class regressions: a template that omits attestation fields
 * causes guaranteed SUBAGENT_MANDATE_MISSING failures on the strict path.
 */

import { describe, expect, it } from 'vitest';

import { REVIEWER_AGENT, OPENCODE_JSON_TEMPLATE } from './mandates.js';

const REQUIRED_ATTESTATION_FIELDS = [
  'mandateDigest',
  'criteriaVersion',
  'toolObligationId',
  'iteration',
  'planVersion',
  'reviewedBy',
] as const;

describe('REVIEWER_AGENT template: schema integrity (B1)', () => {
  it('contains an attestation block in the output schema', () => {
    expect(REVIEWER_AGENT).toContain('"attestation"');
  });

  for (const field of REQUIRED_ATTESTATION_FIELDS) {
    it(`attestation block instructs the reviewer to set ${field}`, () => {
      // The template schema must mention every attestation field that
      // ReviewAttestation (state/evidence.ts) declares as required.
      expect(REVIEWER_AGENT).toMatch(new RegExp(`"${field}"`));
    });
  }

  it('binds attestation.reviewedBy to the literal "flowguard-reviewer"', () => {
    expect(REVIEWER_AGENT).toMatch(/"reviewedBy":\s*"flowguard-reviewer"/);
  });

  it('does not instruct the subagent to use the literal "subagent" as sessionId (B3)', () => {
    expect(REVIEWER_AGENT).not.toMatch(/otherwise\s+'subagent'/);
  });

  it('output-schema overallVerdict enum lists all three LoopVerdict values (P1.3 slice 3)', () => {
    // Drift guard: the JSON shape in REVIEWER_AGENT must list the same
    // three values that LoopVerdict (src/state/evidence.ts:72) and the
    // SDK structured-output JSON-Schema (src/integration/review-orchestrator.ts:47)
    // accept. If a future edit drops one, the reviewer subagent and the
    // runtime would disagree on what verdicts are emittable.
    expect(REVIEWER_AGENT).toMatch(
      /"overallVerdict":\s*"approve"\s*\|\s*"changes_requested"\s*\|\s*"unable_to_review"/,
    );
  });

  it('documents the unable_to_review validity-conditions whitelist (P1.3 slice 3)', () => {
    // The mandate must spell out the validity conditions, not just allow
    // the value. Without these conditions the third verdict becomes an
    // evasion route for substantive findings.
    expect(REVIEWER_AGENT).toMatch(/When You Cannot Review/);
    expect(REVIEWER_AGENT).toMatch(/empty or unparseable/i);
    expect(REVIEWER_AGENT).toMatch(/required context is missing/i);
    expect(REVIEWER_AGENT).toMatch(/structured-output schema/i);
    expect(REVIEWER_AGENT).toMatch(/mandate digest/i);
    expect(REVIEWER_AGENT).toMatch(/NOT an evasion route/);
  });

  it('Rules section forbids using unable_to_review for substantive findings (P1.3 slice 3)', () => {
    // Anti-fabrication rail. The Rules section must explicitly forbid
    // using the third verdict to dodge producing changes_requested.
    expect(REVIEWER_AGENT).toMatch(
      /Do NOT use "unable_to_review" to avoid producing substantive findings/,
    );
  });
});

// ---------------------------------------------------------------------------
// M1: Reviewer Agent must have steps limit (audit fix)
// ---------------------------------------------------------------------------

describe('REVIEWER_AGENT template: steps limit (M1)', () => {
  it('HAPPY — frontmatter contains steps: 10', () => {
    // Without a steps limit, the reviewer can run unbounded tool calls,
    // incurring unbounded cost. steps: 10 caps the review loop.
    expect(REVIEWER_AGENT).toMatch(/^steps:\s*10$/m);
  });

  it('CORNER — steps value is a positive integer', () => {
    const match = REVIEWER_AGENT.match(/^steps:\s*(\d+)$/m);
    expect(match).not.toBeNull();
    const steps = parseInt(match![1], 10);
    expect(steps).toBeGreaterThan(0);
    expect(Number.isInteger(steps)).toBe(true);
  });

  it('BAD — steps is not zero or negative', () => {
    const match = REVIEWER_AGENT.match(/^steps:\s*(\d+)$/m);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(1);
  });

  it('EDGE — steps appears exactly once in frontmatter section', () => {
    // Frontmatter is between the first two '---' delimiters
    const fmMatch = REVIEWER_AGENT.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const frontmatter = fmMatch![1];
    const stepsOccurrences = (frontmatter.match(/^steps:/gm) || []).length;
    expect(stepsOccurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M4: Reviewer prompt StructuredOutput tool compatibility (audit fix)
// ---------------------------------------------------------------------------

describe('REVIEWER_AGENT template: StructuredOutput tool compatibility (M4)', () => {
  it('HAPPY — prompt mentions StructuredOutput tool', () => {
    // When structured output is active, the runtime provides a StructuredOutput
    // tool. The prompt must instruct the reviewer to use it.
    expect(REVIEWER_AGENT).toMatch(/StructuredOutput tool/);
  });

  it('BAD — prompt does NOT say "Return EXACTLY one JSON object"', () => {
    // "Return EXACTLY one JSON object" conflicts with the StructuredOutput tool
    // mechanism: the tool wraps the response, so the LLM should not try to emit
    // raw JSON as text. This would cause the tool to fail or produce double-wrapped output.
    expect(REVIEWER_AGENT).not.toMatch(/Return EXACTLY one JSON object/i);
  });

  it('CORNER — prompt still instructs fallback for non-structured environments', () => {
    // When structured output is unavailable, the reviewer should fall back to
    // emitting a raw JSON object. The prompt must cover both paths.
    expect(REVIEWER_AGENT).toMatch(/structured output is unavailable/i);
  });

  it('EDGE — prompt does not require markdown fences around JSON', () => {
    // Markdown fences (```json) around the output would break JSON parsing.
    // The prompt explicitly says "without markdown fences."
    expect(REVIEWER_AGENT).toMatch(/without markdown\s+fences/);
  });
});

// ---------------------------------------------------------------------------
// C1: OPENCODE_JSON_TEMPLATE must NOT include a plugin array (audit fix)
// ---------------------------------------------------------------------------

describe('OPENCODE_JSON_TEMPLATE: no plugin array (C1)', () => {
  it('HAPPY — template output has no "plugin" key', () => {
    // The plugin field in opencode.json is for npm packages only (per OpenCode docs).
    // FlowGuard uses auto-discovery via .opencode/plugins/ directory.
    // Including "plugin": ["flowguard-audit"] would trigger npm lookup failure.
    const template = OPENCODE_JSON_TEMPLATE('.opencode/flowguard-mandates.md');
    const parsed = JSON.parse(template);
    expect(parsed).not.toHaveProperty('plugin');
  });

  it('HAPPY — template has instructions array', () => {
    const template = OPENCODE_JSON_TEMPLATE('.opencode/flowguard-mandates.md');
    const parsed = JSON.parse(template);
    expect(parsed.instructions).toEqual(['.opencode/flowguard-mandates.md']);
  });

  it('CORNER — template with different instruction paths still has no plugin', () => {
    const paths = ['.opencode/flowguard-mandates.md', 'AGENTS.md', 'custom/path/instructions.md'];
    for (const p of paths) {
      const parsed = JSON.parse(OPENCODE_JSON_TEMPLATE(p));
      expect(parsed).not.toHaveProperty('plugin');
      expect(parsed.instructions).toContain(p);
    }
  });

  it('EDGE — template is valid JSON', () => {
    expect(() => JSON.parse(OPENCODE_JSON_TEMPLATE('test.md'))).not.toThrow();
  });
});
