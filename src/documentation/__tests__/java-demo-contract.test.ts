/**
 * @module documentation/java-demo-contract
 * @description Keeps the Java demo's initial fixture, ticket, runbook, and architecture task aligned.
 */

import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOWS,
  Runner,
  assertArchitectureProbeNotPersisted,
  enableRawArchiveInRepoConfig,
  unexpectedDenialCodes,
  captureRetryCodes,
  planReviewSameTurnCorrection,
  planReviewCorrectionProven,
  structuredRearmSupersedesTerminal,
  assertExpectedDenial,
  assertSessionBinding,
  matrixExitCode,
  readPins,
  runFlows,
  sha256,
  transcriptTargets,
  verificationFlowFor,
  verifyChecksumSidecar,
  withRawExportGrant,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEMO_DIR = path.join(REPO_ROOT, 'demos', 'java-task-manager');
const ROOT_SETUP_SCRIPT = path.join(REPO_ROOT, 'run-demo-setup.sh');
const SETUP_SCRIPT = path.join(DEMO_DIR, 'run-main-demo-setup.sh');
const SEED_DIR = path.join(DEMO_DIR, 'seed');
const TICKET_PATH = path.join(SEED_DIR, 'TICKET.md');
const ADR_TICKET_PATH = path.join(SEED_DIR, 'ADR_TICKET.md');
const README_PATH = path.join(DEMO_DIR, 'README.md');
const DEMO_SCRIPT_PATH = path.join(DEMO_DIR, 'DEMO_SCRIPT.md');
const REDUCED_CEREMONY_PATH = path.join(DEMO_DIR, 'REDUCED_CEREMONY.md');
const REDUCED_SETUP_SCRIPT = path.join(DEMO_DIR, 'run-reduced-ceremony-demo-setup.sh');
const TICKET_DOCS_PATH = path.join(SEED_DIR, 'TICKET_DOCS.md');
const PROOFGRAPH_VARIANTS_PATH = path.join(REPO_ROOT, 'demos', 'proofgraph-variants.md');
const CONTROLLER_TEST_PATH = path.join(
  SEED_DIR,
  'src',
  'test',
  'java',
  'com',
  'example',
  'taskmanager',
  'controller',
  'TaskControllerTest.java',
);
const SERVICE_PATH = path.join(
  SEED_DIR,
  'src',
  'main',
  'java',
  'com',
  'example',
  'taskmanager',
  'service',
  'TaskService.java',
);
const REPO_PATH = path.join(
  SEED_DIR,
  'src',
  'main',
  'java',
  'com',
  'example',
  'taskmanager',
  'repository',
  'TaskRepository.java',
);

function extractSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');

  const body = pattern.exec(markdown)?.[1];
  if (body === undefined) {
    throw new Error(`Missing section: ## ${heading}`);
  }

  return body.trim();
}

describe('Java Task Manager demo contract', () => {
  it('ships a live-matrix runner whose pins come from the canonical authorities', async () => {
    const runnerPath = path.join(DEMO_DIR, 'run-live-matrix.mjs');
    const runner = await fs.readFile(runnerPath, 'utf-8');
    const readme = await fs.readFile(README_PATH, 'utf-8');

    // Pins come from the canonical authorities; no semver literal is hardcoded.
    expect(runner).toContain('opencode-runtime-compat.ts');
    expect(runner).toContain('.node-version');
    expect(runner).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    expect(readPins()).toEqual({
      opencode: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      node: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });

    // Explicit host context and the isolated config environment.
    expect(runner).toContain("'--dir'");
    expect(runner).toContain('OPENCODE_CONFIG_DIR');

    // The README points operators at the runner instead of ad-hoc drivers.
    expect(readme).toContain('run-live-matrix.mjs');
  });

  it('maps matrix scenarios to verifier flows and fails the matrix on any incomplete flow', () => {
    // The reduced-ceremony scenarios are development flows for the verifier;
    // scenario names are never verifier flow names.
    expect(verificationFlowFor('reduced-on')).toBe('development');
    expect(verificationFlowFor('reduced-off')).toBe('development');
    expect(verificationFlowFor('development')).toBe('development');
    expect(() => verificationFlowFor('architecture-negative')).toThrow(/verifier flow/);

    expect(matrixExitCode([{ result: 'COMPLETE' }])).toBe(0);
    expect(matrixExitCode([{ result: 'COMPLETE' }, { result: 'BLOCKED' }])).toBe(1);
    expect(matrixExitCode([{ result: 'BLOCKED' }])).toBe(1);
  });

  it('verifies the persisted host and worktree binding before accepting a flow', () => {
    const state = { binding: { hostSessionId: 'ses_parent', worktree: REPO_ROOT } };
    expect(() => assertSessionBinding(state, 'ses_parent', REPO_ROOT)).not.toThrow();
    expect(() => assertSessionBinding(state, 'ses_other', REPO_ROOT)).toThrow(/host binding/);
    expect(() => assertSessionBinding(state, 'ses_parent', path.join(REPO_ROOT, 'demos'))).toThrow(
      /worktree binding/,
    );
  });

  it('treats the architecture probe as a controlled denial with non-persistence', () => {
    const toolLine = (code: string) =>
      JSON.stringify({
        type: 'tool_use',
        part: { state: { output: JSON.stringify({ error: true, code }) } },
      });
    const expected = toolLine('ARCHITECTURE_CLAIM_INVALID');
    expect(() => assertExpectedDenial(expected, 'ARCHITECTURE_CLAIM_INVALID')).not.toThrow();
    expect(() => assertExpectedDenial(expected, 'OTHER_CODE')).toThrow(/expected denial/);
    expect(() =>
      assertExpectedDenial(
        `${expected}\n${toolLine('SOME_OTHER_DENIAL')}`,
        'ARCHITECTURE_CLAIM_INVALID',
      ),
    ).toThrow(/unexpected denial/);

    expect(() => assertArchitectureProbeNotPersisted({ architecture: null })).not.toThrow();
    expect(() => assertArchitectureProbeNotPersisted({ architecture: {} })).toThrow(/persisted/);
  });

  it('initializes the runner with the workspace root and wires every flow entry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-runner-init-'));
    try {
      const runner = new Runner(
        root,
        { model: 'test/model', flows: [] },
        path.join(root, 'config'),
      );
      expect(runner.workspaces).toBe(path.join(root, 'workspaces'));

      const flows = await runFlows(runner);
      expect(Object.keys(flows).sort()).toEqual([...DEFAULT_FLOWS].sort());
      expect(flows.development.workspace).toBe(path.join(root, 'workspaces', 'java-task-manager'));
      expect(flows['reduced-on'].workspace).toBe(
        path.join(root, 'workspaces', 'reduced-ceremony', 'reduced-on'),
      );
      // The negative probe governs its own pristine seed copy, never the
      // workspace the development flow already modified.
      expect(flows['architecture-negative'].workspace).toBe(
        path.join(root, 'workspaces', 'java-task-manager-architecture-negative'),
      );
      expect(flows['architecture-negative']).toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a tarball that does not match its checksums.sha256', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-runner-sha-'));
    try {
      const tarball = path.join(dir, 'flowguard-core-9.9.9.tgz');
      const sidecar = path.join(dir, 'checksums.sha256');
      await fs.writeFile(tarball, 'tarball-bytes');
      const digest = sha256(tarball);
      await fs.writeFile(sidecar, `${digest}  flowguard-core-9.9.9.tgz\n`);
      expect(verifyChecksumSidecar(tarball, sidecar)).toEqual({
        sha256: digest,
        name: 'flowguard-core-9.9.9.tgz',
      });

      // Tampered tarball: the recorded digest no longer matches.
      await fs.writeFile(tarball, 'tampered-bytes');
      expect(() => verifyChecksumSidecar(tarball, sidecar)).toThrow(/checksum mismatch/);

      // The sidecar must record exactly this tarball's filename.
      await fs.writeFile(tarball, 'tarball-bytes');
      await fs.writeFile(sidecar, `${digest}  other-name.tgz\n`);
      expect(() => verifyChecksumSidecar(tarball, sidecar)).toThrow(/records 'other-name.tgz'/);

      await fs.writeFile(sidecar, 'not-a-checksum\n');
      expect(() => verifyChecksumSidecar(tarball, sidecar)).toThrow(/malformed/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers the negative probe with a ticket-aligned ADR while retaining the denial and gates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-negative-recovery-'));
    const calls: Array<{ label: string; prompt?: string; options?: { expectedDenial?: string } }> =
      [];
    try {
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.turn = async (_session, label, prompt, options = {}) => {
        calls.push({ label, prompt, options });
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0, sessionIds: [] };
      };
      runner.requireBoundState = () => ({ state: { architecture: null }, sessionDir: root });
      runner.approve = async (_session, label, phase) => {
        expect(phase).toBe('ARCH_REVIEW');
        calls.push({ label });
      };
      runner.verifyPackage = () => ({
        kind: 'archive',
        file: 'archive.tar.gz',
        sha256: 'a'.repeat(64),
      });
      const flow = (await runFlows(runner))['architecture-negative'];
      await flow.run({ workspace: flow.workspace });
      expect(calls.map((call) => call.label)).toEqual([
        'architecture-negative-02-probe',
        'architecture-negative-03-recovery',
        'architecture-negative-04-approve',
        'architecture-negative-05-archive',
      ]);
      expect(calls[0]!.options?.expectedDenial).toBe('ARCHITECTURE_CLAIM_INVALID');
      expect(calls[0]!.prompt).toContain('"claimScope":"specific_behavior"');
      expect(calls[1]!.prompt).toContain('ADR_TICKET.md and TICKET.md');
      expect(calls[1]!.prompt).toContain('Service-Layer Null-Safety');
      expect(calls[1]!.prompt).toContain(
        'options, trade-offs, consequences and falsifiable validation path',
      );
      expect(calls[1]!.prompt).toContain('not the ADR subject and not repository evidence');
      expect(calls[1]!.prompt).toContain('full fresh independent review');
      expect(calls[1]!.prompt).toContain('Do not use a governance override');
      calls.length = 0;
      runner.requireBoundState = () => ({ state: { architecture: {} }, sessionDir: root });
      await expect(flow.run({ workspace: flow.workspace })).rejects.toThrow(
        /probe declaration was persisted/,
      );
      expect(calls.map((call) => call.label)).toEqual(['architecture-negative-02-probe']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records a terminal block without discarding a flow that already completed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-terminal-block-'));
    const terminalLine = JSON.stringify({
      type: 'tool_use',
      part: {
        state: {
          output: JSON.stringify({ error: true, code: 'REVIEW_EVIDENCE_NOT_OBSERVED' }),
        },
      },
    });
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${terminalLine}\n`,
      });

      // The session already reached its terminal phase: record, do not stop.
      runner.requireBoundState = () => ({
        state: { phase: 'PEER_REVIEW_COMPLETE' },
        sessionDir: root,
      });
      const completed: {
        workspace: string;
        terminal: string;
        terminalBlocks?: Array<Record<string, unknown>>;
      } = { workspace: root, terminal: 'PEER_REVIEW_COMPLETE' };
      await expect(runner.turn(completed, 'peer-review-02-review', 'x')).resolves.toBeDefined();
      expect(completed.terminalBlocks).toEqual([
        {
          step: 'peer-review-02-review',
          codes: ['REVIEW_EVIDENCE_NOT_OBSERVED'],
          phaseBefore: 'PEER_REVIEW_COMPLETE',
          phaseAfter: 'PEER_REVIEW_COMPLETE',
          denialAfterTerminal: true,
        },
      ]);

      // Any other phase keeps the fail-closed stop; a review-stage capture or
      // consistency block is an unreached proof, not a contract violation.
      runner.requireBoundState = () => ({ state: { phase: 'PEER_REVIEW' }, sessionDir: root });
      const unfinished: {
        workspace: string;
        terminal: string;
        terminalBlocks?: Array<Record<string, unknown>>;
      } = { workspace: root, terminal: 'PEER_REVIEW_COMPLETE' };
      await expect(runner.turn(unfinished, 'peer-review-02-review', 'x')).rejects.toThrow(
        /NOT_VERIFIED/,
      );
      expect(unfinished.terminalBlocks).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records the terminal block ordering only when it is causally proven', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-terminal-order-'));
    const blockLine = JSON.stringify({
      type: 'tool_use',
      part: { state: { output: JSON.stringify({ error: true, code: 'ARCHIVE_FAILED' }) } },
    });
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${blockLine}\n`,
      });

      // Terminal reached DURING this turn: ordering is not provable -> null.
      const phases = ['PEER_REVIEW', 'PEER_REVIEW_COMPLETE'];
      runner.requireBoundState = () => ({
        state: { phase: phases.shift() ?? 'PEER_REVIEW_COMPLETE' },
        sessionDir: root,
      });
      const during = {
        workspace: root,
        terminal: 'PEER_REVIEW_COMPLETE',
        terminalBlocks: [] as Array<Record<string, unknown>>,
      };
      await runner.turn(during, 'peer-review-09', 'x');
      expect(during.terminalBlocks[0]).toEqual({
        step: 'peer-review-09',
        codes: ['ARCHIVE_FAILED'],
        phaseBefore: 'PEER_REVIEW',
        phaseAfter: 'PEER_REVIEW_COMPLETE',
        denialAfterTerminal: null,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never accepts a terminal state when the transcript is untrustworthy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-trust-boundary-'));
    const unreadableGoverned = JSON.stringify({
      type: 'tool_use',
      part: { tool: 'flowguard_plan', state: { output: '{"error":tru' } },
    });
    const damagedFrame = '{"type":"tool_use","part":{';
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${unreadableGoverned}\n${damagedFrame}\n`,
      });
      // Even a persisted terminal phase must not launder the untrustworthy turn.
      runner.requireBoundState = () => ({
        state: { phase: 'PEER_REVIEW_COMPLETE' },
        sessionDir: root,
      });
      const session: {
        workspace: string;
        terminal: string;
        terminalBlocks?: Array<Record<string, unknown>>;
        transcriptWarnings?: Array<Record<string, unknown>>;
      } = { workspace: root, terminal: 'PEER_REVIEW_COMPLETE' };
      await expect(runner.turn(session, 'peer-review-09', 'x')).rejects.toThrow(/NOT_VERIFIED/);
      expect(session.terminalBlocks ?? []).toEqual([]);
      expect(session.transcriptWarnings?.[0]).toMatchObject({ step: 'peer-review-09' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('requires a proven in-session retry before a recoverable denial counts as recovered', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-same-turn-'));
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const denial = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'flowguard_plan',
          state: { output: JSON.stringify({ error: true, code: 'REVISED_PLAN_REQUIRED' }) },
        },
      });
      const success = JSON.stringify({
        type: 'tool_use',
        part: { tool: 'flowguard_plan', state: { output: JSON.stringify({ reviewDispatch: {} }) } },
      });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.requireBoundState = () => ({ state: { phase: 'PLAN' }, sessionDir: root });

      // No later success: the recovery is unproven and the flow stops.
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${denial}\n`,
      });
      await expect(runner.turn({ workspace: root }, 'plan-a', 'x')).rejects.toThrow(
        /without a later proven correction/,
      );

      // Later success of the same tool proves the in-session correction.
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${denial}\n${success}\n`,
      });
      const session: {
        workspace: string;
        recoveredDenials?: Array<Record<string, unknown>>;
      } = { workspace: root };
      await runner.turn(session, 'plan-b', 'x');
      expect(session.recoveredDenials).toEqual([
        { step: 'plan-b', codes: ['REVISED_PLAN_REQUIRED'], evidence: 'same_turn_retry_success' },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a next-step recovery only on a demonstrated state transition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-next-step-'));
    const statePath = path.join(root, 'session-state.json');
    const pending = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'flowguard_continue',
        state: { output: JSON.stringify({ error: true, code: 'CONTINUE_AMBIGUOUS' }) },
      },
    });
    const clean = JSON.stringify({
      type: 'tool_use',
      part: { tool: 'flowguard_architecture', state: { output: JSON.stringify({ ok: true }) } },
    });
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify({ phase: 'READY' }));
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.requireBoundState = () => ({ state: { phase: 'READY' }, sessionDir: root });

      // Turn 1: the denial is pending, not yet recovered.
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${pending}\n`,
      });
      const session: {
        workspace: string;
        recoveredDenials?: Array<Record<string, unknown>>;
        awaitingRecovery?: { step: string; codes: string[] };
      } = { workspace: root };
      await runner.turn(session, 'start', 'x');
      expect(session.recoveredDenials ?? []).toEqual([]);
      expect(session.awaitingRecovery).toMatchObject({
        step: 'start',
        codes: ['CONTINUE_AMBIGUOUS'],
      });

      // Turn 2 without a state change: unproven -> stop.
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${clean}\n`,
      });
      await expect(runner.turn(session, 'task', 'x')).rejects.toThrow(
        /was not demonstrated by a state transition/,
      );

      // Turn 3 with a real state change: recovered, evidence-bound.
      await fs.writeFile(statePath, JSON.stringify({ phase: 'TICKET' }));
      await runner.turn(session, 'task-2', 'x');
      expect(session.recoveredDenials).toEqual([
        {
          step: 'start',
          codes: ['CONTINUE_AMBIGUOUS'],
          evidence: 'next_step_state_transition:task-2',
        },
      ]);
      expect(session.awaitingRecovery).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes the raw-export grant on success and on initialization failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-runner-grant-'));
    const grant = path.join(dir, 'flowguard.json');
    try {
      const value = await withRawExportGrant(dir, async () => {
        expect(await fs.readFile(grant, 'utf-8')).toContain('"allowRawExport":true');
        return 42;
      });
      expect(value).toBe(42);
      await expect(fs.access(grant)).rejects.toThrow();

      await expect(
        withRawExportGrant(dir, async () => {
          throw new Error('initialization failed');
        }),
      ).rejects.toThrow('initialization failed');
      await expect(fs.access(grant)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes recoverable typed denials from flow-stopping blocks', () => {
    const toolLine = (code: string) =>
      JSON.stringify({
        type: 'tool_use',
        part: { state: { output: JSON.stringify({ error: true, code }) } },
      });
    const recoverable = [
      toolLine('PROOFGRAPH_CLAIM_NOT_DECLARED'),
      toolLine('ADR_REVIEW_IN_PROGRESS'),
      // Run 11: typed input validation recovered from in-session.
      toolLine('EMPTY_ADR_TITLE'),
      toolLine('EMPTY_ADR_TEXT'),
      // Run 13: a plan revision omitted planText and was corrected in-session.
      toolLine('REVISED_PLAN_REQUIRED'),
      // Run 14: /continue cannot choose between flows; the explicit step does.
      toolLine('CONTINUE_AMBIGUOUS'),
    ].join('\n');
    expect(unexpectedDenialCodes(recoverable)).toEqual([]);
    const mixed = `${recoverable}\n${toolLine('ARCHIVE_FAILED')}`;
    expect(unexpectedDenialCodes(mixed)).toEqual(['ARCHIVE_FAILED']);
    const terminal = [
      toolLine('REVIEW_ATTEMPT_UNAVAILABLE'),
      toolLine('SUBAGENT_MANDATE_MISMATCH'),
    ].join('\n');
    expect(unexpectedDenialCodes(terminal)).toEqual([
      'REVIEW_ATTEMPT_UNAVAILABLE',
      'SUBAGENT_MANDATE_MISMATCH',
    ]);
  });

  it('accepts a plan-review correction only with same-turn and persisted proof', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-plan-correction-'));
    try {
      const denied = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'flowguard_plan',
          state: { output: JSON.stringify({ error: true, code: 'PLAN_REVIEW_IN_PROGRESS' }) },
        },
      });
      const corrected = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'flowguard_plan',
          state: { output: JSON.stringify({ phase: 'PLAN', status: 'review' }) },
        },
      });
      expect(planReviewSameTurnCorrection(`${denied}\n${corrected}\n`)).toBe(true);
      expect(planReviewSameTurnCorrection(`${corrected}\n${denied}\n`)).toBe(false);

      expect(
        planReviewCorrectionProven({
          plan: { reviewCompletion: 'reviewer_accepted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'accept' },
        }),
      ).toBe(true);
      expect(
        planReviewCorrectionProven({
          plan: { reviewCompletion: 'review_exhausted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'accept' },
        }),
      ).toBe(false);
      expect(
        planReviewCorrectionProven({
          plan: { reviewCompletion: 'reviewer_accepted' },
          selfReview: { iteration: 4, maxIterations: 3, verdict: 'accept' },
        }),
      ).toBe(false);

      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      const hostResult = (stdout: string) => async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout,
      });
      const session: {
        workspace: string;
        recoveredDenials: Array<Record<string, unknown>>;
        pendingPlanReviewCorrection?: { steps: string[] } | null;
      } = { workspace: root, recoveredDenials: [] };

      // Without a same-turn successful planner call the denial stays fatal.
      runner.hostStep = hostResult(`${denied}\n`);
      await expect(runner.turn(session, 'plan', 'x')).rejects.toThrow(
        /same-turn flowguard_plan correction/,
      );

      // With the same-turn proof the correction is pending the persisted gate proof.
      runner.hostStep = hostResult(`${denied}\n${corrected}\n`);
      await runner.turn(session, 'plan-2', 'x');
      expect(session.pendingPlanReviewCorrection).toEqual({ steps: ['plan-2'] });

      // The plan gate refuses an unproven (non-converged) correction...
      runner.turn = async () => ({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: [],
      });
      runner.requireBoundState = () => ({
        state: {
          phase: 'PLAN_REVIEW',
          plan: { reviewCompletion: 'review_exhausted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'changes_requested' },
        },
        sessionDir: root,
      });
      await expect(runner.approve(session, 'approve-plan', 'PLAN_REVIEW')).rejects.toThrow(
        /did not persist a consistent reviewer_accepted/,
      );

      // ...and admits it only after reviewer_accepted with a consistent iteration.
      runner.requireBoundState = () => ({
        state: {
          phase: 'PLAN_REVIEW',
          plan: { reviewCompletion: 'reviewer_accepted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'accept' },
        },
        sessionDir: root,
      });
      await runner.approve(session, 'approve-plan', 'PLAN_REVIEW');
      expect(session.pendingPlanReviewCorrection).toBeNull();
      expect(session.recoveredDenials).toEqual([
        {
          step: 'plan-2',
          codes: ['PLAN_REVIEW_IN_PROGRESS'],
          evidence: 'same_turn_correction_and_reviewer_accepted',
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('supersedes a terminal reviewer block only with a later re-arm and a converged gate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-review-supersede-'));
    try {
      const errorLine = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'task',
          state: {
            output: JSON.stringify({ error: true, code: 'REVIEW_EVIDENCE_NOT_OBSERVED' }),
          },
        },
      });
      const rearmLine = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'task',
          state: {
            output: JSON.stringify({ reviewRetry: { code: 'REVIEW_EVIDENCE_NOT_OBSERVED' } }),
          },
        },
      });
      expect(
        structuredRearmSupersedesTerminal(
          `${errorLine}\n${rearmLine}\n`,
          'REVIEW_EVIDENCE_NOT_OBSERVED',
        ),
      ).toBe(true);
      expect(
        structuredRearmSupersedesTerminal(
          `${rearmLine}\n${errorLine}\n`,
          'REVIEW_EVIDENCE_NOT_OBSERVED',
        ),
      ).toBe(false);
      expect(
        structuredRearmSupersedesTerminal(`${rearmLine}\n`, 'REVIEW_EVIDENCE_NOT_OBSERVED'),
      ).toBe(false);
      expect(
        structuredRearmSupersedesTerminal(`${errorLine}\n`, 'REVIEW_EVIDENCE_NOT_OBSERVED'),
      ).toBe(false);

      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: `${errorLine}\n${rearmLine}\n`,
      });
      const session: {
        workspace: string;
        recoveredDenials: Array<Record<string, unknown>>;
        pendingReviewRecovery?: { steps: string[]; codes: string[] } | null;
      } = { workspace: root, recoveredDenials: [] };
      await runner.turn(session, 'plan', 'x');
      expect(session.pendingReviewRecovery).toEqual({
        steps: ['plan'],
        codes: ['REVIEW_EVIDENCE_NOT_OBSERVED'],
      });

      runner.turn = async () => ({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: [],
      });
      runner.requireBoundState = () => ({
        state: {
          phase: 'PLAN_REVIEW',
          plan: { reviewCompletion: 'review_exhausted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'changes_requested' },
        },
        sessionDir: root,
      });
      await expect(runner.approve(session, 'approve-plan', 'PLAN_REVIEW')).rejects.toThrow(
        /were not proven by a converged review/,
      );

      runner.requireBoundState = () => ({
        state: {
          phase: 'PLAN_REVIEW',
          plan: { reviewCompletion: 'reviewer_accepted' },
          selfReview: { iteration: 3, maxIterations: 3, verdict: 'accept' },
        },
        sessionDir: root,
      });
      await runner.approve(session, 'approve-plan', 'PLAN_REVIEW');
      expect(session.pendingReviewRecovery).toBeNull();
      expect(session.recoveredDenials).toEqual([
        {
          step: 'plan',
          codes: ['REVIEW_EVIDENCE_NOT_OBSERVED'],
          evidence: 'structured_rearm',
        },
        {
          step: 'plan',
          codes: ['REVIEW_EVIDENCE_NOT_OBSERVED'],
          evidence: 'structured_rearm_after_terminal_failure',
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resumes an outstanding implementation review with a bounded, progress-proven retry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-impl-resume-'));
    try {
      await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      const calls: string[] = [];
      const hostResult = () => ({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: [],
      });

      // Already at the evidence gate: no resume at all.
      runner.currentPhase = () => 'EVIDENCE_REVIEW';
      runner.turn = async (_session, label) => {
        calls.push(label);
        return hostResult();
      };
      const atGate: { workspace: string; resumedSteps?: Array<Record<string, unknown>> } = {
        workspace: root,
      };
      await runner.completeImplementationReview(atGate, 'development-05-implement');
      expect(calls).toEqual([]);
      expect(atGate.resumedSteps).toBeUndefined();

      // IMPL_REVIEW with one progressing resume: the gate is reached.
      let phase = 'IMPL_REVIEW';
      let digest = 'd1';
      runner.currentPhase = () => phase;
      runner.currentStateDigest = () => digest;
      runner.turn = async (_session, label) => {
        calls.push(label);
        digest = 'd2';
        phase = 'EVIDENCE_REVIEW';
        return hostResult();
      };
      const resumed: {
        workspace: string;
        resumedSteps?: Array<Record<string, unknown>>;
      } = { workspace: root };
      await runner.completeImplementationReview(resumed, 'development-05-implement');
      expect(calls).toEqual(['development-05-implement-resume-1']);
      expect(resumed.resumedSteps).toEqual([
        { step: 'development-05-implement', attempt: 1, evidence: 'bounded_resume' },
      ]);

      // A resume without persisted state progress stays fail-closed.
      phase = 'IMPL_REVIEW';
      digest = 'd3';
      runner.currentPhase = () => phase;
      runner.currentStateDigest = () => digest;
      runner.turn = async () => hostResult();
      await expect(
        runner.completeImplementationReview({ workspace: root }, 'development-05-implement'),
      ).rejects.toThrow(/no state progress/);

      // Progress on every attempt but never reaching the gate exhausts the bound.
      phase = 'IMPL_REVIEW';
      let digestSequence = 0;
      runner.currentPhase = () => phase;
      runner.currentStateDigest = () => `d${(digestSequence += 1)}`;
      runner.turn = async () => hostResult();
      await expect(
        runner.completeImplementationReview({ workspace: root }, 'development-05-implement'),
      ).rejects.toThrow(/within 2 bounded resume/);

      // A phase that is neither the outstanding review nor the gate is fatal.
      phase = 'PLAN_REVIEW';
      await expect(
        runner.completeImplementationReview({ workspace: root }, 'development-05-implement'),
      ).rejects.toThrow(/expected IMPL_REVIEW or EVIDENCE_REVIEW/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('confirms the exhausted negative contract by refusing a plain architecture approval', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-negative-exhausted-'));
    const calls: Array<{ label: string; options?: { expectedDenial?: string } }> = [];
    try {
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.turn = async (_session, label, _prompt, options = {}) => {
        calls.push({ label, options });
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0, sessionIds: [] };
      };
      runner.approve = async () => {
        throw new Error('a plain approval must never run on the exhausted branch');
      };
      const recoveryDone = () =>
        calls.some((call) => call.label === 'architecture-negative-03-recovery');
      runner.requireBoundState = () => ({
        state: {
          phase: 'ARCH_REVIEW',
          architecture: recoveryDone()
            ? { reviewCompletion: 'review_exhausted', status: 'proposed' }
            : null,
        },
        sessionDir: root,
      });
      const flow = (await runFlows(runner))['architecture-negative'];
      const session: {
        workspace: string;
        negativeOutcome?: string;
        packages?: unknown[];
      } = { workspace: flow.workspace };
      await flow.run(session);
      expect(calls.map((call) => call.label)).toEqual([
        'architecture-negative-02-probe',
        'architecture-negative-03-recovery',
        'architecture-negative-04-approve',
      ]);
      expect(calls[2]!.options?.expectedDenial).toBe('GOVERNANCE_OVERRIDE_REQUIRED');
      expect(session.negativeOutcome).toBe('exhausted_plain_approve_refused');
      expect(session.packages).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('separates a successful reviewer re-arm from a terminal block of the same code', () => {
    const rearm = JSON.stringify({
      type: 'tool_use',
      part: {
        state: {
          output: JSON.stringify({
            status:
              'Reviewer capture failed its evidence contract; a fresh review attempt was re-armed on the same frozen obligation.',
            reviewDispatch: { required: true, completed: false },
            reviewRetry: {
              code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
              obligationId: 'obl_1',
              attemptId: 'attempt_2',
            },
          }),
        },
      },
    });
    const terminal = JSON.stringify({
      type: 'tool_use',
      part: {
        state: {
          output: JSON.stringify({
            error: true,
            code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
            message: 'budget exhausted',
          }),
        },
      },
    });

    expect(captureRetryCodes(rearm)).toEqual(['REVIEW_EVIDENCE_NOT_OBSERVED']);
    expect(unexpectedDenialCodes(rearm)).toEqual([]);
    expect(captureRetryCodes(terminal)).toEqual([]);
    expect(unexpectedDenialCodes(terminal)).toEqual(['REVIEW_EVIDENCE_NOT_OBSERVED']);
  });

  it('opts the installed repository config into raw auditor archives', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-runner-raw-'));
    try {
      await fs.mkdir(path.join(workspace, '.opencode'), { recursive: true });
      const file = path.join(workspace, '.opencode', 'flowguard.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          schemaVersion: 'v1',
          policy: { defaultMode: 'team' },
          archive: { redaction: { allowedModes: ['none'], allowRawExport: false } },
        }),
      );

      enableRawArchiveInRepoConfig(workspace);

      const updated = JSON.parse(await fs.readFile(file, 'utf-8'));
      expect(updated.archive.redaction.allowRawExport).toBe(true);
      expect(updated.archive.redaction.allowedModes).toEqual(['none']);
      expect(updated.policy.defaultMode).toBe('team');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('collects the parent and reviewer-child transcripts for one flow', () => {
    const state = {
      binding: { hostSessionId: 'ses_parent', worktree: REPO_ROOT },
      reviewAssurance: {
        invocations: [
          { childSessionId: 'ses_reviewer_1' },
          { childSessionId: 'ses_reviewer_1' },
          { childSessionId: 'ses_parent' },
        ],
      },
    };
    expect(transcriptTargets(state)).toEqual({
      parent: 'ses_parent',
      reviewers: ['ses_reviewer_1'],
    });
  });

  it('keeps the ticket and runbook explicit about the complete regression fix', async () => {
    const [ticket, readme, demoScript, controllerTest, demoPackage, proofGraphVariants] =
      await Promise.all([
        fs.readFile(TICKET_PATH, 'utf-8'),
        fs.readFile(README_PATH, 'utf-8'),
        fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
        fs.readFile(CONTROLLER_TEST_PATH, 'utf-8'),
        fs.readFile(path.join(DEMO_DIR, 'seed', 'package.json'), 'utf-8'),
        fs.readFile(PROOFGRAPH_VARIANTS_PATH, 'utf-8'),
      ]);

    expect(ticket).toMatch(/remove.*@Disabled/is);
    expect(ticket).toMatch(/jsonPath\("\$\.taskId"\).*non-existent-id/is);
    expect(ticket).toMatch(/(?:replace.*Javadoc|Javadoc.*active regression)/is);
    expect(readme).toContain('assert `$.taskId`, and update its Javadoc');
    expect(readme).toContain('../../run-demo-setup.sh --install');
    expect(readme).toContain('## Live Evidence Checklist');
    expect(readme).toContain('does not call `/start`');
    expect(readme).toContain('- [ ] Reduced-off: `COMPLETE`');
    expect(demoScript).toContain('die `taskId`-Fehlerantwort prüfen');
    expect(demoScript).toContain('../../run-demo-setup.sh --install');
    expect(demoScript).toContain('flowguard_status({ proofGraph: true })');
    expect(demoScript).toContain('contractClaimCount: 2');
    expect(demoScript).toContain('proofGraphGate.gated: false');
    expect(demoPackage).toContain('"build": "./mvnw verify"');
    expect(demoPackage).toContain('"test": "./mvnw test"');
    expect(proofGraphVariants).toContain('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
    expect(proofGraphVariants).toContain('flowguard_record_mutation_evidence');
    expect(proofGraphVariants).toContain('./demos/run-proofgraph-variants.sh');
    expect(readme).toContain('integrityCapability: not_verifiable');
    expect(readme).toContain('verificationStatus: not_run');
    expect(demoScript).toContain('integrityCapability: not_verifiable');
    expect(demoScript).toContain('verificationStatus: not_run');
    expect(readme).toContain('/export redactionMode=none includeRaw=true');

    // The committed seed must remain the reproducible failing baseline, not the fix.
    expect(controllerTest).toContain('@Disabled("Regression: PUT /tasks/{id} returns HTTP 500');
    expect(controllerTest).toContain(
      'To reproduce manually: remove @Disabled and run ./mvnw test.',
    );
    expect(controllerTest).not.toContain('jsonPath("$.taskId").value("non-existent-id")');
  });

  it('keeps the architecture task structurally sound and distinct from a pre-written ADR', async () => {
    const [adrTicket, demoScript] = await Promise.all([
      fs.readFile(ADR_TICKET_PATH, 'utf-8'),
      fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
    ]);

    // ADR_TICKET.md is a task, not a pre-written ADR — no MADR sections as own headings
    expect(adrTicket).not.toMatch(/^## Context\s*$/m);
    expect(adrTicket).not.toMatch(/^## Decision\s*$/m);
    expect(adrTicket).not.toMatch(/^## Consequences\s*$/m);

    // ADR_TICKET.md has task-specific sections
    expect(adrTicket).toContain('## Task Context');
    expect(adrTicket).toContain('## Requested Output');
    expect(adrTicket).toContain('## Constraints');
    expect(adrTicket).toContain('## Acceptance Criteria');
    expect(adrTicket).toContain('## Decision Quality Requirements');

    // The Requested Output section requires MADR sections
    const requestedOutput = extractSection(adrTicket, 'Requested Output');
    expect(requestedOutput).toContain('`## Context`');
    expect(requestedOutput).toContain('`## Decision`');
    expect(requestedOutput).toContain('`## Consequences`');
    expect(requestedOutput).toMatch(/create a MADR-format.+ADR/i);

    // The ADR ticket itself references the concrete symbols
    expect(adrTicket).toContain('`TaskRepository.findById()`');
    expect(adrTicket).toContain('`TaskService.getTask()`');
    expect(adrTicket).toContain('`TaskService.updateTask()`');
    expect(adrTicket).toContain('at least two realistic service-layer options');
    expect(adrTicket).toContain('falsifiable validation path');
    expect(adrTicket).toContain('`TICKET.md`');

    // Referenced symbols exist as methods in the seed code (not just words)
    const [serviceSrc, repoSrc] = await Promise.all([
      fs.readFile(SERVICE_PATH, 'utf-8'),
      fs.readFile(REPO_PATH, 'utf-8'),
    ]);
    expect(serviceSrc).toMatch(/\bgetTask\s*\(/);
    expect(serviceSrc).toMatch(/\bupdateTask\s*\(/);
    expect(repoSrc).toMatch(/\bfindById\s*\(/);

    // Demo script documents the Architecture part structurally
    expect(demoScript).toContain('Part 1');
    expect(demoScript).toContain('/architecture');
    expect(demoScript).toContain('ARCH_COMPLETE');
    expect(demoScript).toContain('ADR_TICKET.md');
    expect(demoScript).toContain('flowguard_status({ reviewFeedback: true })');
  });

  it('keeps the reduced-ceremony A/B scenario bound to the runtime contract', async () => {
    const [reducedDoc, reducedSetup, ticketDocs, demoScript] = await Promise.all([
      fs.readFile(REDUCED_CEREMONY_PATH, 'utf-8'),
      fs.readFile(REDUCED_SETUP_SCRIPT, 'utf-8'),
      fs.readFile(TICKET_DOCS_PATH, 'utf-8'),
      fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
    ]);

    // The docs-only task is deterministic and scoped to the single new file.
    expect(ticketDocs).toContain('docs/usage-notes.md');
    expect(ticketDocs).toContain('./mvnw verify');
    expect(ticketDocs).toContain('./mvnw test');
    expect(ticketDocs).toMatch(/Do not add files other than `docs\/usage-notes\.md`/);

    // The scenario documents both explicit policies, the waiver semantics and
    // the durable audit proof including the real archive member resolution.
    expect(reducedDoc).toContain('policy.allowReducedCeremony: true');
    expect(reducedDoc).toContain('policy.allowReducedCeremony: false');
    expect(reducedDoc).toContain('../../run-demo-setup.sh --install');
    expect(reducedDoc).toContain('reduced_ceremony_applied');
    expect(reducedDoc).toContain('POST_IMPL_VERIFIED_TRIVIAL');
    expect(reducedDoc).toContain('tar -tzf');
    expect(reducedDoc).toContain('audit/audit.jsonl$');
    expect(reducedDoc).toContain('--verify-session');
    // Concrete proofs come from the structured projection, and the archive
    // proof uses the host session id, not the FlowGuard session UUID.
    expect(reducedDoc).toContain('flowguard_status({ evidence: true })');
    expect(reducedDoc).toContain('hostSessionId');
    expect(reducedDoc).toContain('--expect-flow development');
    expect(reducedDoc).toContain('--expect-phase EXPORT_READY');

    // The setup script writes both policies, checks parity and verifies the
    // runtime-selected checks plus the frozen policy snapshot read-only.
    expect(reducedSetup).toContain('--verify-session');
    expect(reducedSetup).toContain('activeChecks');
    expect(reducedSetup).toContain("'HEAD^{tree}'");
    expect(reducedSetup).toContain('allowReducedCeremony');
    expect(reducedSetup).toContain('policySnapshot');
    expect(reducedSetup).toContain('requireHumanGates');
    expect(reducedSetup).toContain('effectiveGateBehavior');
    expect(reducedSetup).toContain('reduced-on');
    expect(reducedSetup).toContain('reduced-off');

    // The main script no longer claims reduced ceremony skips IMPL_VALIDATION.
    expect(demoScript).not.toMatch(/skipping\s+`?IMPL_VALIDATION/i);
    expect(demoScript).toContain('REDUCED_CEREMONY.md');
  });

  it('verifies runtime active checks and the frozen policy from a real session state', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-reduced-preflight-'));
    const workspace = path.join(tempDir, 'reduced-on');
    const configDir = path.join(tempDir, 'config');
    const stateDir = path.join(configDir, 'workspaces', 'fp-test', 'sessions', 'sid-test');
    const statePath = path.join(stateDir, 'session-state.json');
    const legacyStatePath = path.join(stateDir, 'state', 'session-state.json');
    const runVerify = (target = workspace) =>
      execFile('bash', [REDUCED_SETUP_SCRIPT, '--verify-session', target], {
        cwd: REPO_ROOT,
        env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      });
    const teamPolicy = {
      mode: 'team',
      requireHumanGates: true,
      effectiveGateBehavior: 'human_gated',
      allowReducedCeremony: true,
    };
    const writeState = (overrides: Record<string, unknown>) =>
      fs.writeFile(
        statePath,
        JSON.stringify({
          binding: { worktree: workspace },
          activeChecks: ['test', 'build'],
          policySnapshot: teamPolicy,
          ...overrides,
        }),
        'utf-8',
      );

    try {
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(path.dirname(legacyStatePath), { recursive: true });
      await fs.writeFile(
        legacyStatePath,
        JSON.stringify({
          binding: { worktree: workspace },
          activeChecks: ['test', 'build'],
          policySnapshot: teamPolicy,
        }),
        'utf-8',
      );
      // Archived-state layouts are not valid live-session state locations.
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
      await fs.mkdir(stateDir, { recursive: true });

      await writeState({});
      const { stdout } = await runVerify();
      expect(stdout).toContain('hostSessionId: sid-test');
      expect(stdout).toContain('activeChecks: [build, test]');
      expect(stdout).toContain(
        'policySnapshot: mode=team requireHumanGates=true effectiveGateBehavior=human_gated allowReducedCeremony=true',
      );
      expect(stdout).toContain('PASS  activeChecks selected as build + test');
      expect(stdout).toContain('PASS  frozen team policy matches the workspace');

      // Every non-matching dimension must fail closed.
      await writeState({ activeChecks: ['build'] });
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
      await writeState({ policySnapshot: { ...teamPolicy, allowReducedCeremony: false } });
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
      await writeState({ policySnapshot: { ...teamPolicy, mode: 'solo' } });
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
      await writeState({ policySnapshot: { ...teamPolicy, requireHumanGates: false } });
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
      await writeState({
        policySnapshot: { ...teamPolicy, effectiveGateBehavior: 'auto_approve' },
      });
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });

      // An unknown workspace name cannot derive the expected policy.
      const unknownWorkspace = path.join(tempDir, 'reduced-other');
      await fs.mkdir(unknownWorkspace, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({
          binding: { worktree: unknownWorkspace },
          activeChecks: ['test', 'build'],
          policySnapshot: teamPolicy,
        }),
        'utf-8',
      );
      await expect(runVerify(unknownWorkspace)).rejects.toMatchObject({ code: 1 });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('materializes the documented seed including architecture task and review fixture branches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-java-demo-contract-'));
    const targetDir = path.join(tempDir, 'workspace');

    try {
      await execFile('bash', [SETUP_SCRIPT, '--prepare-only', targetDir], { cwd: REPO_ROOT });

      const [
        { stdout: branch },
        { stdout: changedPaths },
        materializedTicket,
        materializedControllerTest,
      ] = await Promise.all([
        execFile('git', ['branch', '--show-current'], { cwd: targetDir }),
        execFile('git', ['diff', '--name-only', 'main...feature/add-due-date'], {
          cwd: targetDir,
        }),
        fs.readFile(path.join(targetDir, 'TICKET.md'), 'utf-8'),
        fs.readFile(
          path.join(
            targetDir,
            'src',
            'test',
            'java',
            'com',
            'example',
            'taskmanager',
            'controller',
            'TaskControllerTest.java',
          ),
          'utf-8',
        ),
      ]);

      expect(branch.trim()).toBe('main');
      expect(changedPaths).toContain('src/main/java/com/example/taskmanager/model/Task.java');
      expect(changedPaths).toContain(
        'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java',
      );
      expect(materializedTicket).toMatch(/remove.*@Disabled/is);
      expect(materializedTicket).toMatch(/jsonPath\("\$\.taskId"\).*non-existent-id/is);
      expect(materializedTicket).toMatch(/(?:replace.*Javadoc|Javadoc.*active regression)/is);
      expect(materializedControllerTest).toContain(
        '@Disabled("Regression: PUT /tasks/{id} returns HTTP 500',
      );

      // Architecture task is materialized into the workspace
      const materializedAdrTicket = await fs.readFile(
        path.join(targetDir, 'ADR_TICKET.md'),
        'utf-8',
      );
      expect(materializedAdrTicket).toContain('## Task Context');
      expect(materializedAdrTicket).toContain('## Requested Output');
      expect(materializedAdrTicket).toContain('`## Context`');
      expect(materializedAdrTicket).toContain('`## Decision`');
      expect(materializedAdrTicket).toContain('`## Consequences`');

      // The reduced-ceremony docs task is materialized with the seed.
      const materializedDocsTicket = await fs.readFile(
        path.join(targetDir, 'TICKET_DOCS.md'),
        'utf-8',
      );
      expect(materializedDocsTicket).toContain('docs/usage-notes.md');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('orchestrates all installable live demos into a fresh root', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-all-demos-contract-'));
    const targetRoot = path.join(tempDir, 'demos');
    const mainWorkspace = path.join(targetRoot, 'java-task-manager');
    const reducedOn = path.join(targetRoot, 'reduced-ceremony', 'reduced-on');
    const reducedOff = path.join(targetRoot, 'reduced-ceremony', 'reduced-off');

    try {
      const scriptStat = await fs.stat(ROOT_SETUP_SCRIPT);
      expect(scriptStat.mode & fs.constants.S_IXUSR).not.toBe(0);
      await expect(fs.stat(path.join(DEMO_DIR, 'run-demo-setup.sh'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const { stdout: setupOutput } = await execFile(
        'bash',
        [ROOT_SETUP_SCRIPT, '--prepare-only', targetRoot],
        { cwd: REPO_ROOT },
      );
      expect(setupOutput).toContain(
        'No FlowGuard session has been started and no demo flow has run.',
      );

      const [{ stdout: branch }, onConfig, offConfig] = await Promise.all([
        execFile('git', ['branch', '--show-current'], { cwd: mainWorkspace }),
        fs.readFile(path.join(reducedOn, '.opencode', 'flowguard.json'), 'utf-8'),
        fs.readFile(path.join(reducedOff, '.opencode', 'flowguard.json'), 'utf-8'),
      ]);

      expect(branch.trim()).toBe('main');
      expect(JSON.parse(onConfig)).toMatchObject({
        policy: { defaultMode: 'team', allowReducedCeremony: true },
      });
      expect(JSON.parse(offConfig)).toMatchObject({
        policy: { defaultMode: 'team', allowReducedCeremony: false },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('selects only the requested installable live demo', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-demo-selector-contract-'));
    const mainRoot = path.join(tempDir, 'main');
    const reducedRoot = path.join(tempDir, 'reduced');

    try {
      await execFile('bash', [ROOT_SETUP_SCRIPT, '--demo', 'main', mainRoot], { cwd: REPO_ROOT });
      await expect(fs.stat(path.join(mainRoot, 'java-task-manager'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(mainRoot, 'reduced-ceremony'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await execFile('bash', [ROOT_SETUP_SCRIPT, '--demo', 'reduced', reducedRoot], {
        cwd: REPO_ROOT,
      });
      await expect(
        fs.stat(path.join(reducedRoot, 'reduced-ceremony', 'reduced-on')),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(reducedRoot, 'reduced-ceremony', 'reduced-off')),
      ).resolves.toBeDefined();
      await expect(fs.stat(path.join(reducedRoot, 'java-task-manager'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects incomplete and invalid root setup arguments', async () => {
    await expect(execFile('bash', [ROOT_SETUP_SCRIPT], { cwd: REPO_ROOT })).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      execFile('bash', [ROOT_SETUP_SCRIPT, '--install', '/tmp/flowguard-demos'], {
        cwd: REPO_ROOT,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFile('bash', [ROOT_SETUP_SCRIPT, '--demo', 'proofgraph', '/tmp/flowguard-demos'], {
        cwd: REPO_ROOT,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFile(
        'bash',
        [
          ROOT_SETUP_SCRIPT,
          '--prepare-only',
          '--install',
          '--tarball',
          '/dev/null',
          '/tmp/flowguard-demos',
        ],
        { cwd: REPO_ROOT },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFile(
        'bash',
        [
          ROOT_SETUP_SCRIPT,
          '--install',
          '--prepare-only',
          '--tarball',
          '/dev/null',
          '/tmp/flowguard-demos',
        ],
        { cwd: REPO_ROOT },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFile(
        'bash',
        [ROOT_SETUP_SCRIPT, '--prepare-only', '--tarball', '/dev/null', '/tmp/flowguard-demos'],
        {
          cwd: REPO_ROOT,
        },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});
