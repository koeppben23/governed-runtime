/**
 * @module hooks/shared/reviewer-capture-writer.test
 * @description Tests for reviewer-capture-writer — agent type detection, review tool identification,
 * obligation extraction, and capture persistence.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isReviewerAgentType,
  isReviewTool,
  extractObligationId,
  writeReviewerCapture,
} from './reviewer-capture-writer.js';

// ─── isReviewerAgentType ──────────────────────────────────────────────────────

describe('isReviewerAgentType', () => {
  it('returns true for flowguard-reviewer agent type', () => {
    expect(isReviewerAgentType('flowguard-reviewer')).toBe(true);
  });

  it('returns false for other agent types', () => {
    expect(isReviewerAgentType('coder')).toBe(false);
    expect(isReviewerAgentType('planner')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isReviewerAgentType(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isReviewerAgentType('')).toBe(false);
  });
});

// ─── isReviewTool ─────────────────────────────────────────────────────────────

describe('isReviewTool', () => {
  it('returns true for exact match', () => {
    expect(isReviewTool('flowguard_review')).toBe(true);
  });

  it('returns true for MCP-namespaced review tool', () => {
    expect(isReviewTool('mcp__flowguard__flowguard_review')).toBe(true);
  });

  it('returns false for other tools', () => {
    expect(isReviewTool('Bash')).toBe(false);
    expect(isReviewTool('Write')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isReviewTool(undefined)).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isReviewTool(42 as unknown as string)).toBe(false);
  });
});

// ─── extractObligationId ──────────────────────────────────────────────────────

describe('extractObligationId', () => {
  it('extracts from reviewFindings.attestation.toolObligationId', () => {
    const input = {
      reviewFindings: {
        attestation: { toolObligationId: 'obl-123' },
      },
    };
    expect(extractObligationId(input)).toBe('obl-123');
  });

  it('extracts from top-level attestation.toolObligationId', () => {
    const input = {
      attestation: { toolObligationId: 'obl-direct' },
    };
    expect(extractObligationId(input)).toBe('obl-direct');
  });

  it('extracts from input.toolObligationId directly', () => {
    const input = { toolObligationId: 'obl-flat' };
    expect(extractObligationId(input)).toBe('obl-flat');
  });

  it('returns undefined when no obligation id found', () => {
    const input = { otherField: 'value' };
    expect(extractObligationId(input)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(extractObligationId({})).toBeUndefined();
  });

  it('returns undefined when toolObligationId is empty string', () => {
    const input = { attestation: { toolObligationId: '' } };
    expect(extractObligationId(input)).toBeUndefined();
  });

  it('prioritizes reviewFindings path over direct input', () => {
    const input = {
      toolObligationId: 'obl-later',
      reviewFindings: {
        attestation: { toolObligationId: 'obl-first' },
      },
    };
    expect(extractObligationId(input)).toBe('obl-first');
  });

  it('falls back when reviewFindings has no obligation', () => {
    const input = {
      reviewFindings: { attestation: {} },
      attestation: { toolObligationId: 'obl-fallback' },
    };
    expect(extractObligationId(input)).toBe('obl-fallback');
  });
});

// ─── writeReviewerCapture ─────────────────────────────────────────────────────

describe('writeReviewerCapture', () => {
  const sessionDir = '/tmp/session-dir';
  const log = vi.fn();

  it('returns null for non-reviewer agent type', async () => {
    const result = await writeReviewerCapture(
      sessionDir,
      {
        source: 'post_tool_use_hook',
        sessionId: 'sess-1',
        agentId: 'agent-1',
        agentType: 'coder',
      },
      log,
    );
    expect(result).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('returns null when agentId is missing', async () => {
    const result = await writeReviewerCapture(
      sessionDir,
      {
        source: 'post_tool_use_hook',
        sessionId: 'sess-1',
        agentId: undefined,
        agentType: 'flowguard-reviewer',
      },
      log,
    );
    expect(result).toBeNull();
  });

  it('returns null when agentType is undefined', async () => {
    const result = await writeReviewerCapture(
      sessionDir,
      {
        source: 'post_tool_use_hook',
        sessionId: 'sess-1',
        agentId: 'agent-1',
        agentType: undefined,
      },
      log,
    );
    expect(result).toBeNull();
  });
});
