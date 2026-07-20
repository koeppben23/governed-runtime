/**
 * @module integration/help/help-renderer.test
 * @description Original renderer tests (preserved) + golden fixture + edge case tests.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HelpResult } from './help-projection.js';
import { renderHelp, buildHelpDocument } from './help-renderer.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import { makeProgressedState } from '../../fixtures.js';
import { getPolicyPreset } from '../../config/policy.js';
import { createPolicySnapshot } from '../../config/policy-snapshot.js';
import { buildHelpResult } from './help-projection.js';
import type { SessionState } from '../../state/schema.js';

const emptyArtifact = {
  status: 'not_verified' as const,
  digest: null,
  preview: null,
  content: null,
  workflowNextAction: null,
};

function noSessionResult(overrides?: Partial<HelpResult>): HelpResult {
  return {
    phase: null,
    lifecycle: 'No active session',
    readiness: 'none',
    recommendationQuality: {
      quality: 'not_applicable',
      advisoryStatus: 'not_applicable',
      summary: '',
    },
    reviewReportStatus: 'not_available',
    nextActionSummary: 'Start a governed session.',
    evidenceCompleteness: { status: 'not_applicable', summary: 'No session.' },
    archiveVerification: {
      status: 'unknown',
      currentSnapshotVerified: false,
      summary: 'No session.',
    },
    nextAction: {
      id: 'start',
      invocation: '/start',
      label: 'Start',
      description: 'Start a governed session',
      visibility: 'recommended',
      preflight: { status: 'available', guarantee: 'eligible_to_attempt' },
      alsoAvailableAs: ['/hydrate'],
    },
    commands: [
      {
        id: 'start',
        invocation: '/start',
        label: 'Start',
        description: 'Start a governed session',
        visibility: 'recommended',
        preflight: { status: 'available', guarantee: 'eligible_to_attempt' },
        alsoAvailableAs: ['/hydrate'],
      },
      {
        id: 'status',
        invocation: '/status',
        label: 'Status',
        description: 'Show session state',
        visibility: 'available',
        preflight: { status: 'available', guarantee: 'read_only_available' },
        alsoAvailableAs: [],
      },
    ],
    artifacts: {
      ticket: emptyArtifact,
      currentPlan: emptyArtifact,
      currentPlanVersion: null,
      status: 'not_verified',
    },
    blocker: null,
    ...overrides,
  };
}

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', () => 'd');
}

function makePlanReviewState(): SessionState {
  return {
    ...makeProgressedState('PLAN_REVIEW'),
    policySnapshot: sp('team'),
    activeChecks: [],
    verificationCandidates: [],
    actorInfo: undefined,
  };
}

function makeCompleteState(): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
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

// ═══════════════════════════════════════════════════════════════════════════════
// Original renderer tests — preserved
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderHelp', () => {
  it('verbose JSON is valid and has title', () => {
    const out = renderHelp(noSessionResult(), { format: 'json', verbose: true });
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.title).toBe('FlowGuard Help');
    expect(parsed.artifacts).toBeDefined();
    expect(parsed).not.toHaveProperty('presentation');
  });

  it('verbose JSON without includeArtifactContent has no content fields', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: {
            ...emptyArtifact,
            status: 'available',
            digest: 'abc',
            preview: 'preview',
            content: 'secret body',
          },
          currentPlan: {
            ...emptyArtifact,
            status: 'available',
            digest: 'def',
            preview: 'preview',
            content: 'secret body',
          },
          currentPlanVersion: 1,
          status: 'available',
        },
      },
      { format: 'json', verbose: true },
    );
    const parsed = JSON.parse(out);
    expect(parsed.artifacts.ticket.content).toBeUndefined();
    expect(parsed.artifacts.currentPlan.content).toBeUndefined();
  });

  it('verbose JSON with includeArtifactContent=true includes content', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: {
            ...emptyArtifact,
            status: 'available',
            digest: 'abc',
            preview: 'preview',
            content: 'ticket body',
          },
          currentPlan: {
            ...emptyArtifact,
            status: 'available',
            digest: 'def',
            preview: 'preview',
            content: 'plan body',
          },
          currentPlanVersion: 1,
          status: 'available',
        },
      },
      { format: 'json', verbose: true, includeArtifactContent: true },
    );
    const parsed = JSON.parse(out);
    expect(parsed.artifacts.ticket.content).toBe('ticket body');
    expect(parsed.artifacts.currentPlan.content).toBe('plan body');
  });

  it('default Markdown for no-session shows guidance', () => {
    const out = renderHelp(noSessionResult(), { format: 'markdown' });
    expect(out).toContain('**No active FlowGuard session.**');
    expect(out).toContain('**Available commands:**');
    expect(out).toContain('→');
    expect(out).toContain('/start');
    expect(out).not.toContain('**Ticket:**');
  });

  it('Markdown shows blocker when present', () => {
    const out = renderHelp(
      noSessionResult({
        blocker: { reasonCode: 'REASON', message: 'Blocked for test' },
        readiness: 'blocked',
      }),
      { format: 'markdown' },
    );
    expect(out).toContain('**Why blocked:**');
    expect(out).toContain('Blocked for test');
    expect(out).toContain('[REASON]');
  });

  it('Markdown shows aliases per-command', () => {
    const out = renderHelp(noSessionResult(), { format: 'markdown' });
    expect(out).toContain('(aliases: `/hydrate`)');
  });

  it('Markdown shows artifact preview in metadata', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: {
            ...emptyArtifact,
            status: 'available',
            digest: 'abcdef1234567890',
            preview: 'Fix auth bug',
            content: null,
          },
          currentPlan: {
            ...emptyArtifact,
            status: 'available',
            digest: '12345678abcdef',
            preview: '## Plan',
            content: null,
          },
          currentPlanVersion: 3,
          status: 'available',
        },
      },
      { format: 'markdown' },
    );
    expect(out).toContain('**Session artifacts:**');
    expect(out).toContain('ticket: available');
    expect(out).toContain('abcdef12');
    expect(out).toContain('current plan v3: available');
    expect(out).toContain('Fix auth bug');
  });

  it('Markdown shows full content when includeArtifactContent', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: {
            ...emptyArtifact,
            status: 'available',
            digest: 'abc',
            preview: 'prev',
            content: 'Full ticket text',
          },
          currentPlan: {
            ...emptyArtifact,
            status: 'available',
            digest: 'def',
            preview: 'prev',
            content: 'Full plan body',
          },
          currentPlanVersion: 2,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    expect(out).toContain('**Ticket:**');
    expect(out).toContain('Full ticket text');
    expect(out).toContain('**Current plan (v2):**');
    expect(out).toContain('Full plan body');
  });

  it('Markdown shows NOT_VERIFIED readiness and partial artifacts separately', () => {
    const out = renderHelp(
      noSessionResult({
        readiness: 'not_verified',
        artifacts: {
          ticket: { ...emptyArtifact, status: 'not_verified' },
          currentPlan: { ...emptyArtifact, status: 'not_verified' },
          currentPlanVersion: null,
          status: 'not_verified',
        },
      }),
      { format: 'markdown' },
    );
    expect(out).toContain('**Readiness:** not_verified');
    expect(out).not.toContain('**Session artifacts:**');
  });

  it('Markdown shows blocked recoverable command with warning marker', () => {
    const out = renderHelp(
      noSessionResult({
        commands: [
          {
            id: 'blocked-cmd',
            invocation: '/blocked',
            label: 'Blocked',
            description: 'A blocked command',
            visibility: 'blocked_recoverable',
            preflight: {
              status: 'blocked',
              guarantee: 'eligible_to_attempt',
              reasonCode: 'SESSION_REQUIRED',
              message: 'Not available',
              recovery: 'Try later',
            },
            alsoAvailableAs: [],
          },
        ],
        nextAction: null,
      }),
      { format: 'markdown' },
    );
    expect(out).toContain('⚠');
    expect(out).toContain('/blocked');
    expect(out).toContain('blocked: Not available');
    expect(out).toContain('code: SESSION_REQUIRED');
    expect(out).toContain('recovery: Try later');
  });

  it('Markdown shows available command with bullet marker', () => {
    const out = renderHelp(
      noSessionResult({
        commands: [
          {
            id: 'cmd',
            invocation: '/thing',
            label: 'Thing',
            description: 'Does a thing',
            visibility: 'available',
            preflight: { status: 'available', guarantee: 'eligible_to_attempt' },
            alsoAvailableAs: [],
          },
        ],
      }),
      { format: 'markdown' },
    );
    expect(out).toContain('• `/thing`');
  });

  it('verbose flag alone does NOT include artifact content', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: { ...emptyArtifact, status: 'available', content: 'secret' },
          currentPlan: { ...emptyArtifact, status: 'not_verified' },
          currentPlanVersion: null,
          status: 'partial',
        },
      },
      { format: 'json', verbose: true },
    );
    const parsed = JSON.parse(out);
    expect(parsed.artifacts.ticket.content).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Golden fixture tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('help golden fixtures', () => {
  it('help-no-session matches golden output', async () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    const output = renderHelp(result, { format: 'markdown' });
    const golden = await readGolden('help-no-session.md');
    expect(output).toBe(golden);
  });

  it('help-blocked matches golden output', async () => {
    const state = makePlanReviewState();
    const result = buildHelpResult(state, getPolicyPreset('team'), { view: 'context' });
    const output = renderHelp(result, { format: 'markdown' });
    const golden = await readGolden('help-blocked.md');
    expect(output).toBe(golden);
  });

  it('help-complete matches golden output', async () => {
    const state = makeCompleteState();
    const result = buildHelpResult(state, getPolicyPreset('solo'), { view: 'context' });
    const output = renderHelp(result, { format: 'markdown' });
    const golden = await readGolden('help-complete.md');
    expect(output).toBe(golden);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('help blocker edge cases', () => {
  it('renders blocker with only reasonCode', () => {
    const doc = buildHelpDocument(
      noSessionResult({
        phase: { id: 'TICKET', label: 'Task captured' },
        readiness: 'blocked',
        blocker: { message: null, reasonCode: 'MISSING_EVIDENCE' },
        nextAction: null,
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).toContain('**Why blocked:** [MISSING_EVIDENCE]');
    expect(out).not.toContain('MISSING_EVIDENCE] ');
  });

  it('omits blocker line when both message and reasonCode are null', () => {
    const doc = buildHelpDocument(
      noSessionResult({
        phase: { id: 'TICKET', label: 'Task captured' },
        blocker: { message: null, reasonCode: null },
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).not.toContain('**Why blocked:');
  });

  it('blocked preflight without details renders command line only', () => {
    const blockedPreflight = {
      status: 'blocked' as const,
      message: null,
      reasonCode: null,
      recovery: null,
      guarantee: 'eligible_to_attempt' as const,
    } as any; // CommandPreflight.blocked requires non-null fields, but DetailedCommandItem.preflight.blocked allows null — bridge for renderer edge-case test
    const doc = buildHelpDocument(
      noSessionResult({
        commands: [
          {
            id: 'x',
            invocation: '/review-decision',
            label: 'Review',
            description: 'Record the decision.',
            visibility: 'blocked_recoverable',
            preflight: blockedPreflight,
            alsoAvailableAs: [],
          },
        ],
        nextAction: null,
      }),
      false,
    );
    const out = renderMarkdown(doc);
    expect(out).toContain('⚠ `/review-decision`');
    expect(out).not.toContain('blocked:');
    expect(out).not.toContain('code:');
    expect(out).not.toContain('recovery:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EmbeddedMarkdown boundary tests + ticket + plan simultaneously
// ═══════════════════════════════════════════════════════════════════════════════

describe('embeddedMarkdown boundary normalization', () => {
  it('removes trailing newline', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: { ...emptyArtifact, status: 'available', content: '# Header\n' },
          currentPlan: { ...emptyArtifact, status: 'not_verified', content: null },
          currentPlanVersion: null,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    // Label-only embed: the ticket's own `#` is demoted to `##` so it does not
    // become a second document-level H1 alongside the help title.
    expect(out).toContain('**Ticket:**\n## Header');
    expect(out).not.toContain('## Header\n\n');
  });

  it('removes leading newline', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: { ...emptyArtifact, status: 'available', content: '\n# Header' },
          currentPlan: { ...emptyArtifact, status: 'not_verified', content: null },
          currentPlanVersion: null,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    expect(out).toContain('**Ticket:**\n## Header');
  });

  it('preserves internal blank lines', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: { ...emptyArtifact, status: 'available', content: 'Paragraph 1\n\nParagraph 2' },
          currentPlan: { ...emptyArtifact, status: 'not_verified', content: null },
          currentPlanVersion: null,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    expect(out).toContain('Paragraph 1\n\nParagraph 2');
  });

  it('strips trailing spaces within content (structural whitespace invariant)', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: { ...emptyArtifact, status: 'available', content: 'Line with spaces  ' },
          currentPlan: { ...emptyArtifact, status: 'not_verified', content: null },
          currentPlanVersion: null,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    // The contract forbids trailing whitespace on any line (§3); embedded
    // content is sanitised at the renderer boundary.
    expect(out).toContain('Line with spaces');
    expect(out).not.toMatch(/[ \t]+$/m);
  });

  it('renders ticket and plan simultaneously with correct order', () => {
    const out = renderHelp(
      {
        ...noSessionResult(),
        artifacts: {
          ticket: {
            ...emptyArtifact,
            status: 'available',
            digest: 'a',
            preview: 'T',
            content: 'Ticket content here',
          },
          currentPlan: {
            ...emptyArtifact,
            status: 'available',
            digest: 'b',
            preview: 'P',
            content: 'Plan content here',
          },
          currentPlanVersion: 1,
          status: 'available',
        },
      },
      { format: 'markdown', includeArtifactContent: true },
    );
    const ticketIdx = out.indexOf('**Ticket:**');
    const planIdx = out.indexOf('**Current plan (v1):**');
    expect(ticketIdx).toBeGreaterThan(0);
    expect(planIdx).toBeGreaterThan(ticketIdx);
    expect(out).toContain('Ticket content here');
    expect(out).toContain('Plan content here');
  });
});
