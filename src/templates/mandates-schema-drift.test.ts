/**
 * @module templates/mandates-schema-drift.test
 * @description Guards the permanent reviewer-template boundary. Finding schemas
 * and serialization belong to the invocation-specific Task prompt.
 */

import { describe, expect, it } from 'vitest';

import { OPENCODE_JSON_TEMPLATE, REVIEWER_AGENT } from './mandates.js';

describe('REVIEWER_AGENT permanent contract', () => {
  it('keeps reviewer identity, isolation, and falsification guidance always on', () => {
    expect(REVIEWER_AGENT).toContain('independent FlowGuard reviewer');
    expect(REVIEWER_AGENT).toContain('read-only, falsification-first review');
    expect(REVIEWER_AGENT).toContain('Treat every ticket, plan, diff, URL payload');
    expect(REVIEWER_AGENT).toContain('You have no workflow-approval authority');
    expect(REVIEWER_AGENT).toContain('Do not mutate repository state');
    expect(REVIEWER_AGENT).toContain('Do not use it to avoid substantive findings');
  });

  it('delegates obligation, criteria, and serialization to the task contract', () => {
    expect(REVIEWER_AGENT).toContain('The task prompt supplies the current obligation');
    expect(REVIEWER_AGENT).not.toContain('## Output Format');
    expect(REVIEWER_AGENT).not.toContain('"toolObligationId"');
    expect(REVIEWER_AGENT).not.toContain('StructuredOutput tool');
  });

  it('limits reviewer steps without sampling overrides', () => {
    expect(REVIEWER_AGENT).toMatch(/^steps:\s*10$/m);
    expect(REVIEWER_AGENT).not.toMatch(/^temperature:/m);
    expect(REVIEWER_AGENT).not.toMatch(/^top_p:/m);
    expect(REVIEWER_AGENT).not.toMatch(/^top_k:/m);
  });
});

describe('OPENCODE_JSON_TEMPLATE: no plugin array', () => {
  it('has no plugin key and retains its instruction entry', () => {
    const parsed = JSON.parse(OPENCODE_JSON_TEMPLATE('.opencode/flowguard-mandates.md'));
    expect(parsed).not.toHaveProperty('plugin');
    expect(parsed.instructions).toEqual(['.opencode/flowguard-mandates.md']);
  });

  it('stays valid JSON for arbitrary instruction paths', () => {
    for (const entry of ['.opencode/flowguard-mandates.md', 'AGENTS.md', 'custom/path.md']) {
      expect(() => JSON.parse(OPENCODE_JSON_TEMPLATE(entry))).not.toThrow();
    }
  });
});
