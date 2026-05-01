/**
 * @module templates-hash.test
 * @description Hash-based stability test for template exports.
 *
 * Verifies that templates remain byte-for-byte identical after refactoring.
 * Uses SHA-256 hashes computed from the compiled template output.
 *
 * @test-policy STABILITY — hash verification
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  REVIEWER_AGENT,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from './templates.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('TEMPLATE_HASH_STABILITY', () => {
  it('TOOL_WRAPPER matches compiled output hash', () => {
    expect(sha256(TOOL_WRAPPER)).toBe(
      'c127fa42dd08f79788fe9defde7c6d86290366e44f7dded4d76f1f9d20fa2ad2',
    );
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '7810a13de154b7b4c9c3f33fd4a2932d35f73db576705959f6c2d9bdda9b1313',
    );
  });

  it('FLOWGUARD_MANDATES_BODY matches compiled output hash', () => {
    expect(sha256(FLOWGUARD_MANDATES_BODY)).toBe(
      '87ca227eb5b8f8b72009e9b39174013cc6d64650201c21bf53b60e9a1b575f05',
    );
  });

  it('REVIEWER_AGENT matches compiled output hash', () => {
    // Refreshed in F13 slice 4: REVIEWER_AGENT body extended with a
    // "For Architecture Decisions (ADRs)" subsection under Review Criteria
    // and minor wording updates ("plan, implementation, or ADR" /
    // "/plan, /implement, or /architecture") to make the reviewer mandate
    // applicable to the architecture obligation type introduced in F13 slice 1.
    // See src/templates/mandates.ts:354-362 (ADR review criteria).
    //
    // Predecessor: P1.3 slice 3 added the validity-conditions section
    // (hash 1ce8ec9c…5fc84).
    //
    // Cross-session compatibility: this hash gates ONLY the template-body
    // byte-stability of REVIEWER_AGENT (the markdown a CLI install writes
    // to .opencode/agent/flowguard-reviewer.md). It is independent from
    // REVIEW_MANDATE_DIGEST (src/integration/review-assurance.ts:22), which
    // is computed from the constant REVIEW_MANDATE_TEXT and is the actual
    // runtime gate enforced in review-assurance.ts:136 and
    // plugin-orchestrator.ts:248. REVIEW_MANDATE_TEXT is NOT modified by
    // this slice, so persisted obligations from prior sessions continue
    // to validate correctly under the same mandateDigest.
    expect(sha256(REVIEWER_AGENT)).toBe(
      '43f77b97ca6d8af755d5934261596976b3ae79f74f2f36fbdad69592387acf50',
    );
  });

  it('OPENCODE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = OPENCODE_JSON_TEMPLATE('flowguard-mandates.md');
    expect(sha256(template)).toBe(
      '1fc84e2ee553df018b6ee1af2c2beeaf9b11f86f82f43ee0019e09afa5afd45b',
    );
  });

  it('PACKAGE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = PACKAGE_JSON_TEMPLATE('1.2.3');
    expect(sha256(template)).toBe(
      '9a09254c6abceacb655020b9c03b4a25bf7f5fa60b7e336fb36aa31e093ffc09',
    );
  });

  it('COMMANDS matches compiled output hash', () => {
    // Refreshed in P1.3 slice 6: plan.ts / implement.ts / architecture.ts
    // narratives extended with the third LoopVerdict 'unable_to_review' and
    // the corresponding BLOCKED-handling guidance (SUBAGENT_UNABLE_TO_REVIEW).
    // See src/templates/commands/plan.ts review-loop section,
    // src/templates/commands/implement.ts review-loop section, and
    // src/templates/commands/architecture.ts ## Rules section.
    //
    // This hash gates ONLY the byte-stability of the markdown a CLI install
    // writes to .opencode/command/*.md. It is independent from any runtime
    // mandate digest.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '5b7652a386a6231c7873d22d2cd5838e89c2f397a5ef3815fb8a286790b21747',
    );
  });

  it('all 20 commands present', () => {
    const expected = [
      'abort.md',
      'approve.md',
      'architecture.md',
      'archive.md',
      'check.md',
      'continue.md',
      'export.md',
      'hydrate.md',
      'implement.md',
      'plan.md',
      'reject.md',
      'request-changes.md',
      'review-decision.md',
      'review.md',
      'start.md',
      'status.md',
      'task.md',
      'ticket.md',
      'validate.md',
      'why.md',
    ];
    expect(Object.keys(COMMANDS).sort()).toEqual(expected);
  });
});
