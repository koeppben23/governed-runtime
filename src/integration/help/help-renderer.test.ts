import { describe, expect, it } from 'vitest';
import type { HelpResult } from './help-projection.js';
import { renderHelp } from './help-renderer.js';

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
    evidenceCompleteness: {
      status: 'not_applicable',
      summary: 'No session.',
    },
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
        preflight: {
          status: 'available',
          guarantee: 'read_only_available',
        },
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

describe('renderHelp', () => {
  it('verbose JSON is valid and has title', () => {
    const out = renderHelp(noSessionResult(), { format: 'json', verbose: true });
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.title).toBe('FlowGuard Help');
    expect(parsed.artifacts).toBeDefined();
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
    expect(out).toContain('\u2192');
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

  it('Markdown shows aliases when available', () => {
    const out = renderHelp(noSessionResult(), { format: 'markdown' });
    expect(out).toContain('**Aliases:**');
    expect(out).toContain('/hydrate');
  });

  it('Markdown shows artifact metadata when available', () => {
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
    expect(out).not.toContain('Fix auth bug'); // preview not in markdown, only digest
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
    expect(out).toContain('\u26A0');
    expect(out).toContain('/blocked');
    expect(out).toContain('SESSION_REQUIRED');
  });

  it('Markdown shows unavailable command with backtick marker in command detail mode', () => {
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
    expect(out).toContain('\u2022 `/thing`');
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
