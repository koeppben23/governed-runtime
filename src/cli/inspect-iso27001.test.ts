/**
 * @module cli/inspect-iso27001.test
 * @description End-to-end tests for `flowguard inspect --iso27001-mapping`:
 * argument contract, verified positive/negative reports, integrity exit codes,
 * companion-report write-once behavior, privacy, and read-only regression.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { archiveCompletionExport } from '../adapters/workspace/archive.js';
import { materializeEvidenceArtifacts } from '../adapters/workspace/evidence-artifacts.js';
import { sessionDir, workspacesHome } from '../adapters/workspace/index.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { writeState } from '../adapters/persistence.js';
import { BINDING, FIXED_TIME, makeProgressedState } from '../fixtures.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashFile, hashText } from '../shared/hashing.js';
import type { SessionState } from '../state/schema.js';
import {
  makeAssertionExtraction,
  makeImplementationAttempt,
  TEST_ATTEMPT_ID,
} from '../audit/iso27001/iso27001-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { getInspectUsage, parseInspectArgs } from './inspect-command.js';
import { runIso27001Inspect } from './inspect-iso27001.js';

const FINGERPRINT = 'a'.repeat(24);
const SESSION_ID = '550e8400-e29b-41d4-a716-4466554400af';
const LOCAL_ID = 'auth.spec.ts::rejects-invalid-token';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function isolatedConfigDir(): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-cli-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  return configDir;
}

function mappingOf(rules: unknown[]): string {
  return JSON.stringify({
    mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
    framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
    organizationId: 'acme-secdev',
    ismsScopeId: 'isms-prod-2026',
    mappingVersion: '1.0',
    owner: 'Secure Development Lead',
    approval: {
      reference: 'ISMS-APPROVAL-2026-014',
      approvedAt: '2026-01-15T10:00:00.000Z',
      assertedBy: 'CISO Office',
    },
    rules,
  });
}

function a829Rules(localId: string): unknown[] {
  return [
    {
      ruleId: 'sec-testing',
      controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.29' },
      policyRequirementId: 'SDLC-SEC-TEST-01',
      applicability: 'asserted_applicable',
      evidence: [
        { kind: 'validation.check_supported', checkId: 'test' },
        {
          kind: 'validation.assertion_passed',
          checkId: 'test',
          assertion: { providerId: 'vitest', localId },
        },
      ],
    },
    {
      ruleId: 'export-evidence',
      controlRef: { namespace: 'organization', controlId: 'EXP-1' },
      policyRequirementId: 'EXPORT-EVIDENCE-01',
      applicability: 'asserted_applicable',
      evidence: [{ kind: 'export.completion' }],
    },
  ];
}

interface Fixture {
  readonly sessionId: string;
  readonly sessDir: string;
  readonly exportPath: string;
  readonly mappingPath: string;
  readonly outputPath: string;
}

async function createFixture(options: { readonly localId?: string } = {}): Promise<Fixture> {
  const configDir = await isolatedConfigDir();
  const sessDir = sessionDir(FINGERPRINT, SESSION_ID);
  await fs.mkdir(sessDir, { recursive: true });

  const extraction = makeAssertionExtraction({
    attemptId: TEST_ATTEMPT_ID,
    localId: LOCAL_ID,
    status: 'passed',
  });
  const state: SessionState = {
    ...makeProgressedState('COMPLETE'),
    binding: {
      ...BINDING,
      hostSessionId: SESSION_ID,
      worktree: configDir,
      fingerprint: FINGERPRINT,
    },
    validationAttempts: [makeImplementationAttempt({ checkId: 'test', extraction })],
  };
  await writeState(sessDir, state);
  await materializeEvidenceArtifacts(sessDir, state, hashText(canonicalJsonStringify(state)));

  await appendAuditEvent(sessDir, {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: SESSION_ID,
    phase: 'COMPLETE',
    event: 'transition:EXPORT_MATERIALIZED',
    occurredAt: FIXED_TIME,
    actor: 'machine',
    detail: {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      autoAdvanced: false,
      chainIndex: -1,
    },
  });

  const exportPath = await archiveCompletionExport(FINGERPRINT, SESSION_ID);
  const packageDigest = await hashFile(exportPath);

  // Live binding: the export rail's post-archive evidence and event.
  await writeState(sessDir, {
    ...state,
    exportCompletionEvidence: {
      id: randomUUID(),
      packageDigest,
      purpose: 'auditor',
      integrityCapability: 'verifiable',
      createdAt: FIXED_TIME,
    },
  });
  await appendAuditEvent(sessDir, {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: SESSION_ID,
    phase: 'COMPLETE',
    event: 'transition:EXPORT_MATERIALIZED',
    occurredAt: '2026-01-01T00:01:00.000Z',
    actor: 'machine',
    detail: {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      autoAdvanced: false,
      chainIndex: -1,
    },
  });

  const mappingPath = path.join(configDir, 'mapping.json');
  await fs.writeFile(mappingPath, mappingOf(a829Rules(options.localId ?? LOCAL_ID)), 'utf8');
  return {
    sessionId: SESSION_ID,
    sessDir,
    exportPath,
    mappingPath,
    outputPath: path.join(configDir, 'report.json'),
  };
}

async function runCli(input: {
  readonly mappingPath: string;
  readonly json?: boolean;
  readonly outputPath?: string;
}): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write;
  const originalError = console.error;
  process.stdout.write = (chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const exit = await runIso27001Inspect({
      fingerprint: FINGERPRINT,
      sessDir: sessionDir(FINGERPRINT, SESSION_ID),
      sessionId: SESSION_ID,
      mappingPath: input.mappingPath,
      json: input.json ?? true,
      ...(input.outputPath !== undefined ? { outputPath: input.outputPath } : {}),
    });
    return { exit, stdout: stdout.join(''), stderr: stderr.join('\n') };
  } finally {
    process.stdout.write = originalOut;
    console.error = originalError;
  }
}

describe('inspect --iso27001-mapping argument contract', () => {
  it('parses the new flags and documents them in usage', () => {
    const parsed = parseInspectArgs([
      '--session',
      'sid',
      '--iso27001-mapping',
      'mapping.json',
      '--output',
      'report.md',
      '--json',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.iso27001Mapping).toBe('mapping.json');
      expect(parsed.args.output).toBe('report.md');
    }
    const usage = getInspectUsage();
    expect(usage).toContain('--iso27001-mapping');
    expect(usage).toContain('--output');
  });

  it('rejects unsupported combinations explicitly', () => {
    const noSession = parseInspectArgs(['--iso27001-mapping', 'm.json']);
    expect(noSession.ok).toBe(false);
    if (!noSession.ok) expect(noSession.error).toContain('requires --session');

    const withUpgrade = parseInspectArgs(['--upgrade-check', '--iso27001-mapping', 'm.json']);
    expect(withUpgrade.ok).toBe(false);

    const outputAlone = parseInspectArgs(['--session', 'sid', '--output', 'out.md']);
    expect(outputAlone.ok).toBe(false);
    if (!outputAlone.ok) expect(outputAlone.error).toContain('requires --iso27001-mapping');

    const duplicate = parseInspectArgs([
      '--session',
      'sid',
      '--iso27001-mapping',
      'a.json',
      '--iso27001-mapping',
      'b.json',
    ]);
    expect(duplicate.ok).toBe(false);
  });
});

describe('runIso27001Inspect', () => {
  it('produces a linked report for present, verified evidence (exit 0)', async () => {
    const fixture = await createFixture();
    const result = await runCli({ mappingPath: fixture.mappingPath });
    expect(result.exit).toBe(0);
    const report = JSON.parse(result.stdout) as {
      evidencePackage: { packageSha256: string };
      controls: Array<{
        controlRef: { controlId: string };
        status: string;
        rules: Array<{
          selectors: Array<{ status: string; evidence: Array<{ attemptId: string | null }> }>;
        }>;
      }>;
    };
    const a829 = report.controls.find((control) => control.controlRef.controlId === 'A.8.29');
    expect(a829?.status).toBe('EVIDENCE_LINKED_VERIFIED');
    expect(a829?.rules[0]?.selectors[0]?.evidence[0]?.attemptId).toBe(TEST_ATTEMPT_ID);
    const exportRule = report.controls.find((control) => control.controlRef.controlId === 'EXP-1');
    expect(exportRule?.status).toBe('EVIDENCE_LINKED_VERIFIED');
    expect(report.evidencePackage.packageSha256).toBe(await hashFile(fixture.exportPath));
  });

  it('still exits 0 with a valid report when declared evidence is missing', async () => {
    const fixture = await createFixture({ localId: 'auth.spec.ts::not-reported' });
    const result = await runCli({ mappingPath: fixture.mappingPath });
    expect(result.exit).toBe(0);
    const report = JSON.parse(result.stdout) as {
      controls: Array<{ controlRef: { controlId: string }; status: string }>;
    };
    expect(
      report.controls.find((control) => control.controlRef.controlId === 'A.8.29')?.status,
    ).toBe('EVIDENCE_MISSING');
  });

  it('rejects an invalid mapping without producing a report (exit 1)', async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      fixture.mappingPath,
      mappingOf([
        {
          ruleId: 'bad',
          controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.99.99' },
          policyRequirementId: 'REQ-1',
          applicability: 'asserted_applicable',
          evidence: [{ kind: 'policy.snapshot' }],
        },
      ]),
      'utf8',
    );
    const result = await runCli({ mappingPath: fixture.mappingPath, json: false });
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid ISO/IEC 27001 mapping');
  });

  it('fails with exit 2 when the completion export is missing or tampered', async () => {
    const configDir = await isolatedConfigDir();
    const missingMapping = path.join(configDir, 'm.json');
    await fs.writeFile(missingMapping, mappingOf(a829Rules(LOCAL_ID)), 'utf8');
    const missing = await runCli({ mappingPath: missingMapping });
    expect(missing.exit).toBe(2);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('PACKAGE_MISSING');

    const fixture = await createFixture();
    const original = await fs.readFile(fixture.exportPath);
    await fs.writeFile(fixture.exportPath, Buffer.concat([original, Buffer.from('tamper')]));
    const tampered = await runCli({ mappingPath: fixture.mappingPath });
    expect(tampered.exit).toBe(2);
    expect(tampered.stderr).toContain('PACKAGE_UNVERIFIABLE');
  });

  it('writes a companion report once and refuses unsafe or repeated output paths', async () => {
    const fixture = await createFixture();
    const first = await runCli({
      mappingPath: fixture.mappingPath,
      json: true,
      outputPath: fixture.outputPath,
    });
    expect(first.exit).toBe(0);
    const written = await fs.readFile(fixture.outputPath, 'utf-8');
    expect(written).toBe(first.stdout);
    expect(written).toContain('"reportSchemaVersion": "iso27001-evidence-report.v1"');

    const second = await runCli({
      mappingPath: fixture.mappingPath,
      json: true,
      outputPath: fixture.outputPath,
    });
    expect(second.exit).toBe(1);
    expect(second.stderr).toContain('Refusing to overwrite');

    const insideWorkspace = await runCli({
      mappingPath: fixture.mappingPath,
      json: true,
      outputPath: path.join(workspacesHome(), 'report.json'),
    });
    expect(insideWorkspace.exit).toBe(1);
    expect(insideWorkspace.stderr).toContain('config workspace');
  });

  it('renders Markdown with escaping and never leaks rationale text', async () => {
    const hostileLocalId = 'x|`**<script>alert(1)</script>**';
    const fixture = await createFixture({ localId: hostileLocalId });
    const result = await runCli({ mappingPath: fixture.mappingPath, json: false });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('# ISO/IEC 27001:2022 Evidence-to-Control Report');
    expect(result.stdout).not.toContain('<script>');
    expect(result.stdout).not.toContain('fixture rationale');
    expect(result.stdout).toContain('## Limitations');
  });

  it('is read-only for the package and session state', async () => {
    const fixture = await createFixture();
    const packageBefore = await hashFile(fixture.exportPath);
    const stateBefore = await fs.readFile(
      path.join(fixture.sessDir, 'session-state.json'),
      'utf-8',
    );
    const auditBefore = await fs.readFile(path.join(fixture.sessDir, 'audit.jsonl'), 'utf-8');
    const result = await runCli({ mappingPath: fixture.mappingPath });
    expect(result.exit).toBe(0);
    expect(await hashFile(fixture.exportPath)).toBe(packageBefore);
    expect(await fs.readFile(path.join(fixture.sessDir, 'session-state.json'), 'utf-8')).toBe(
      stateBefore,
    );
    expect(await fs.readFile(path.join(fixture.sessDir, 'audit.jsonl'), 'utf-8')).toBe(auditBefore);
  });

  it('reports the export live binding as not verified when the live state is absent', async () => {
    const fixture = await createFixture();
    await fs.rm(path.join(fixture.sessDir, 'session-state.json'));
    const result = await runCli({ mappingPath: fixture.mappingPath });
    expect(result.exit).toBe(0);
    const report = JSON.parse(result.stdout) as {
      controls: Array<{ controlRef: { controlId: string }; status: string }>;
    };
    // The archived package still verifies (the archived state is inside the
    // package); only the live-binding selector and its rule degrade.
    expect(
      report.controls.find((control) => control.controlRef.controlId === 'EXP-1')?.status,
    ).toBe('NOT_VERIFIED');
    expect(
      report.controls.find((control) => control.controlRef.controlId === 'A.8.29')?.status,
    ).toBe('EVIDENCE_LINKED_VERIFIED');
  });
});
