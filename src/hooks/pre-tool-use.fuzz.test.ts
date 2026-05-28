/**
 * @module hooks/pre-tool-use.fuzz.test
 * @description Property-based fail-closed checks for pre-tool-use stdout delivery.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/354
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

const mockReadStdin = vi.hoisted(() => vi.fn());
const mockResolveSession = vi.hoisted(() => vi.fn());

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return {
    ...actual,
    readStdin: (...args: unknown[]) => mockReadStdin(...args),
  };
});

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

async function runPreToolUse(payload: unknown): Promise<string> {
  let stdout = '';
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  vi.restoreAllMocks();

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk, encodingOrCallback, callback) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) cb(null);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  mockReadStdin.mockResolvedValue(payload);
  mockResolveSession.mockRejectedValue(new TypeError('fuzz injected fatal'));

  try {
    await import('./pre-tool-use.js');
    await vi.waitFor(() => {
      expect(stdout.trim()).not.toBe('');
    });
    return stdout;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
  }
}

describe('pre-tool-use fail-closed fuzz', () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadStdin.mockReset();
    mockResolveSession.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('mutating or invalid payloads never produce silent ALLOW', async () => {
    const invalidPayload = fc.oneof(
      fc.constant(null),
      fc.constant([]),
      fc.constant({}),
      fc.record({ tool_name: fc.constant(''), session_id: fc.string(), cwd: fc.string() }),
      fc.record({ tool_name: fc.string(), session_id: fc.constant(''), cwd: fc.string() }),
      fc.record({ tool_name: fc.string(), session_id: fc.string(), cwd: fc.constant('') }),
    );
    const mutatingPayload = fc.record({
      tool_name: fc.constantFrom('Bash', 'Write', 'Edit', 'apply_patch'),
      tool_input: fc.dictionary(fc.string(), fc.anything()),
      session_id: fc.string({ minLength: 1 }),
      cwd: fc.string({ minLength: 1 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.oneof(invalidPayload, mutatingPayload), async (payload) => {
        vi.resetModules();
        const stdout = await runPreToolUse(payload);
        const parsed = JSON.parse(stdout.trim()) as {
          hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
        };
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(
          /HOOK_PAYLOAD_INVALID|HOOK_FATAL_ERROR/,
        );
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 25,
        seed: Number(process.env.FAST_CHECK_SEED ?? '354'),
        endOnFailure: true,
      },
    );
  });
});
