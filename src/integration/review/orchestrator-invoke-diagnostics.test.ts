import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { invokeReviewer } from './orchestrator.js';
import {
  validFindings,
  NO_SLEEP,
  TEXT_COMPAT_OPTIONS,
  makeClient,
  PROMPT,
} from './orchestrator-test-helpers.js';
describe('invokeReviewer — diagnostics contract', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  describe('DIAGNOSTIC — _onAttemptFailed callback', () => {
    it('fires with step=session_create when create fails', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        createResult: { error: { message: 'forbidden' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('session_create');
      expect(diagnostics[0]!.attempt).toBe(1);
    });

    it('fires with step=session_prompt when prompt returns error', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: { error: { message: 'bad request' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('session_prompt');
      expect(diagnostics[0]!.attempt).toBe(1);
    });

    it('fires with step=no_findings when structured output absent', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('no_findings');
      expect((diagnostics[0]!.details as Record<string, unknown>).infoKeys).toEqual([]);
    });

    it('fires with step=structured_output_error for StructuredOutputError', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'StructuredOutputError', message: 'failed' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('structured_output_error');
    });

    it('fires once per attempt on repeated failures', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: { error: { message: 'timeout' }, data: undefined },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 2,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.map((d) => d.attempt)).toEqual([1, 2, 3]);
      expect(diagnostics.every((d) => d.step === 'session_prompt')).toBe(true);
    });

    it('includes infoKeys in no_findings diagnostic for debugging', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [{ type: 'text', text: 'not json' }],
            info: { structured: null, error: undefined },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        ...TEXT_COMPAT_OPTIONS,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      expect(diagnostics).toHaveLength(1);
      const details = diagnostics[0]!.details as Record<string, unknown>;
      expect(details.hasInfo).toBe(true);
      expect(details.partsCount).toBe(1);
      expect(details.textPartsLength).toBe(8); // "not json" = 8 chars
    });

    // ─── info_error step: non-StructuredOutputError surfacing ─────────────────

    it('fires info_error step for non-StructuredOutputError errors in info', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: { name: 'SessionError', message: 'unspecified session error' } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Should fire both info_error (for the error) and no_findings (no structured output)
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]!.step).toBe('info_error');
      expect(diagnostics[0]!.error).toEqual({
        name: 'SessionError',
        message: 'unspecified session error',
      });
      const errorDetails = diagnostics[0]!.details as Record<string, unknown>;
      expect(errorDetails.errorName).toBe('SessionError');
      expect(errorDetails.errorMessage).toBe('unspecified session error');
      // Second diagnostic: no_findings with infoError included
      expect(diagnostics[1]!.step).toBe('no_findings');
    });

    it('includes infoError value in no_findings details when info.error is present', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const sessionError = { name: 'AgentError', message: 'agent not found' };
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: sessionError },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Find the no_findings diagnostic
      const noFindings = diagnostics.find((d) => d.step === 'no_findings');
      expect(noFindings).toBeDefined();
      const details = noFindings!.details as Record<string, unknown>;
      expect(details.infoError).toEqual(sessionError);
    });

    it('surfaces info.error as string (non-object runtime shape)', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      // At runtime, info.error could be a plain string from the server.
      // TypeScript types say object, but we must be resilient.
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: { error: 'unspecified session error' as unknown as { name: string } },
          },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // info_error should still fire with the string value surfaced
      const infoError = diagnostics.find((d) => d.step === 'info_error');
      expect(infoError).toBeDefined();
      expect(infoError!.error).toBe('unspecified session error');
      const errorDetails = infoError!.details as Record<string, unknown>;
      expect(errorDetails.errorName).toBe('string'); // typeof string
      expect(errorDetails.errorMessage).toBe('unspecified session error');
      // no_findings should include the string error in infoError
      const noFindings = diagnostics.find((d) => d.step === 'no_findings');
      expect(noFindings).toBeDefined();
      expect((noFindings!.details as Record<string, unknown>).infoError).toBe(
        'unspecified session error',
      );
    });

    it('does NOT fire info_error when info.error is absent', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: { parts: [], info: {} },
          error: undefined,
        },
      });
      await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // Only no_findings should fire, not info_error
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('no_findings');
      expect((diagnostics[0]!.details as Record<string, unknown>).infoError).toBeNull();
    });

    it('info_error fires but findings still returned when structured_output coexists with error', async () => {
      const diagnostics: Array<Record<string, unknown>> = [];
      const findings = validFindings();
      const client = makeClient({
        agents: [{ id: 'flowguard-reviewer' }],
        promptResult: {
          data: {
            parts: [],
            info: {
              error: { name: 'PartialWarning', message: 'some warning' },
              structured_output: findings,
            },
          },
          error: undefined,
        },
      });
      const result = await invokeReviewer(client, PROMPT, 'parent-1', {
        maxRetries: 0,
        _sleepFn: NO_SLEEP,
        _onAttemptFailed: (info) => diagnostics.push(info),
      });
      // info_error fires for the warning
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.step).toBe('info_error');
      // But findings are still returned successfully (error doesn't block valid output)
      expect(result).not.toBeNull();
      expect(result!.findings).toBeTruthy();
      expect(result!.findings!.overallVerdict).toBe(findings.overallVerdict);
    });
  });
});
