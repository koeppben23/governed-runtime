/**
 * @test-policy
 * HAPPY: accepts local actions, full commit-SHA refs, and Docker digest refs.
 * BAD: rejects mutable external action tags, Docker image tags, and unpinned uses inside local actions.
 * CORNER: handles quoted uses values and inline comments without treating comments as authority.
 * EDGE: rejects uppercase or short SHA-like refs and validates the repository workflows end to end.
 * PERF: not applicable; workflow files are tiny CI metadata.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'check-github-actions-pinned.js');
const tempDirs: string[] = [];

async function createWorkflowProject(workflow: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-actions-pinning-'));
  tempDirs.push(root);
  const workflowsDir = path.join(root, '.github', 'workflows');
  await fs.mkdir(workflowsDir, { recursive: true });
  await fs.writeFile(path.join(workflowsDir, 'ci.yml'), workflow, 'utf8');
  return root;
}

async function writeLocalAction(root: string, action: string): Promise<void> {
  const actionDir = path.join(root, '.github', 'actions', 'local-action');
  await fs.mkdir(actionDir, { recursive: true });
  await fs.writeFile(path.join(actionDir, 'action.yml'), action, 'utf8');
}

async function runCheck(cwd: string = repoRoot) {
  return execFileAsync(process.execPath, [scriptPath], { cwd });
}

describe('GitHub Actions pinning policy', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('accepts immutable external refs, local actions, and Docker digests', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # actions/checkout v4
      - uses: ./.github/actions/local-action
      - uses: docker://ghcr.io/example/action@sha256:${'a'.repeat(64)}
`);

    await expect(runCheck(root)).resolves.toMatchObject({
      stdout: expect.stringContaining('passed'),
    });
  });

  it('rejects mutable action refs and Docker image tags', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: owner/action@main
      - uses: docker://ghcr.io/example/action:latest
`);

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('GitHub Actions pinning check failed'),
    });
  });

  it('treats quoted values as refs and comments as non-authoritative labels', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5" # actions/checkout v4
      - uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020' # actions/setup-node v4
`);

    await expect(runCheck(root)).resolves.toMatchObject({
      stdout: expect.stringContaining('passed'),
    });
  });

  it('rejects uppercase and short SHA-like refs', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: actions/checkout@34E114876B0B11C390A56381AD16EBD13914F8D5
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d682002
`);

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('40-character lowercase commit SHA'),
    });
  });

  it('rejects malformed external action names even when the ref is immutable', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
`);

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('owner/repo or owner/repo/path syntax'),
    });
  });

  it('scans local composite actions so local uses cannot hide mutable external refs', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: ./.github/actions/local-action
`);
    await writeLocalAction(
      root,
      `
name: local-action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`,
    );

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('.github/actions/local-action/action.yml'),
    });
  });

  it('accepts local composite actions when their internal external uses are pinned', async () => {
    const root = await createWorkflowProject(`
name: ci
jobs:
  test:
    steps:
      - uses: ./.github/actions/local-action
`);
    await writeLocalAction(
      root,
      `
name: local-action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # actions/setup-node v4
`,
    );

    await expect(runCheck(root)).resolves.toMatchObject({
      stdout: expect.stringContaining('passed'),
    });
  });

  it('passes against the repository workflow files end to end', async () => {
    await expect(runCheck()).resolves.toMatchObject({ stdout: expect.stringContaining('passed') });
  });
});
