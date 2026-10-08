/**
 * @module hooks/shared/stdin-reader.test
 * @description Tests for stdin-reader — stream reading, JSON parsing, and hook payload validation.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  StdinReadError,
  readStdin,
  validateToolHookPayload,
  validateSessionPayload,
} from './stdin-reader.js';
import { MAX_HOOK_PAYLOAD_BYTES } from './limits.js';

function streamFromString(content: string): Readable {
  const readable = new Readable({ read() {} });
  readable.push(content);
  readable.push(null);
  return readable;
}

function emptyStream(): Readable {
  const readable = new Readable({ read() {} });
  readable.push(null);
  return readable;
}

function streamFromChunks(chunks: readonly string[]): Readable {
  const readable = new Readable({ read() {} });
  for (const chunk of chunks) readable.push(chunk);
  readable.push(null);
  return readable;
}

function objectModeStreamFromChunks(chunks: readonly string[]): Readable {
  const readable = new Readable({ objectMode: true, read() {} });
  for (const chunk of chunks) readable.push(chunk);
  readable.push(null);
  return readable;
}

function jsonObjectWithByteLength(byteLength: number): string {
  const prefix = '{"data":"';
  const suffix = '"}';
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  if (byteLength < overhead) throw new RangeError('byteLength too small for JSON object');
  return `${prefix}${'x'.repeat(byteLength - overhead)}${suffix}`;
}

function jsonObjectWithMultibyteByteLength(byteLength: number): string {
  const prefix = '{"data":"';
  const suffix = '"}';
  const remaining = byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (remaining < 0) throw new RangeError('byteLength too small for JSON object');
  const accentedCount = Math.floor(remaining / Buffer.byteLength('é'));
  const asciiCount = remaining - accentedCount * Buffer.byteLength('é');
  return `${prefix}${'é'.repeat(accentedCount)}${'a'.repeat(asciiCount)}${suffix}`;
}

// ─── readStdin ────────────────────────────────────────────────────────────────

describe('readStdin', () => {
  it('parses valid JSON object from stream', async () => {
    const result = await readStdin(streamFromString('{"tool_name":"Bash"}'));
    expect(result).toEqual({ tool_name: 'Bash' });
  });

  it('trims whitespace around JSON', async () => {
    const result = await readStdin(streamFromString('  \n {"key":"val"} \t '));
    expect(result).toEqual({ key: 'val' });
  });

  it('handles multi-chunk delivery', async () => {
    const stream = streamFromChunks(['{"first', '":"val', 'ue"}']);
    const result = await readStdin(stream);
    expect(result).toEqual({ first: 'value' });
  });

  it('accepts a payload exactly at the shared byte cap', async () => {
    const payload = jsonObjectWithByteLength(MAX_HOOK_PAYLOAD_BYTES);
    expect(Buffer.byteLength(payload)).toBe(MAX_HOOK_PAYLOAD_BYTES);

    const result = await readStdin(streamFromString(payload));

    expect(typeof result['data']).toBe('string');
  });

  it('throws STDIN_TOO_LARGE at cap + 1 before JSON parsing', async () => {
    const payload = jsonObjectWithByteLength(MAX_HOOK_PAYLOAD_BYTES + 1);

    await expect(readStdin(streamFromString(payload))).rejects.toMatchObject({
      code: 'STDIN_TOO_LARGE',
    });
  });

  it('exposes the observed bytes and prefix on STDIN_TOO_LARGE (D2)', async () => {
    const observed = 'x'.repeat(MAX_HOOK_PAYLOAD_BYTES + 1);

    let error: StdinReadError | undefined;
    try {
      await readStdin(streamFromString(observed));
    } catch (err) {
      error = err as StdinReadError;
    }

    expect(error).toBeInstanceOf(StdinReadError);
    expect(error?.code).toBe('STDIN_TOO_LARGE');
    // The observed prefix is exactly the bytes the reader actually saw; the
    // digest/null scope is derived by the ledger, never here.
    expect(error?.observedBytes).toBe(MAX_HOOK_PAYLOAD_BYTES + 1);
    expect(error?.observedPrefix).toBe(observed);
  });

  it('exposes observed bytes and prefix on malformed JSON (D2)', async () => {
    let error: StdinReadError | undefined;
    try {
      await readStdin(streamFromString('{not-json}'));
    } catch (err) {
      error = err as StdinReadError;
    }

    expect(error?.code).toBe('STDIN_INVALID_JSON');
    expect(error?.observedBytes).toBe(Buffer.byteLength('{not-json}'));
    expect(error?.observedPrefix).toBe('{not-json}');
  });

  it('enforces the byte cap across multiple chunks', async () => {
    const stream = streamFromChunks(['x'.repeat(MAX_HOOK_PAYLOAD_BYTES - 1), 'x', 'x']);

    await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_TOO_LARGE' });
  });

  it('accepts a multibyte payload exactly at the shared byte cap', async () => {
    const payload = jsonObjectWithMultibyteByteLength(MAX_HOOK_PAYLOAD_BYTES);
    expect(Buffer.byteLength(payload)).toBe(MAX_HOOK_PAYLOAD_BYTES);
    expect(payload.length).toBeLessThan(MAX_HOOK_PAYLOAD_BYTES);

    const result = await readStdin(objectModeStreamFromChunks([payload]));

    expect(typeof result['data']).toBe('string');
  });

  it('counts UTF-8 bytes, not code units, on multibyte string chunks', async () => {
    const payload = jsonObjectWithMultibyteByteLength(MAX_HOOK_PAYLOAD_BYTES + 1);
    expect(Buffer.byteLength(payload)).toBe(MAX_HOOK_PAYLOAD_BYTES + 1);
    expect(payload.length).toBeLessThan(MAX_HOOK_PAYLOAD_BYTES);

    const half = Math.floor(payload.length / 2);
    const stream = objectModeStreamFromChunks([payload.slice(0, half), payload.slice(half)]);

    await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_TOO_LARGE' });
  });

  it('destroys the stream when the byte cap is exceeded', async () => {
    const stream = streamFromChunks(['x'.repeat(MAX_HOOK_PAYLOAD_BYTES), 'x']);

    await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_TOO_LARGE' });
    expect(stream.destroyed).toBe(true);
  });

  it('throws STDIN_EMPTY when stream is empty', async () => {
    await expect(readStdin(emptyStream())).rejects.toThrow(StdinReadError);
    try {
      await readStdin(emptyStream());
    } catch (e) {
      expect(e).toBeInstanceOf(StdinReadError);
      expect((e as StdinReadError).code).toBe('STDIN_EMPTY');
    }
  });

  it('throws STDIN_EMPTY when stream is whitespace only', async () => {
    await expect(readStdin(streamFromString('   \n \t '))).rejects.toThrow(StdinReadError);
    try {
      await readStdin(streamFromString('   \n \t '));
    } catch (e) {
      expect((e as StdinReadError).code).toBe('STDIN_EMPTY');
    }
  });

  it('throws STDIN_INVALID_JSON for invalid JSON', async () => {
    await expect(readStdin(streamFromString('not json'))).rejects.toThrow(StdinReadError);
    try {
      await readStdin(streamFromString('not json'));
    } catch (e) {
      expect((e as StdinReadError).code).toBe('STDIN_INVALID_JSON');
    }
  });

  it('throws STDIN_NOT_OBJECT for JSON array', async () => {
    await expect(readStdin(streamFromString('[1,2,3]'))).rejects.toThrow(StdinReadError);
    try {
      await readStdin(streamFromString('[1,2,3]'));
    } catch (e) {
      expect((e as StdinReadError).code).toBe('STDIN_NOT_OBJECT');
    }
  });

  it('throws STDIN_NOT_OBJECT for JSON null', async () => {
    await expect(readStdin(streamFromString('null'))).rejects.toThrow(StdinReadError);
    try {
      await readStdin(streamFromString('null'));
    } catch (e) {
      expect((e as StdinReadError).code).toBe('STDIN_NOT_OBJECT');
    }
  });

  it('throws STDIN_NOT_OBJECT for JSON string', async () => {
    await expect(readStdin(streamFromString('"a string"'))).rejects.toThrow(StdinReadError);
    try {
      await readStdin(streamFromString('"a string"'));
    } catch (e) {
      expect((e as StdinReadError).code).toBe('STDIN_NOT_OBJECT');
    }
  });
});

// ─── validateToolHookPayload ──────────────────────────────────────────────────

describe('validateToolHookPayload', () => {
  it('validates a minimal valid payload', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      tool_input: { cmd: 'ls' },
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_name).toBe('Bash');
    expect(result.tool_input).toEqual({ cmd: 'ls' });
    expect(result.session_id).toBe('sess-1');
    expect(result.cwd).toBe('/home');
  });

  it('defaults tool_input to empty object when missing', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_input).toEqual({});
  });

  it('defaults tool_input to empty object when it is an array', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      tool_input: [1, 2, 3] as unknown,
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_input).toEqual({});
  });

  it('defaults tool_input to empty object when it is null', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      tool_input: null,
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_input).toEqual({});
  });

  it('throws when tool_name is missing', () => {
    expect(() =>
      validateToolHookPayload({
        session_id: 'sess-1',
        cwd: '/home',
      }),
    ).toThrow(StdinReadError);
  });

  it('throws when tool_name is empty', () => {
    expect(() =>
      validateToolHookPayload({
        tool_name: '',
        session_id: 'sess-1',
        cwd: '/home',
      }),
    ).toThrow(StdinReadError);
  });

  it('throws when session_id is missing', () => {
    expect(() =>
      validateToolHookPayload({
        tool_name: 'Bash',
        cwd: '/home',
      }),
    ).toThrow(StdinReadError);
  });

  it('throws when cwd is missing', () => {
    expect(() =>
      validateToolHookPayload({
        tool_name: 'Bash',
        session_id: 'sess-1',
      }),
    ).toThrow(StdinReadError);
  });

  it('collects multiple validation errors', () => {
    try {
      validateToolHookPayload({});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StdinReadError);
      expect((e as StdinReadError).code).toBe('STDIN_VALIDATION_FAILED');
      expect((e as StdinReadError).message).toContain('tool_name');
      expect((e as StdinReadError).message).toContain('session_id');
      expect((e as StdinReadError).message).toContain('cwd');
    }
  });

  it('includes optional agent_id when present', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-xyz',
    });
    expect(result.agent_id).toBe('agent-xyz');
  });

  it('omits agent_id when empty string', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: '',
    });
    expect(result.agent_id).toBeUndefined();
  });

  it('includes optional agent_type when present', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
      agent_type: 'flowguard-reviewer',
    });
    expect(result.agent_type).toBe('flowguard-reviewer');
  });

  it('omits agent_type when empty string', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
      agent_type: '',
    });
    expect(result.agent_type).toBeUndefined();
  });

  it('includes optional tool_response when present', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
      tool_response: { output: 'ok' },
    });
    expect(result.tool_response).toEqual({ output: 'ok' });
  });

  it('omits tool_response when undefined', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_response).toBeUndefined();
  });
});

// ─── validateSessionPayload ───────────────────────────────────────────────────

describe('validateSessionPayload', () => {
  it('validates a minimal valid session payload', () => {
    const result = validateSessionPayload({
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.session_id).toBe('sess-1');
    expect(result.cwd).toBe('/home');
  });

  it('throws when session_id is missing', () => {
    expect(() => validateSessionPayload({ cwd: '/home' })).toThrow(StdinReadError);
  });

  it('throws when cwd is missing', () => {
    expect(() => validateSessionPayload({ session_id: 'sess-1' })).toThrow(StdinReadError);
  });

  it('throws when session_id is empty string', () => {
    expect(() => validateSessionPayload({ session_id: '', cwd: '/home' })).toThrow(StdinReadError);
  });

  it('throws when cwd is empty string', () => {
    expect(() => validateSessionPayload({ session_id: 'sess-1', cwd: '' })).toThrow(StdinReadError);
  });
});
