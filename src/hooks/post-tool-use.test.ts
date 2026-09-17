/**
 * @module hooks/post-tool-use.test
 * @description Contract tests for the informational PostToolUse hook: audit
 *              persistence, input sanitization, fail-safe error handling and
 *              obligation escalation. The hook is never blocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readStdin: vi.fn(),
  resolveSession: vi.fn(),
  appendAuditEvent: vi.fn(async () => undefined),
  installHookStdoutGuard: vi.fn(() => ({ restore: vi.fn() })),
  assessObligationEscalation: vi.fn(() => ({ message: undefined as string | undefined })),
}));

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return { ...actual, readStdin: (...args: unknown[]) => mocks.readStdin(...args) };
});

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mocks.resolveSession(...args),
}));

vi.mock('../adapters/persistence-audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/persistence-audit.js')>();
  return { ...actual, appendAuditEvent: (...args: unknown[]) => mocks.appendAuditEvent(...args) };
});

vi.mock('./shared/stdout-guard.js', () => ({
  installHookStdoutGuard: mocks.installHookStdoutGuard,
}));

vi.mock('./shared/obligation-tracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/obligation-tracker.js')>();
  return { ...actual, assessObligationEscalation: mocks.assessObligationEscalation };
});

const originalStderrWrite = process.stderr.write;

interface RunOptions {
  readonly payload?: unknown;
  readonly session?: unknown;
  readonly stdinFails?: boolean;
  readonly auditFails?: boolean;
}

async function runHook(options: RunOptions = {}): Promise<string> {
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stderr.write);

  const payload = options.payload ?? {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 'sess-1',
    cwd: '/tmp/project',
  };

  if (options.stdinFails === true) {
    mocks.readStdin.mockRejectedValue(new Error('stdin broken'));
  } else {
    mocks.readStdin.mockResolvedValue(payload);
  }
  mocks.resolveSession.mockResolvedValue(
    options.session ?? {
      ok: true,
      sessionDir: '/sessions/s1',
      state: { flowguardSessionId: 'fg-1', phase: 'IMPLEMENTATION' },
    },
  );
  if (options.auditFails === true) {
    mocks.appendAuditEvent.mockRejectedValueOnce(new Error('disk full'));
  }

  await import('./post-tool-use.js');
  await vi.waitFor(() => expect(stderr.trim()).not.toBe(''));
  return stderr;
}

describe('post-tool-use hook', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.installHookStdoutGuard.mockReturnValue({ restore: vi.fn() });
    mocks.assessObligationEscalation.mockReturnValue({ message: undefined });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('persists a tool_call audit event bound to the resolved session', async () => {
    const stderr = await runHook();

    expect(mocks.appendAuditEvent).toHaveBeenCalledTimes(1);
    const [sessionDir, event] = mocks.appendAuditEvent.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(sessionDir).toBe('/sessions/s1');
    expect(event).toMatchObject({
      flowguardSessionId: 'fg-1',
      hostSessionId: 'sess-1',
      phase: 'IMPLEMENTATION',
      event: 'tool_call',
      actor: 'machine',
      enforcementLevel: 'hook_gated',
    });
    expect(event['detail']).toMatchObject({
      tool: 'Bash',
      hookSource: 'command_hook',
    });
    expect(typeof (event['detail'] as Record<string, unknown>)['platform']).toBe('string');
    expect(stderr).toContain('audit persisted: Bash (sess-1)');
  });

  it('truncates oversized string inputs before persistence', async () => {
    await runHook({
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'x'.repeat(700), short: 'ok', count: 3 },
        session_id: 'sess-1',
        cwd: '/tmp/project',
      },
    });

    const event = mocks.appendAuditEvent.mock.calls[0]![1] as {
      detail: { input: Record<string, unknown> };
    };
    const truncated = event.detail.input['command'] as string;
    expect(truncated.startsWith('x'.repeat(500))).toBe(true);
    expect(truncated).toContain('[truncated, 700 chars]');
    expect(event.detail.input['short']).toBe('ok');
    expect(event.detail.input['count']).toBe(3);
  });

  it('installs and restores the stdout guard around the hook logic', async () => {
    const restore = vi.fn();
    mocks.installHookStdoutGuard.mockReturnValue({ restore });

    await runHook();

    expect(mocks.installHookStdoutGuard).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('stays non-blocking when stdin cannot be read', async () => {
    const stderr = await runHook({ stdinFails: true });

    expect(stderr).toContain('stdin read failed: stdin broken');
    expect(mocks.appendAuditEvent).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('stays non-blocking when payload validation fails', async () => {
    const stderr = await runHook({
      payload: { tool_input: { command: 'x' }, session_id: 's', cwd: '/tmp' },
    });

    expect(stderr).toContain('validation failed:');
    expect(mocks.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('warns and skips persistence for an unresolved session', async () => {
    const stderr = await runHook({
      session: { ok: false, code: 'SESSION_NOT_FOUND', reason: 'unknown session' },
    });

    expect(stderr).toContain('WARN: cannot persist audit (SESSION_NOT_FOUND): unknown session');
    expect(mocks.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('logs an audit write failure without failing the hook', async () => {
    const stderr = await runHook({ auditFails: true });

    expect(stderr).toContain('WARN: audit write failed: disk full');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('emits the pending obligation escalation message when present', async () => {
    mocks.assessObligationEscalation.mockReturnValue({
      message: 'ESCALATION: 2 obligations pending',
    });

    const stderr = await runHook();

    expect(stderr).toContain('ESCALATION: 2 obligations pending');
    expect(mocks.assessObligationEscalation).toHaveBeenCalledWith(expect.anything(), true);
  });
});
