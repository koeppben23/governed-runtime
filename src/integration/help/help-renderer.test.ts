/**
 * @module integration/help/help-renderer.test
 * @description Golden fixture tests + edge case tests for /help rendering.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeProgressedState } from '../../fixtures.js';
import { getPolicyPreset } from '../../config/policy.js';
import { createPolicySnapshot } from '../../config/policy-snapshot.js';
import type { SessionState } from '../../state/schema.js';
import { buildHelpResult } from './help-projection.js';
import { renderHelp, buildHelpDocument } from './help-renderer.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import type { HelpResult } from './help-projection.js';

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', () => 'd');
}

function makePlanReviewState(): SessionState {
  return {
    ...(makeProgressedState('PLAN_REVIEW') as any),
    policySnapshot: sp('team'),
    activeChecks: [],
    verificationCandidates: [],
    actorInfo: undefined,
  };
}

function makeCompleteState(): SessionState {
  return {
    ...(makeProgressedState('COMPLETE') as any),
    archiveStatus: 'verified',
    policySnapshot: sp('solo'),
    activeChecks: [],
    verificationCandidates: [],
    actorInfo: undefined,
  };
}

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', '..', 'testdata', 'presentation', name);
  return readFile(p, 'utf-8');
}

function helpMarkdown(result: HelpResult): string {
  return renderHelp(result, { format: 'markdown' });
}

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function minimalResult(overrides: Partial<any> = {}): any {
  return {
    phase: { id: 'TICKET', label: 'Task captured' },
    readiness: 'ready' as const,
    blocker: null,
    nextAction: null,
    commands: [],
    artifacts: {
      status: 'not_verified' as const,
      ticket: {
        status: 'not_verified' as const,
        content: null,
        digest: null,
        preview: null,
        workflowNextAction: null,
      },
      currentPlan: {
        status: 'not_verified' as const,
        content: null,
        digest: null,
        preview: null,
        workflowNextAction: null,
      },
      currentPlanVersion: null,
    },
    ...overrides,
  };
}

// ─── Golden Fixture Tests ───────────────────────────────────────────────────────

describe('help golden fixtures', () => {
  it('help-no-session matches golden output', async () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    const output = helpMarkdown(result);
    const golden = await readGolden('help-no-session.md');
    expect(output).toBe(golden);
  });

  it('help-blocked matches golden output', async () => {
    const state = makePlanReviewState();
    const result = buildHelpResult(state, getPolicyPreset('team'), { view: 'context' });
    const output = helpMarkdown(result);
    const golden = await readGolden('help-blocked.md');
    expect(output).toBe(golden);
  });

  it('help-complete matches golden output', async () => {
    const state = makeCompleteState();
    const result = buildHelpResult(state, getPolicyPreset('solo'), { view: 'context' });
    const output = helpMarkdown(result);
    const golden = await readGolden('help-complete.md');
    expect(output).toBe(golden);
  });
});

// ─── Blocker Edge Cases ──────────────────────────────────────────────────────────

describe('help blocker rendering', () => {
  it('renders blocker with message and reasonCode', () => {
    const doc = buildHelpDocument(
      minimalResult({
        phase: { id: 'PLAN_REVIEW', label: 'Ready for plan approval' },
        readiness: 'blocked',
        blocker: { message: 'Review required.', reasonCode: 'PLAN_REVIEW_REQUIRED' },
        nextAction: { invocation: '/review-decision', description: 'Record the decision.' },
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).toContain('**Why blocked:** Review required. [PLAN_REVIEW_REQUIRED]');
  });

  it('renders blocker with only reasonCode', () => {
    const doc = buildHelpDocument(
      minimalResult({
        readiness: 'blocked',
        blocker: { message: null, reasonCode: 'MISSING_EVIDENCE' },
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).toContain('**Why blocked:** [MISSING_EVIDENCE]');
  });

  it('renders blocker with only message', () => {
    const doc = buildHelpDocument(
      minimalResult({
        readiness: 'blocked',
        blocker: { message: 'Missing ticket.', reasonCode: null },
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).toContain('**Why blocked:** Missing ticket.');
  });

  it('omits blocker line when both message and reasonCode are null', () => {
    const doc = buildHelpDocument(
      minimalResult({
        blocker: { message: null, reasonCode: null },
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).not.toContain('**Why blocked:');
  });
});

// ─── EmbeddedMarkdown Boundary Tests ─────────────────────────────────────────────

describe('embeddedMarkdown boundary normalization', () => {
  function embed(content: string): string {
    const doc = buildHelpDocument(
      minimalResult({
        phase: { id: 'COMPLETE', label: 'Complete' },
        artifacts: {
          status: 'available' as const,
          ticket: {
            status: 'available' as const,
            content,
            digest: 'abc123',
            preview: 'Test ticket',
            workflowNextAction: null,
          },
          currentPlan: {
            status: 'not_verified' as const,
            content: null,
            digest: null,
            preview: null,
            workflowNextAction: null,
          },
          currentPlanVersion: null,
        },
      }),
      true,
    );
    return renderMarkdown(doc);
  }

  it('preserves content exactly with no outer newlines', () => {
    const out = embed('# Header\n\nContent');
    expect(out).toContain('# Header\n\nContent');
  });

  it('removes trailing newline', () => {
    const out = embed('# Header\n');
    expect(out).toContain('**Ticket:**\n# Header');
    expect(out).not.toContain('# Header\n\n');
  });

  it('removes leading newline', () => {
    const out = embed('\n# Header');
    expect(out).toContain('**Ticket:**\n# Header');
  });

  it('removes multiple trailing newlines', () => {
    const out = embed('Content\n\n\n');
    expect(out).toContain('**Ticket:**\nContent');
  });

  it('preserves internal blank lines', () => {
    const out = embed('Paragraph 1\n\nParagraph 2');
    expect(out).toContain('Paragraph 1\n\nParagraph 2');
  });

  it('preserves trailing spaces within content', () => {
    const out = embed('Line with spaces  ');
    expect(out).toContain('Line with spaces  ');
  });
});

// ─── JSON Path Unchanged ─────────────────────────────────────────────────────────

describe('help JSON path unchanged', () => {
  it('produces valid JSON with title', () => {
    const state = makePlanReviewState();
    const result = buildHelpResult(state, getPolicyPreset('team'), { view: 'context' });
    const json = renderHelp(result, { format: 'json', verbose: true });
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe('FlowGuard Help');
    expect(parsed.phase).toBeTruthy();
  });
});

// ─── buildHelpDocument Structure ─────────────────────────────────────────────────

describe('buildHelpDocument structure', () => {
  it('produces help_document kind', () => {
    const doc = buildHelpDocument(minimalResult({}), false);
    expect(doc.kind).toBe('help_document');
    expect(doc.sections.length).toBeGreaterThan(0);
  });

  it('does not include artifact content when includeContent is false', () => {
    const doc = buildHelpDocument(
      minimalResult({
        phase: { id: 'COMPLETE', label: 'Complete' },
        artifacts: {
          status: 'available' as const,
          ticket: {
            status: 'available' as const,
            content: 'Ticket body',
            digest: 'abc',
            preview: 'P',
            workflowNextAction: null,
          },
          currentPlan: {
            status: 'not_verified' as const,
            content: null,
            digest: null,
            preview: null,
            workflowNextAction: null,
          },
          currentPlanVersion: null,
        },
      }),
      false,
    );
    const hasEmbedded = doc.sections.some((s) => s.kind === 'embeddedMarkdown');
    expect(hasEmbedded).toBe(false);
  });

  it('includes artifact content when includeContent is true', () => {
    const doc = buildHelpDocument(
      minimalResult({
        phase: { id: 'COMPLETE', label: 'Complete' },
        artifacts: {
          status: 'available' as const,
          ticket: {
            status: 'available' as const,
            content: 'Ticket body',
            digest: 'abc',
            preview: 'P',
            workflowNextAction: null,
          },
          currentPlan: {
            status: 'not_verified' as const,
            content: null,
            digest: null,
            preview: null,
            workflowNextAction: null,
          },
          currentPlanVersion: null,
        },
      }),
      true,
    );
    const hasEmbedded = doc.sections.some((s) => s.kind === 'embeddedMarkdown');
    expect(hasEmbedded).toBe(true);
  });
});
