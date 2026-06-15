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
  validateSubagentStopPayload,
} from './stdin-reader.js';

function streamFromString(content: string): NodeJS.ReadableStream {
  const readable = new Readable({ read() {} });
  readable.push(content);
  readable.push(null);
  return readable;
}

function emptyStream(): NodeJS.ReadableStream {
  const readable = new Readable({ read() {} });
  readable.push(null);
  return readable;
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
    const stream = new Readable({ read() {} });
    stream.push('{"first');
    stream.push('":"val');
    stream.push('ue"}');
    stream.push(null);
    const result = await readStdin(stream);
    expect(result).toEqual({ first: 'value' });
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
      tool_input: [1, 2, 3] as unknown as Record<string, unknown>,
      session_id: 'sess-1',
      cwd: '/home',
    });
    expect(result.tool_input).toEqual({});
  });

  it('defaults tool_input to empty object when it is null', () => {
    const result = validateToolHookPayload({
      tool_name: 'Bash',
      tool_input: null as unknown as Record<string, unknown>,
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
      } as Record<string, unknown>),
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
      } as Record<string, unknown>),
    ).toThrow(StdinReadError);
  });

  it('throws when cwd is missing', () => {
    expect(() =>
      validateToolHookPayload({
        tool_name: 'Bash',
        session_id: 'sess-1',
      } as Record<string, unknown>),
    ).toThrow(StdinReadError);
  });

  it('collects multiple validation errors', () => {
    try {
      validateToolHookPayload({} as Record<string, unknown>);
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
    expect(() => validateSessionPayload({ cwd: '/home' } as Record<string, unknown>)).toThrow(
      StdinReadError,
    );
  });

  it('throws when cwd is missing', () => {
    expect(() =>
      validateSessionPayload({ session_id: 'sess-1' } as Record<string, unknown>),
    ).toThrow(StdinReadError);
  });

  it('throws when session_id is empty string', () => {
    expect(() => validateSessionPayload({ session_id: '', cwd: '/home' })).toThrow(StdinReadError);
  });

  it('throws when cwd is empty string', () => {
    expect(() => validateSessionPayload({ session_id: 'sess-1', cwd: '' })).toThrow(StdinReadError);
  });
});

// ─── validateSubagentStopPayload ──────────────────────────────────────────────

describe('validateSubagentStopPayload', () => {
  it('validates a minimal valid subagent stop payload', () => {
    const result = validateSubagentStopPayload({
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-1',
      agent_type: 'flowguard-reviewer',
    });
    expect(result.session_id).toBe('sess-1');
    expect(result.cwd).toBe('/home');
    expect(result.agent_id).toBe('agent-1');
    expect(result.agent_type).toBe('flowguard-reviewer');
  });

  it('throws when agent_id is missing', () => {
    expect(() =>
      validateSubagentStopPayload({
        session_id: 'sess-1',
        cwd: '/home',
        agent_type: 'flowguard-reviewer',
      } as Record<string, unknown>),
    ).toThrow(StdinReadError);
  });

  it('throws when agent_type is missing', () => {
    expect(() =>
      validateSubagentStopPayload({
        session_id: 'sess-1',
        cwd: '/home',
        agent_id: 'agent-1',
      } as Record<string, unknown>),
    ).toThrow(StdinReadError);
  });

  it('throws when agent_id is empty string', () => {
    expect(() =>
      validateSubagentStopPayload({
        session_id: 'sess-1',
        cwd: '/home',
        agent_id: '',
        agent_type: 'flowguard-reviewer',
      }),
    ).toThrow(StdinReadError);
  });

  it('throws when agent_type is empty string', () => {
    expect(() =>
      validateSubagentStopPayload({
        session_id: 'sess-1',
        cwd: '/home',
        agent_id: 'agent-1',
        agent_type: '',
      }),
    ).toThrow(StdinReadError);
  });

  it('includes optional last_assistant_message when present', () => {
    const result = validateSubagentStopPayload({
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-1',
      agent_type: 'flowguard-reviewer',
      last_assistant_message: 'Done.',
    });
    expect(result.last_assistant_message).toBe('Done.');
  });

  it('omits last_assistant_message when empty string', () => {
    const result = validateSubagentStopPayload({
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-1',
      agent_type: 'flowguard-reviewer',
      last_assistant_message: '',
    });
    expect(result.last_assistant_message).toBeUndefined();
  });

  it('includes optional agent_transcript_path when present', () => {
    const result = validateSubagentStopPayload({
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-1',
      agent_type: 'flowguard-reviewer',
      agent_transcript_path: '/tmp/transcript.json',
    });
    expect(result.agent_transcript_path).toBe('/tmp/transcript.json');
  });

  it('omits agent_transcript_path when empty string', () => {
    const result = validateSubagentStopPayload({
      session_id: 'sess-1',
      cwd: '/home',
      agent_id: 'agent-1',
      agent_type: 'flowguard-reviewer',
      agent_transcript_path: '',
    });
    expect(result.agent_transcript_path).toBeUndefined();
  });

  it('collects multiple validation errors', () => {
    try {
      validateSubagentStopPayload({} as Record<string, unknown>);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StdinReadError);
      expect((e as StdinReadError).code).toBe('STDIN_VALIDATION_FAILED');
    }
  });
});
