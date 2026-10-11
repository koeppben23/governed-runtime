/**
 * @module documentation/live-host-export.test
 * @description Real-process regression for complete, identity-bound live host exports.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
      directory: root,
      ...(parentSessionId === undefined ? {} : { parentID: parentSessionId }),
    },
    messages: [
      {
        info: { id: 'msg_1', sessionID: sessionId, role: 'user' },
        parts: [
          { id: 'prt_1', sessionID: sessionId, messageID: 'msg_1', type: 'text', text: 'review' },
        ],
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
    value.messages[0]!.parts[0]!.text = 'x'.repeat(3 * 65_536);
    const serialized = JSON.stringify(value);
    await fs.writeFile(payload, serialized);
    const file = await capture();
    expect((await fs.stat(file)).size).toBeGreaterThan(3 * 65_536);
    expect(await fs.readFile(file, 'utf8')).toBe(serialized);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(value);
    expect(path.basename(file)).toBe('architecture-host-ses_parent.json');
  });

  it('rejects a deliberately truncated successful export and preserves the failed bytes', async () => {
    const value = transcript();
    value.messages[0]!.parts[0]!.text = 'x'.repeat(3 * 65_536);
    const truncated = JSON.stringify(value).slice(0, 65_536);
    await fs.writeFile(payload, truncated);
    await expect(capture()).rejects.toThrow(/invalid host transcript JSON/);
    expect(await fs.readFile(path.join(root, 'architecture-host-ses_parent.json'), 'utf8')).toBe(
      truncated,
    );
    await expect(capture()).rejects.toThrow(/already exists/);
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

  it('rejects foreign sessions, invalid envelopes, cross-session messages and parts', () => {
    const options = { sessionId: 'ses_parent', workspace: root, parentSessionId: undefined };
    const value = transcript();
    const invalid = [
      {},
      { ...value, info: { ...value.info, id: 'ses_foreign' } },
      { ...value, info: { ...value.info, parentID: 'ses_foreign_parent' } },
      { ...value, messages: {} },
      { ...value, messages: [] },
      {
        ...value,
        messages: [{ info: { id: 'msg_1', sessionID: 'ses_foreign', role: 'user' }, parts: [] }],
      },
      { ...value, messages: [{ info: value.messages[0]!.info, parts: {} }] },
      { ...value, messages: [value.messages[0], value.messages[0]] },
      {
        ...value,
        messages: [
          {
            info: value.messages[0]!.info,
            parts: [{ ...value.messages[0]!.parts[0], messageID: 'msg_foreign' }],
          },
        ],
      },
      {
        ...value,
        messages: [
          {
            info: value.messages[0]!.info,
            parts: [{ ...value.messages[0]!.parts[0], sessionID: 'ses_foreign' }],
          },
        ],
      },
    ];
    for (const malformed of invalid)
      expect(() => validateHostTranscript(JSON.stringify(malformed), options)).toThrow();
  });

  it('rejects a foreign worktree even when the session identity matches', async () => {
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign);
    const value = transcript();
    value.info.directory = foreign;
    expect(() =>
      validateHostTranscript(JSON.stringify(value), {
        sessionId: 'ses_parent',
        workspace: root,
        parentSessionId: undefined,
      }),
    ).toThrow(/worktree mismatch/);
  });

  it('uses flow names and child lineage and registers no provenance on export failure', async () => {
    const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
    vi.spyOn(runner, 'requireBoundState').mockReturnValue({
      state: {
        binding: { hostSessionId: 'ses_parent' },
        reviewAssurance: { invocations: [{ childSessionId: 'ses_child' }] },
      },
      sessionDir: root,
    });
    const exported = vi.spyOn(runner, 'exportTranscript');
    exported.mockResolvedValueOnce({
      sessionId: 'ses_parent',
      file: 'parent.json',
      sha256: 'a'.repeat(64),
    });
    exported.mockRejectedValueOnce(new Error('invalid host transcript JSON'));
    const build = vi.spyOn(runner, 'installedBuild');
    const flow: { name: string; transcripts?: unknown } = { name: 'architecture' };
    await expect(
      runner.captureProvenance(flow, { sessionId: 'ses_parent', workspace: root }),
    ).rejects.toThrow(/invalid host transcript JSON/);
    expect(exported).toHaveBeenNthCalledWith(1, 'architecture', 'ses_parent', root);
    expect(exported).toHaveBeenNthCalledWith(2, 'architecture', 'ses_child', root, 'ses_parent');
    expect(flow.transcripts).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });
});
