/**
 * @module documentation/live-host-export.test
 * @description Real-process regression for complete, identity-bound live host exports.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportHostTranscript,
  validateHostTranscript,
} from '../../../demos/java-task-manager/live-host-export.mjs';
import { Runner } from '../../../demos/java-task-manager/run-live-matrix.mjs';

let root: string;
let cli: string;
let payload: string;

function transcript(sessionId = 'ses_parent', parentSessionId?: string) {
  return {
    info: {
      id: sessionId,
      location: { directory: root },
      ...(parentSessionId === undefined ? {} : { parentID: parentSessionId }),
    },
    messages: [
      {
        id: 'msg_1',
        type: 'user',
        text: 'review',
        time: { created: 1 },
      },
      {
        id: 'msg_2',
        type: 'assistant',
        content: [{ id: 'prt_1', type: 'text', text: 'ok' }],
        time: { created: 2, completed: 3 },
        finish: 'stop',
      },
    ],
  };
}

async function capture(sessionId = 'ses_parent', parentSessionId?: string, exitCode = 0) {
  return exportHostTranscript({
    label: 'architecture',
    sessionId,
    parentSessionId,
    workspace: root,
    evidenceDir: root,
    configDir: root,
    command: process.execPath,
    argsPrefix: [cli, payload, String(exitCode)],
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-live-export-'));
  cli = path.join(root, 'export.cjs');
  payload = path.join(root, 'payload.json');
  // A large host write followed by immediate exit must be captured completely.
  await fs.writeFile(
    cli,
    "const fs = require('node:fs'); process.stdout.write(fs.readFileSync(process.argv[2])); process.exit(Number(process.argv[3]));",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('live host transcript export', () => {
  it('captures and validates a real-process export far above 64 KiB', async () => {
    const value = transcript();
    const assistant = value.messages[1] as { content: Array<{ text: string }> };
    assistant.content[0]!.text = 'x'.repeat(3 * 65_536);
    const serialized = JSON.stringify(value);
    await fs.writeFile(payload, serialized);
    const file = await capture();
    const captured = await fs.readFile(file, 'utf8');
    expect(Buffer.byteLength(captured, 'utf8')).toBeGreaterThan(3 * 65_536);
    expect(captured).toBe(serialized);
    expect(JSON.parse(captured)).toEqual(value);
    expect(path.basename(file)).toBe('architecture-host-ses_parent.json');
  });

  it('rejects a deliberately truncated successful export and preserves the failed bytes', async () => {
    const value = transcript();
    const assistant = value.messages[1] as { content: Array<{ text: string }> };
    assistant.content[0]!.text = 'x'.repeat(3 * 65_536);
    const truncated = JSON.stringify(value).slice(0, 65_536);
    await fs.writeFile(payload, truncated);
    await expect(capture()).rejects.toThrow(/invalid host transcript JSON/);
    expect(await fs.readFile(path.join(root, 'architecture-host-ses_parent.json'), 'utf8')).toBe(
      truncated,
    );
    await fs.writeFile(payload, JSON.stringify(value));
    const retried = await capture();
    expect(path.basename(retried)).toBe('architecture-attempt-2-host-ses_parent.json');
    expect(await fs.readFile(path.join(root, 'architecture-host-ses_parent.json'), 'utf8')).toBe(
      truncated,
    );
    const receipt = JSON.parse(await fs.readFile(`${retried}.receipt.json`, 'utf8'));
    expect(receipt).toMatchObject({ version: 'host-transcript.v1', attempt: 2 });
    expect(receipt.sha256).toBe(
      createHash('sha256')
        .update(await fs.readFile(retried))
        .digest('hex'),
    );
  });

  it('exports a continued host session fresh instead of reusing earlier bytes', async () => {
    const firstValue = transcript();
    await fs.writeFile(payload, JSON.stringify(firstValue));
    const first = await capture();
    expect(path.basename(first)).toBe('architecture-host-ses_parent.json');

    const continued = transcript();
    continued.messages.push({
      id: 'msg_3',
      type: 'assistant',
      content: [{ id: 'prt_2', type: 'text', text: 'continued host session' }],
      time: { created: 4, completed: 5 },
      finish: 'stop',
    });
    await fs.writeFile(payload, JSON.stringify(continued));
    const second = await capture();

    expect(path.basename(second)).toBe('architecture-attempt-2-host-ses_parent.json');
    expect(JSON.parse(await fs.readFile(second, 'utf8')).messages).toHaveLength(3);
    expect(JSON.parse(await fs.readFile(first, 'utf8')).messages).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(`${second}.receipt.json`, 'utf8'))).toMatchObject({
      attempt: 2,
      sha256: createHash('sha256')
        .update(await fs.readFile(second))
        .digest('hex'),
    });
  });

  it('keeps prior exports immutable and never reuses tampered bytes', async () => {
    await fs.writeFile(payload, JSON.stringify(transcript()));
    const first = await capture();
    await fs.appendFile(first, ' ');
    const next = await capture();
    expect(next).not.toBe(first);
    expect(await fs.readFile(first, 'utf8')).toBe(`${JSON.stringify(transcript())} `);
    expect(JSON.parse(await fs.readFile(next, 'utf8')).messages).toHaveLength(2);
    expect(path.basename(await capture())).toBe('architecture-attempt-3-host-ses_parent.json');
  });

  it('never falls back to an earlier export when the fresh probe fails binding', async () => {
    await fs.writeFile(payload, JSON.stringify(transcript('ses_child', 'ses_parent')));
    const first = await capture('ses_child', 'ses_parent');
    await expect(capture('ses_child', 'ses_foreign')).rejects.toThrow(/parent identity/);
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign);
    await expect(
      exportHostTranscript({
        label: 'architecture',
        sessionId: 'ses_child',
        parentSessionId: 'ses_parent',
        workspace: foreign,
        evidenceDir: root,
        configDir: root,
        command: process.execPath,
        argsPrefix: [cli, payload, '0'],
      }),
    ).rejects.toThrow(/worktree mismatch/);
    for (const attempt of [2, 3]) {
      await expect(
        fs.access(path.join(root, `architecture-attempt-${attempt}-host-ses_child.json`)),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(
          path.join(root, `architecture-attempt-${attempt}-host-ses_child.json.receipt.json`),
        ),
      ).rejects.toThrow();
    }
    expect(path.basename(await capture('ses_child', 'ses_parent'))).toBe(
      'architecture-attempt-4-host-ses_child.json',
    );
    expect(JSON.parse(await fs.readFile(first, 'utf8')).info.parentID).toBe('ses_parent');
  });

  it('accepts a child export only with its expected parent identity', async () => {
    await fs.writeFile(payload, JSON.stringify(transcript('ses_child', 'ses_parent')));
    await expect(capture('ses_child', 'ses_parent')).resolves.toBe(
      path.join(root, 'architecture-host-ses_child.json'),
    );
  });

  it('rejects valid JSON from a failed host process', async () => {
    await fs.writeFile(payload, JSON.stringify(transcript()));
    await expect(capture('ses_parent', undefined, 1)).rejects.toThrow(/exit=1/);
  });

  it('rejects an unanswered new user request even with an older answer and trailing idle', async () => {
    const value = transcript();
    const messages = [
      ...value.messages,
      { id: 'msg_3', type: 'user', text: 'Review the new plan', time: { created: 4 } },
      { id: 'msg_4', type: 'idle', time: { created: 5 } },
    ];
    await fs.writeFile(payload, JSON.stringify({ ...value, messages }));
    await expect(capture()).rejects.toThrow(/complete ordered user\/assistant/);
  });

  it.each(['length', 'error', 'tool-calls', undefined])(
    'does not publish a final assistant answer with finish=%s',
    async (finish) => {
      const value = transcript();
      Object.assign(value.messages[1]!, { finish });
      await fs.writeFile(payload, JSON.stringify(value));
      await expect(capture()).rejects.toThrow(/complete ordered user\/assistant/);
    },
  );

  it('rejects an old assistant response moved after a newer user request', async () => {
    const value = transcript();
    Object.assign(value.messages[0]!, { time: { created: 4 } });
    await fs.writeFile(payload, JSON.stringify(value));
    await expect(capture()).rejects.toThrow(/invalid host transcript message/);
  });

  it('reserves distinct transcript/receipt pairs during concurrent capture', async () => {
    await fs.writeFile(payload, JSON.stringify(transcript()));
    const files = await Promise.all([capture(), capture()]);
    expect(new Set(files).size).toBe(2);
    for (const file of files) {
      await expect(fs.readFile(`${file}.receipt.json`, 'utf8')).resolves.toContain('"sha256"');
    }
  });

  it('surfaces host startup failure without accepting an empty artifact', async () => {
    await expect(
      exportHostTranscript({
        label: 'architecture',
        sessionId: 'ses_parent',
        parentSessionId: undefined,
        workspace: root,
        evidenceDir: root,
        configDir: root,
        command: path.join(root, 'missing-host'),
        argsPrefix: [],
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, 'architecture-host-ses_parent.json'))).size).toBe(0);
  });

  it('rejects foreign sessions, invalid envelopes and malformed message identities', () => {
    const options = { sessionId: 'ses_parent', workspace: root, parentSessionId: undefined };
    const value = transcript();
    const invalid = [
      {},
      { ...value, info: { ...value.info, id: 'ses_foreign' } },
      { ...value, info: { ...value.info, parentID: 'ses_foreign_parent' } },
      { ...value, messages: {} },
      { ...value, messages: [] },
      { ...value, messages: [{ id: 'msg_1', type: 'unknown-control', text: 'x' }] },
      { ...value, messages: [{ id: 'msg_1', type: 'user' }] },
      { ...value, messages: [{ id: 'msg_1', type: 'assistant' }] },
      { ...value, messages: [{ id: 'msg_1', type: 'assistant', content: [] }] },
      { ...value, messages: [{ id: 'msg_1', type: 'assistant', content: [{ type: 'tool' }] }] },
      {
        ...value,
        messages: [value.messages[1], value.messages[0]],
      },
      {
        ...value,
        messages: [
          value.messages[0],
          { id: 'msg_2', type: 'assistant', content: [{ type: 'tool' }] },
        ],
      },
      { ...value, messages: [{ id: 'msg_1', type: 'idle' }] },
      { ...value, messages: [{ id: 'msg_1', type: 'user', text: 'x' }] },
      { ...value, messages: [value.messages[0], value.messages[0]] },
      {
        ...value,
        messages: [{ id: 'msg_1', type: 'assistant', content: [{ type: 'text' }, {}] }],
      },
      {
        ...value,
        messages: [
          {
            id: 'msg_1',
            type: 'assistant',
            content: [
              { id: 'part_1', type: 'text' },
              { id: 'part_1', type: 'text' },
            ],
          },
        ],
      },
    ];
    for (const malformed of invalid)
      expect(() => validateHostTranscript(JSON.stringify(malformed), options)).toThrow();
  });

  it('ignores host control messages around a complete review exchange', () => {
    const value = transcript();
    const messages = [
      { id: 'msg_ctrl_0', type: 'model-switched', time: { created: 0 } },
      value.messages[0],
      { id: 'msg_ctrl_1', type: 'system', time: { created: 2 } },
      { ...value.messages[1], time: { created: 3, completed: 4 } },
      { id: 'msg_idle', type: 'idle', time: { created: 5 } },
    ];
    expect(() =>
      validateHostTranscript(JSON.stringify({ ...value, messages }), {
        sessionId: 'ses_parent',
        workspace: root,
        parentSessionId: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects a foreign worktree even when the session identity matches', async () => {
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign);
    const value = transcript();
    value.info.location.directory = foreign;
    expect(() =>
      validateHostTranscript(JSON.stringify(value), {
        sessionId: 'ses_parent',
        workspace: root,
        parentSessionId: undefined,
      }),
    ).toThrow(/worktree mismatch/);
  });

  it('retains successful targets and attempts later children after an export failure', async () => {
    const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
    vi.spyOn(runner, 'requireBoundState').mockReturnValue({
      state: {
        binding: { hostSessionId: 'ses_parent' },
        reviewAssurance: {
          invocations: ['ses_a', 'ses_b', 'ses_c'].map((childSessionId) => ({
            childSessionId,
            obligationId: `ob-${childSessionId}`,
            invocationId: `inv-${childSessionId}`,
            attemptId: `att-${childSessionId}`,
          })),
        },
      },
      sessionDir: root,
    });
    const exported = vi.spyOn(runner, 'exportTranscript');
    exported.mockResolvedValueOnce({
      sessionId: 'ses_parent',
      file: 'parent.json',
      sha256: 'a'.repeat(64),
    });
    exported.mockResolvedValueOnce({ sessionId: 'ses_a', file: 'a.json', sha256: 'b'.repeat(64) });
    exported.mockRejectedValueOnce(new Error('invalid host transcript JSON'));
    exported.mockResolvedValueOnce({ sessionId: 'ses_c', file: 'c.json', sha256: 'c'.repeat(64) });
    const build = vi.spyOn(runner, 'installedBuild');
    const flow: { name: string; transcripts?: unknown; transcriptErrors?: unknown } = {
      name: 'architecture',
    };
    await expect(
      runner.captureProvenance(flow, { sessionId: 'ses_parent', workspace: root }),
    ).rejects.toThrow(/invalid host transcript JSON/);
    expect(exported).toHaveBeenNthCalledWith(1, 'architecture', 'ses_parent', root, undefined);
    expect(exported).toHaveBeenNthCalledWith(4, 'architecture', 'ses_c', root, 'ses_parent');
    expect(flow.transcripts).toMatchObject({
      parent: { sessionId: 'ses_parent' },
      reviewers: [{ sessionId: 'ses_a' }, { sessionId: 'ses_c' }],
    });
    expect(flow.transcripts).not.toMatchObject({
      parent: { reviewBinding: expect.anything() },
    });
    expect(flow.transcripts).toMatchObject({
      reviewers: [
        {
          sessionId: 'ses_a',
          reviewBinding: {
            obligationId: 'ob-ses_a',
            invocationId: 'inv-ses_a',
            attemptId: 'att-ses_a',
          },
        },
        {
          sessionId: 'ses_c',
          reviewBinding: {
            obligationId: 'ob-ses_c',
            invocationId: 'inv-ses_c',
            attemptId: 'att-ses_c',
          },
        },
      ],
    });
    expect(flow.transcriptErrors).toEqual([
      { sessionId: 'ses_b', reason: 'invalid host transcript JSON' },
    ]);
    expect(build).not.toHaveBeenCalled();
  });

  it('resumes a partial parent/A/B/C capture without overwriting successful targets', async () => {
    const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
    vi.spyOn(runner, 'requireBoundState').mockReturnValue({
      state: {
        binding: { hostSessionId: 'ses_parent' },
        reviewAssurance: {
          invocations: ['ses_a', 'ses_b', 'ses_c'].map((childSessionId) => ({
            childSessionId,
            obligationId: `ob-${childSessionId}`,
            invocationId: `inv-${childSessionId}`,
            attemptId: `att-${childSessionId}`,
          })),
        },
      },
      sessionDir: root,
    });
    vi.spyOn(runner, 'installedBuild').mockReturnValue({ gitSha: 'test-build' });
    let failB = true;
    vi.spyOn(runner, 'exportTranscript').mockImplementation(
      async (label, sessionId, workspace, parentSessionId) => {
        await fs.writeFile(
          payload,
          failB && sessionId === 'ses_b'
            ? '{truncated'
            : JSON.stringify(transcript(sessionId, parentSessionId)),
        );
        const file = await exportHostTranscript({
          label,
          sessionId,
          workspace,
          parentSessionId,
          evidenceDir: root,
          configDir: root,
          command: process.execPath,
          argsPrefix: [cli, payload, '0'],
        });
        return {
          sessionId,
          file: path.basename(file),
          sha256: createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        };
      },
    );
    const flow: {
      name: string;
      result: string;
      transcripts?: { parent?: unknown; reviewers: unknown[] };
      transcriptErrors?: unknown[];
    } = { name: 'architecture', result: 'FAILED' };
    const session = { sessionId: 'ses_parent', workspace: root };
    await expect(runner.captureProvenance(flow, session)).rejects.toThrow(/ses_b/);
    expect(flow.transcripts).toMatchObject({
      parent: { file: 'architecture-host-ses_parent.json' },
      reviewers: [
        { file: 'architecture-host-ses_a.json' },
        { file: 'architecture-host-ses_c.json' },
      ],
    });
    failB = false;
    await runner.captureProvenance(flow, session);
    expect(flow.result).toBe('FAILED');
    // A retry re-exports every target so the manifest can never pair a stale
    // parent with a fresh child. Earlier exports remain on disk untouched.
    expect(flow.transcripts).toMatchObject({
      parent: { file: 'architecture-attempt-2-host-ses_parent.json' },
      reviewers: [
        { file: 'architecture-attempt-2-host-ses_a.json' },
        { file: 'architecture-attempt-2-host-ses_b.json' },
        { file: 'architecture-attempt-2-host-ses_c.json' },
      ],
    });
    expect(flow.transcriptErrors).toEqual([]);
    for (const sessionId of ['ses_parent', 'ses_a', 'ses_b', 'ses_c']) {
      await expect(
        fs.access(path.join(root, `architecture-host-${sessionId}.json`)),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(root, `architecture-attempt-2-host-${sessionId}.json`)),
      ).resolves.toBeUndefined();
    }
    expect(await fs.readFile(path.join(root, 'architecture-host-ses_b.json'), 'utf8')).toBe(
      '{truncated',
    );
  });
});
