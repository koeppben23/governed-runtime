/**
 * @module templates/mandates-schema-drift.test
 * @description Guards the permanent reviewer-template boundary. Finding schemas
 * and serialization belong to the invocation-specific Task prompt.
 */

import { describe, expect, it } from 'vitest';

import { REVIEWER_AGENT } from './mandates.js';
import { PLUGIN_WRAPPER } from './wrappers/index.js';

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

describe('native plugin installation template', () => {
  it('loads only the native default entrypoint without global instruction or tool registration', () => {
    expect(PLUGIN_WRAPPER).toContain(
      'export { default } from "@flowguard/core/integration/plugin"',
    );
    expect(PLUGIN_WRAPPER).not.toMatch(
      /instructions|permission|TOOL_WRAPPER|FlowGuardAuditPlugin\(/,
    );
  });
});
