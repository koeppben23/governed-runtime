/** @module hooks/pre-tool-use.test */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadStdin = vi.hoisted(() => vi.fn());
const mockResolveSession = vi.hoisted(() => vi.fn());

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return { ...actual, readStdin: (...args: unknown[]) => mockReadStdin(...args) };
});

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

async function runPreToolUse(payload: Record<string, unknown>): Promise<string> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk, encodingOrCallback, callback) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) done(null);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockReadStdin.mockResolvedValue(payload);

  await import('./pre-tool-use.js');
  await vi.waitFor(() => expect(stdout.trim()).not.toBe(''));
  return stdout;
}

describe('pre-tool-use review obligation enforcement', () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 'sess_test',
    cwd: '/tmp/project',
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('denies a mutating tool when a review obligation is unresolved', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test',
      state: {
        phase: 'IMPLEMENTATION',
        reviewAssurance: {
          obligations: [
            { obligationId: 'b-obligation', status: 'pending', consumedAt: null },
            { obligationId: 'a-obligation', status: 'pending', consumedAt: null },
          ],
        },
      },
    });

    const stdout = await runPreToolUse(payload);
    const output = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };

    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'REVIEW_OBLIGATION_UNRESOLVED',
    );
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'a-obligation, b-obligation',
    );
  });

  it('allows non-mutating tools without resolving session state', async () => {
    mockReadStdin.mockResolvedValue({ ...payload, tool_name: 'Read' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await import('./pre-tool-use.js');
    await vi.waitFor(() => expect(mockReadStdin).toHaveBeenCalled());

    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it('allows a mutating tool when all obligations are consumed', async () => {
    mockResolveSession.mockResolvedValue({
      ok: true,
      sessionDir: '/sessions/sess_test',
      state: {
        phase: 'IMPLEMENTATION',
        reviewAssurance: {
          obligations: [
            { obligationId: 'done', status: 'consumed', consumedAt: '2026-07-15T00:00:00.000Z' },
          ],
        },
      },
    });

    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockReadStdin.mockResolvedValue(payload);
    await import('./pre-tool-use.js');
    await vi.waitFor(() => expect(mockResolveSession).toHaveBeenCalled());

    expect(stdout).toBe('');
  });
});
