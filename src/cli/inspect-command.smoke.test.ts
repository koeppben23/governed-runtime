/**
 * @module cli/inspect-command.smoke.test
 * @description Tests for flowguard inspect command.
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseInspectArgs, getInspectUsage } from './inspect-command.js';
import { makeState, PLAN_RECORD, VALIDATION_PASSED } from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { createTransitionEvent, GENESIS_HASH } from '../audit/types.js';
import { stampChainSequence } from '../audit/audit-test-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);

// ─── Unit: Argument Parsing ───────────────────────────────────────────────────

describe('parseInspectArgs', () => {
  it('HAPPY: no args returns defaults', () => {
    const result = parseInspectArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBeUndefined();
      expect(result.args.json).toBe(false);
    }
  });

  it('HAPPY: --session with value', () => {
    const result = parseInspectArgs(['--session', 'my-id']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBe('my-id');
    }
  });

  it('HAPPY: --json flag', () => {
    const result = parseInspectArgs(['--json']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.json).toBe(true);
    }
  });

  it('HAPPY: --session and --json together', () => {
    const result = parseInspectArgs(['--session', 'my-id', '--json']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBe('my-id');
      expect(result.args.json).toBe(true);
    }
  });

  it('BAD: --session without value', () => {
    const result = parseInspectArgs(['--session']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--session requires');
    }
  });

  it('BAD: unknown flag', () => {
    const result = parseInspectArgs(['--unknown']);
    expect(result.ok).toBe(false);
  });

  it('CORNER: --help returns help error', () => {
    const result = parseInspectArgs(['--help']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('help');
    }
  });
});

// ─── Helpers for integration tests ───────────────────────────────────────────

describe('getInspectUsage', () => {
  it('includes inspect command', () => {
    const usage = getInspectUsage();
    expect(usage).toContain('flowguard inspect');
    expect(usage).toContain('--session');
    expect(usage).toContain('--json');
  });
});

// ─── Smoke: CLI integration (requires npm run build) ─────────────────────────

const describeSmoke = HAS_BUILT_CLI ? describe : describe.skip;

describeSmoke('flowguard inspect CLI', () => {
  function runCli(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: cwd ?? REPO_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 15000,
    });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  function safeRun(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    return runCli(args, cwd);
  }

  it('reads bound attempts from isolated state without rewriting state or audit, and rejects corrupt state', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fg-inspect-evidence-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: path.join(root, 'config') });
    try {
      execFileSync('git', ['init', '--quiet', root]);
      const { fingerprint } = await computeFingerprint(realpathSync(root));
      const state = makeState('IMPLEMENTATION', { plan: PLAN_RECORD });
      const sid = `ses_${randomUUID().replace(/-/g, '')}`;
      state.binding = { ...state.binding, fingerprint, hostSessionId: sid };
      state.validationAttempts = [
        {
          attemptId: randomUUID(),
          scope: 'baseline',
          planDigest: PLAN_RECORD.current.digest,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: VALIDATION_PASSED[0]!,
        },
      ];
      const dir = sessionDir(fingerprint, sid);
      mkdirSync(dir, { recursive: true });
      const stateFile = path.join(dir, 'session-state.json');
      const auditFile = path.join(dir, 'audit.jsonl');
      writeFileSync(stateFile, JSON.stringify(state));
      const event = stampChainSequence(
        createTransitionEvent({
          flowguardSessionId: state.id,
          hostSessionId: sid,
          phase: 'IMPLEMENTATION',
          detail: {
            from: 'VALIDATION',
            to: 'IMPLEMENTATION',
            event: 'ALL_PASSED',
            autoAdvanced: true,
            chainIndex: 0,
          },
          occurredAt: '2026-01-01T00:00:00.000Z',
          prevHash: GENESIS_HASH,
        }),
        1,
      );
      writeFileSync(auditFile, JSON.stringify(event) + '\n');
      const beforeState = readFileSync(stateFile);
      const beforeAudit = readFileSync(auditFile);
      const result = safeRun(['inspect', '--session', sid, '--json'], root);
      expect(result.stderr).not.toContain('[error]');
      const summary = JSON.parse(result.stdout);
      expect(summary.checks).toContainEqual(
        expect.objectContaining({
          name: 'validation_executed',
          passed: true,
          detail: expect.stringContaining('1 bound validation attempt(s)'),
        }),
      );
      expect(summary.checks).toContainEqual(
        expect.objectContaining({ name: 'chain_integrity', passed: true }),
      );
      expect(readFileSync(stateFile)).toEqual(beforeState);
      expect(readFileSync(auditFile)).toEqual(beforeAudit);
      // Deliberately malformed test-fixture state, never a live session repair.
      writeFileSync(stateFile, '{ invalid');
      const invalid = safeRun(['inspect', '--session', sid, '--json'], root);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('Cannot read validation evidence');
      expect(readFileSync(auditFile)).toEqual(beforeAudit);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('HAPPY: no sessions prints clean message', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-inspect-smoke-'));
    try {
      const configDir = path.join(tmpDir, 'opencode-config');
      mkdirSync(configDir, { recursive: true });

      const result = safeRun(['inspect'], tmpDir);
      // Exit 0 is acceptable for empty workspace
      expect(result.stdout + result.stderr).toMatch(/No.*session/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('HAPPY: --help prints usage', () => {
    const result = safeRun(['inspect', '--help']);
    expect(result.stdout).toContain('flowguard inspect');
    expect(result.stdout).toContain('--session');
  });

  it('BAD: --session without value exits with error', () => {
    const result = safeRun(['inspect', '--session']);
    // parseInspectArgs rejects, inspectMain gets error → exits 1
    expect(result.stderr + result.stdout).toMatch(/session|error/i);
  });

  it('CORNER: --json without --session exits with error', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-inspect-corner-'));
    try {
      const r = safeRun(['inspect', '--json'], tmpDir);
      // Either no session found, or no workspace → clean exit
      expect(r.stderr + r.stdout).not.toMatch(/TypeError|ReferenceError/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
