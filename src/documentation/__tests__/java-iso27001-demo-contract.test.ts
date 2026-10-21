/**
 * @module documentation/java-iso27001-demo-contract
 * @description Contract checks for the Java demo's post-export ISO/IEC 27001
 *              evidence projection. The wrapper end-to-end tests live in
 *              `src/cli/iso27001-java-demo.test.ts`; this suite guards the
 *              mapping, the prepared-workspace artifacts, and the runbook.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseIso27001EvidenceMapping } from '../../audit/iso27001/mapping-schema.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEMO_DIR = path.join(REPO_ROOT, 'demos', 'java-task-manager');
const MAPPING_PATH = path.join(DEMO_DIR, 'iso27001-demo-mapping.json');
const WRAPPER_PATH = path.join(DEMO_DIR, 'run-iso-mapping.sh');
const SETUP_PATH = path.join(DEMO_DIR, 'run-main-demo-setup.sh');
const DEMO_SCRIPT_PATH = path.join(DEMO_DIR, 'DEMO_SCRIPT.md');
const README_PATH = path.join(DEMO_DIR, 'README.md');
const EVIDENCE_PATH = path.join(DEMO_DIR, 'EVIDENCE_PACKAGE.md');
const POSIX = process.platform !== 'win32';

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('java demo ISO/IEC 27001 evidence projection contract', () => {
  it('parses the synthetic demo mapping with the four intended controls', () => {
    const parsed = parseIso27001EvidenceMapping(JSON.parse(read(MAPPING_PATH)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = parsed.mapping;
    expect(mapping.organizationId).toBe('flowguard-demo');
    expect(mapping.ismsScopeId).toBe('java-task-manager-demo');
    expect(mapping.soaRef).toBeUndefined();
    expect(mapping.approval.reference).toContain('DEMO-NOT-AN-ORGANIZATIONAL-APPROVAL');
    expect(mapping.approval.assertedBy.toLowerCase()).toContain('synthetic');

    const byControl = new Map(
      mapping.rules.map((rule) => [rule.controlRef.controlId, rule] as const),
    );
    expect([...byControl.keys()]).toEqual(['A.8.15', 'A.8.25', 'A.8.29', 'A.8.32']);

    const logging = byControl.get('A.8.15');
    expect(logging?.evidence.map((selector) => selector.kind)).toEqual(['audit.chain_anchor']);

    const sdlc = byControl.get('A.8.25');
    expect(sdlc?.evidence.map((selector) => selector.kind)).toEqual([
      'policy.snapshot',
      'plan.approved',
      'review.implementation_verdict',
    ]);

    const testing = byControl.get('A.8.29');
    const assertion = testing?.evidence.find(
      (selector) => selector.kind === 'validation.assertion_passed',
    );
    expect(assertion).toMatchObject({
      kind: 'validation.assertion_passed',
      checkId: 'test',
      assertion: {
        providerId: 'junit',
        localId:
          'com.example.taskmanager.controller.TaskControllerTest#update_taskNotFound_returns404',
      },
    });

    const changeControl = byControl.get('A.8.32');
    expect(changeControl?.evidence.map((selector) => selector.kind)).toEqual([
      'plan.approved',
      'implementation.revision',
      'review.human_approval_decision',
    ]);
    expect(read(MAPPING_PATH).toLowerCase()).not.toContain('adorsys');
  });

  it('keeps the wrapper a thin, deterministic inspect caller with no side-channel tooling', () => {
    const wrapper = read(WRAPPER_PATH);
    for (const marker of [
      '--session',
      '--iso27001-mapping',
      '--output',
      '.opencode/node_modules/@flowguard/core/dist/cli/install.js',
      'FLOWGUARD_BIN',
      'reportDigest',
      'mappingDigest',
      'packageSha256',
      'mkdir "$FINAL"',
      'Not an ISO conformity assessment.',
    ]) {
      expect(wrapper, `wrapper must contain ${marker}`).toContain(marker);
    }
    expect(wrapper).not.toContain('npx');
    expect(wrapper).not.toContain('curl');
    expect(wrapper).not.toContain('wget');
    expect(wrapper).not.toContain('--latest');
    if (POSIX) {
      expect(statSync(WRAPPER_PATH).mode & 0o111).toBeGreaterThan(0);
      expect(() => execFileSync('bash', ['-n', WRAPPER_PATH])).not.toThrow();
      expect(() => execFileSync('bash', ['-n', SETUP_PATH])).not.toThrow();
    }
  });

  it('copies the wrapper and mapping into the prepared workspace', async () => {
    const setup = read(SETUP_PATH);
    expect(setup).toContain('run-iso-mapping.sh');
    expect(setup).toContain('iso27001-demo-mapping.json');
    expect(setup).toContain('chmod +x "$TARGET_DIR/run-iso-mapping.sh"');

    if (!POSIX) return;
    const root = await mkdtemp(path.join(tmpdir(), 'fg-java-iso-contract-'));
    const target = path.join(root, 'workspace');
    try {
      execFileSync('bash', [SETUP_PATH, '--prepare-only', target], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0' },
        timeout: 60_000,
      });
      expect(existsSync(path.join(target, 'run-iso-mapping.sh'))).toBe(true);
      expect(existsSync(path.join(target, 'iso27001-demo-mapping.json'))).toBe(true);
      expect(statSync(path.join(target, 'run-iso-mapping.sh')).mode & 0o111).toBeGreaterThan(0);
      expect(
        parseIso27001EvidenceMapping(
          JSON.parse(read(path.join(target, 'iso27001-demo-mapping.json'))) as unknown,
        ).ok,
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('places the projection after /export and states the evidence boundary', () => {
    const demo = read(DEMO_SCRIPT_PATH);
    expect(demo).toContain('Step 12 — ISO/IEC 27001:2022 Evidence Projection');
    expect(demo).toContain('./run-iso-mapping.sh --session <host-session-id>');
    expect(demo).toContain('EVIDENCE_MISSING');
    expect(demo).toContain('keine ISO-27001-Konformitätsbewertung');
    expect(demo).toContain('A.8.29');
    expect(demo.toLowerCase()).toContain('funktional');
    expect(demo).toContain('TEST_SEMANTIC_APPROPRIATENESS_NOT_ASSESSED');
    expect(demo.indexOf('/export')).toBeLessThan(
      demo.indexOf('Step 12 — ISO/IEC 27001:2022 Evidence Projection'),
    );

    expect(read(README_PATH)).toContain('ISO/IEC 27001:2022 Evidence Projection');
    expect(read(README_PATH)).toContain('EVIDENCE_MISSING');
    expect(read(EVIDENCE_PATH)).toContain('./run-iso-mapping.sh --session');
    expect(read(EVIDENCE_PATH)).toContain('synthetic');
  });

  it('does not claim the synthetic mapping is an organizational approval', () => {
    const demo = read(DEMO_SCRIPT_PATH);
    expect(demo.toLowerCase()).not.toContain('iso certified');
    expect(demo.toLowerCase()).not.toContain('iso compliant');
    expect(demo.toLowerCase()).not.toContain('certification achieved');
    expect(read(MAPPING_PATH).toLowerCase()).not.toContain('statement of applicability');
    if (POSIX) {
      expect(
        spawnSync('bash', ['-n', WRAPPER_PATH], { encoding: 'utf8' }).status,
        'wrapper shell syntax',
      ).toBe(0);
    }
  });
});
