/**
 * @module cli/iso27001-java-demo.test
 * @description Wrapper contract for the post-export Java demo ISO projection.
 *
 * The wrapper is intentionally thin: it resolves the installed FlowGuard CLI,
 * calls the existing inspect command twice, compares the semantic digests in
 * the JSON and Markdown companions, and publishes both after an atomic target
 * claim. These tests use a fake installed CLI at the real repo-install path so
 * the resolution and publication mechanics are deterministic; the product ISO
 * projection itself remains covered by the inspect-iso27001 suites.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRAPPER = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'run-iso-mapping.sh');
const MAPPING = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'iso27001-demo-mapping.json');
const SESSION = 'ses_demo123';
const POSIX = process.platform !== 'win32';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

const FAKE_CLI = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const mode = process.env.FAKE_MODE || 'success';
if (mode === 'exit1') process.exit(1);
if (mode === 'exit2') process.exit(2);
if (mode === 'nooutput') process.exit(0);
if (!output) process.exit(1);
const report = {
  reportSchemaVersion: 'iso27001-evidence-report.v1',
  evidencePackage: { verification: 'verified_snapshot', packageSha256: '${A}' },
  organization: { mappingDigest: '${B}' },
  soaVerification: 'not_verified',
  controls: [
    { controlRef: { controlId: 'A.8.15' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] },
    { controlRef: { controlId: 'A.8.25' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] },
    { controlRef: { controlId: 'A.8.29' }, status: 'EVIDENCE_MISSING', rules: [{}] },
    { controlRef: { controlId: 'A.8.32' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] }
  ],
  reportDigest: '${C}'
};
const write = () => {
  if (args.includes('--json')) {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  } else {
    const reportDigest = mode === 'mismatch' ? '${D}' : report.reportDigest;
    fs.writeFileSync(output, '# ISO report\n' + reportDigest + '\n' + report.organization.mappingDigest + '\n' + report.evidencePackage.packageSha256 + '\n');
  }
};
const delay = Number(process.env.FAKE_DELAY_MS || 0);
if (delay > 0) setTimeout(write, delay); else write();
`;

interface Workspace {
  readonly root: string;
  readonly workspace: string;
  readonly outputRoot: string;
  readonly configDir: string;
}

async function createWorkspace(options: { installed?: boolean; globalInstalled?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fg-java-iso-wrapper-'));
  const workspace = path.join(root, 'workspace');
  const outputRoot = path.join(root, 'reports');
  const configDir = path.join(root, 'config');
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(workspace, 'pom.xml'), '<project/>\n', 'utf8');
  await copyFile(WRAPPER, path.join(workspace, 'run-iso-mapping.sh'));
  await copyFile(MAPPING, path.join(workspace, 'iso27001-demo-mapping.json'));
  await chmod(path.join(workspace, 'run-iso-mapping.sh'), 0o755);

  const installCli = async (base: string) => {
    const cliDir = path.join(base, 'node_modules', '@flowguard', 'core', 'dist', 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(base, 'node_modules', '@flowguard', 'core', 'package.json'),
      JSON.stringify({ name: '@flowguard/core', version: '2.0.0-tp.2-test' }),
      'utf8',
    );
    await writeFile(path.join(cliDir, 'install.js'), FAKE_CLI, 'utf8');
  };

  if (options.installed !== false) await installCli(path.join(workspace, '.opencode'));
  if (options.globalInstalled) await installCli(configDir);
  return { root, workspace, outputRoot, configDir } satisfies Workspace;
}

function wrapperEnv(workspace: Workspace, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    NODE: process.execPath,
    OPENCODE_CONFIG_DIR: workspace.configDir,
    ...extra,
  };
}

function runWrapper(workspace: Workspace, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [path.join(workspace.workspace, 'run-iso-mapping.sh'), ...args], {
    cwd: workspace.workspace,
    env: wrapperEnv(workspace, extraEnv),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function runWrapperAsync(
  workspace: Workspace,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [path.join(workspace.workspace, 'run-iso-mapping.sh'), ...args], {
      cwd: workspace.workspace,
      env: wrapperEnv(workspace, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!POSIX)('java demo ISO wrapper', () => {
  it('resolves the repo-scoped installed CLI and publishes actual control statuses', async () => {
    const workspace = await createWorkspace();
    try {
      const result = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Export:     verified_snapshot');
      expect(result.stdout).toContain('SoA:        not_verified');
      expect(result.stdout).toContain('A.8.29     EVIDENCE_MISSING');
      expect(result.stdout).toContain('Evidence-to-control mapping only.');
      expect(result.stdout).toContain('.opencode/node_modules/@flowguard/core/dist/cli/install.js');
      const jsonPath = path.join(workspace.outputRoot, SESSION, 'iso27001-report.json');
      const mdPath = path.join(workspace.outputRoot, SESSION, 'iso27001-report.md');
      expect(existsSync(jsonPath)).toBe(true);
      expect(existsSync(mdPath)).toBe(true);
      const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
        reportDigest: string;
        organization: { mappingDigest: string };
        evidencePackage: { packageSha256: string };
      };
      expect(json.reportDigest).toBe(C);
      expect(json.organization.mappingDigest).toBe(B);
      expect(json.evidencePackage.packageSha256).toBe(A);

      const second = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('refusing to overwrite');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('resolves a global installed CLI from OPENCODE_CONFIG_DIR', async () => {
    const workspace = await createWorkspace({ installed: false, globalInstalled: true });
    try {
      const result = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(workspace.configDir);
      expect(result.stdout).toContain('@flowguard/core/dist/cli/install.js');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('gives FLOWGUARD_BIN priority over the installed path', async () => {
    const workspace = await createWorkspace();
    try {
      const explicit = path.join(workspace.root, 'explicit-flowguard.js');
      await writeFile(explicit, FAKE_CLI, 'utf8');
      const result = runWrapper(
        workspace,
        ['--session', SESSION, '--output-root', workspace.outputRoot],
        { FLOWGUARD_BIN: explicit },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(explicit);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['exit1', 1],
    ['exit2', 2],
    ['nooutput', 1],
    ['mismatch', 1],
  ] as const)('propagates %s without publishing a final report', async (mode, expected) => {
    const workspace = await createWorkspace();
    try {
      const result = runWrapper(
        workspace,
        ['--session', SESSION, '--output-root', workspace.outputRoot],
        { FAKE_MODE: mode },
      );
      expect(result.status).toBe(expected);
      expect(existsSync(path.join(workspace.outputRoot, SESSION))).toBe(false);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('rejects an output root inside the workspace before writing', async () => {
    const workspace = await createWorkspace();
    try {
      const inside = path.join(workspace.workspace, 'reports');
      const result = runWrapper(workspace, ['--session', SESSION, '--output-root', inside]);
      expect(result.status).toBe(1);
      expect(existsSync(inside)).toBe(false);
      expect(result.stderr).toContain('outside the git worktree');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('requires an explicit safe session id', async () => {
    const workspace = await createWorkspace();
    try {
      const missing = runWrapper(workspace, ['--output-root', workspace.outputRoot]);
      expect(missing.status).toBe(1);
      const unsafe = runWrapper(workspace, [
        '--session',
        '../ses_demo123',
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(unsafe.status).toBe(1);
      expect(existsSync(path.join(workspace.outputRoot, SESSION))).toBe(false);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('allows only one of two concurrent publications for the same session', async () => {
    const workspace = await createWorkspace();
    try {
      const [first, second] = await Promise.all([
        runWrapperAsync(workspace, ['--session', SESSION, '--output-root', workspace.outputRoot], {
          FAKE_DELAY_MS: '250',
        }),
        runWrapperAsync(workspace, ['--session', SESSION, '--output-root', workspace.outputRoot], {
          FAKE_DELAY_MS: '250',
        }),
      ]);
      expect([first.status, second.status].sort()).toEqual([0, 1]);
      const dir = path.join(workspace.outputRoot, SESSION);
      expect(existsSync(path.join(dir, 'iso27001-report.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'iso27001-report.md'))).toBe(true);
      const files = await Promise.all([
        readFile(path.join(dir, 'iso27001-report.json'), 'utf8'),
        readFile(path.join(dir, 'iso27001-report.md'), 'utf8'),
      ]);
      expect(files[0]).toContain(C);
      expect(files[1]).toContain(C);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });
});
