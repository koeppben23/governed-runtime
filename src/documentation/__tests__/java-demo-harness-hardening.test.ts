/**
 * @module documentation/java-demo-harness-hardening
 * @description Regression guards for the hardened live-demo host command transport.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  Runner,
  assertTypedAuditDenial,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';

describe('live demo harness hardening', () => {
  it('routes positive approvals through the shared turn evidence path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-approve-turn-'));
    try {
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      let observedOptions: Record<string, unknown> | undefined;
      runner.turn = async (_session, _label, _prompt, options = {}) => {
        observedOptions = options;
        return {
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          durationMs: 0,
          sessionIds: ['ses_parent'],
        };
      };
      runner.requireBoundState = () => ({
        state: { phase: 'EVIDENCE_REVIEW' },
        sessionDir: root,
      });
      const session = { workspace: root, terminal: 'COMPLETE', sessionId: 'ses_parent' };
      await runner.approve(session, 'approve-evidence', 'EVIDENCE_REVIEW');
      expect(observedOptions).toMatchObject({
        command: 'approve',
        expectedTargetPhase: 'EXPORT_READY',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a missing audit success flag as a success or denial', () => {
    expect(() =>
      assertTypedAuditDenial(
        [
          {
            tool: 'flowguard_decision',
            success: null,
            errorCode: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
          },
        ],
        'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
        'flowguard_decision',
      ),
    ).toThrow(/expected typed denial/);
  });

  it('reserves the evidence slot before dispatching a mutating host command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-evidence-reservation-'));
    const fetchSpy = vi.fn();
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      await fs.writeFile(path.join(root, 'service.json'), JSON.stringify({ port: 49375 }));
      await fs.writeFile(path.join(root, 'evidence', 'approve.jsonl'), 'existing\n');
      vi.stubGlobal('fetch', fetchSpy);
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      const session = { workspace: root, sessionId: 'ses_parent' };
      await expect(runner.hostCommand(session, 'approve', 'approve')).rejects.toThrow(
        /evidence file already exists/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('marks a timed-out mutating host command as unknown outcome', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-command-timeout-'));
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      await fs.writeFile(path.join(root, 'service.json'), JSON.stringify({ port: 49375 }));
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return Promise.resolve({
          status: 200,
          text: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });
      });
      const runner = new Runner(
        root,
        { model: 'test/model', flows: [], hostCommandTimeoutMs: 20 },
        root,
      );
      const session = { workspace: root, sessionId: 'ses_parent' };
      await expect(runner.hostCommand(session, 'approve', 'approve')).rejects.toMatchObject({
        code: 'HOST_COMMAND_UNKNOWN_OUTCOME',
      });
      const evidence = await fs.readFile(path.join(root, 'evidence', 'approve.jsonl'), 'utf8');
      expect(evidence).toContain('host_command_started');
      expect(evidence).toContain('HOST_TIMEOUT');
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('binds an expected denial to its authority tool in new audit events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-denial-tool-'));
    try {
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.hostCommand = async () => ({ status: 204, body: '' });
      runner.waitForSessionIdle = async () => {};
      runner.requireBoundState = () => ({
        state: { flowguardSessionId: 'fg-session' },
        sessionDir: root,
      });
      runner.readAuditEventsSince = () => [
        {
          event: 'tool_call:flowguard_plan',
          hostSessionId: 'ses_parent',
          flowguardSessionId: 'fg-session',
          auditSequence: 1,
          detail: {
            tool: 'flowguard_plan',
            success: false,
            errorCode: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
          },
        },
      ];
      const session = { workspace: root, terminal: 'COMPLETE', sessionId: 'ses_parent' };
      const wrong = await runner.hostCommandTransport(session, 'approve', 'approve', 'x', 0);
      expect(() =>
        assertTypedAuditDenial(
          wrong.auditEvidence,
          'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
          'flowguard_decision',
        ),
      ).toThrow(/expected typed denial/);

      runner.readAuditEventsSince = () => [
        {
          event: 'tool_call:flowguard_decision',
          hostSessionId: 'ses_parent',
          flowguardSessionId: 'fg-session',
          auditSequence: 2,
          detail: {
            tool: 'flowguard_decision',
            success: false,
            errorCode: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
          },
        },
      ];
      const right = await runner.hostCommandTransport(session, 'approve', 'approve', 'x', 0);
      expect(() =>
        assertTypedAuditDenial(
          right.auditEvidence,
          'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
          'flowguard_decision',
        ),
      ).not.toThrow();

      runner.readAuditEventsSince = () => [
        {
          event: 'tool_call:flowguard_decision',
          hostSessionId: 'ses_foreign',
          flowguardSessionId: 'fg-session',
          auditSequence: 3,
          detail: {
            tool: 'flowguard_decision',
            success: false,
            errorCode: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
          },
        },
      ];
      await expect(
        runner.hostCommandTransport(session, 'approve', 'approve', 'x', 0),
      ).rejects.toThrow(/identity\/sequence mismatch/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
