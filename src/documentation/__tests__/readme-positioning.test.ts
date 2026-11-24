/**
 * @module documentation/readme-positioning
 * @description Structural guards for public README positioning and discoverability.
 *
 * These tests protect the information architecture, verifiable links, and
 * technical boundaries. They intentionally do not freeze marketing prose.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
const VERSION = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();

function section(heading: string): string {
  const start = README.indexOf(`## ${heading}`);
  expect(start, `README must contain the "${heading}" section`).toBeGreaterThanOrEqual(0);
  const next = README.indexOf('\n## ', start + 1);
  return README.slice(start, next === -1 ? undefined : next);
}

describe('README positioning contract', () => {
  it('orders the public information architecture for quick understanding', () => {
    const headings = [
      '## Explore the Java demo',
      '## Core Capabilities',
      '## How FlowGuard Works',
      '## Current Release Status',
      '## Installation & Licensing',
      '## Documentation & Architecture',
      '## Development & Engineering Assurance',
    ];

    let previous = -1;
    for (const heading of headings) {
      const index = README.indexOf(heading);
      expect(index, `README must contain ${heading}`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('links the Java demo as a relative reading path without an executable promise', () => {
    const demo = section('Explore the Java demo');
    for (const target of [
      'demos/java-task-manager/README.md',
      'demos/java-task-manager/DEMO_SCRIPT.md',
      'demos/java-task-manager/EVIDENCE_PACKAGE.md',
    ]) {
      expect(demo, `demo entry must link ${target}`).toContain(`](${target})`);
      expect(existsSync(join(REPO_ROOT, target)), `${target} must exist`).toBe(true);
    }

    expect(demo).not.toContain('github.com/koeppben23/governed-runtime/blob');
    expect(demo).not.toContain('run-demo-setup.sh');
    expect(demo).not.toMatch(/5[- ]minute/i);
  });

  it('positions ProofGraph as a distinct claim-evidence verification layer', () => {
    const capabilities = section('Core Capabilities');
    expect(capabilities).toContain('[ProofGraph](./docs/proofgraph.md)');
    expect(existsSync(join(REPO_ROOT, 'docs/proofgraph.md'))).toBe(true);

    for (const layer of ['Claim', 'Evidence', 'Verification', 'Independent Review', 'Approval']) {
      expect(capabilities).toContain(`**${layer}**`);
    }

    expect(capabilities).toContain('`PROVEN`');
    expect(capabilities).toMatch(/does not mean the change is\s+free of defects/i);
    expect(capabilities).toMatch(
      /Integrity\s+verification is distinct from cryptographic identity attestation/i,
    );
    expect(capabilities).toMatch(/Human approval remains a separate, policy-bound control/i);
  });

  it('keeps exactly one lifecycle diagram with its assurance caveat', () => {
    expect([...README.matchAll(/development-lifecycle\.svg/g)]).toHaveLength(1);

    const how = section('How FlowGuard Works');
    expect(how).toContain('development-lifecycle.svg');
    expect(how).toMatch(/baseline validation/i);
    expect(how).toMatch(/fresh verification/i);
    expect(how).toMatch(/revision and error paths/i);
    expect(how).toMatch(/persisted export/i);
    expect(how).toMatch(/not completed V2\s+acceptance/i);
    expect(how).toMatch(/Installed Desktop acceptance is\s+tracked separately/i);
  });

  it('preserves release, host, and policy boundaries', () => {
    const status = section('Current Release Status');
    for (const marker of [
      'OpenCode',
      'synchronous',
      'hook-gated',
      'platform-limited',
      '#1196',
      '`NOT_SUPPORTED`',
      'trusted-plugin',
      '/hydrate',
      'flowguard run',
      'opencode run',
      'offline-capable',
      'jwksUri',
      `**Version:** ${VERSION}`,
    ]) {
      expect(status, `Current Release Status must retain ${marker}`).toContain(marker);
    }

    for (const mode of ['Solo', 'Team', 'Team-CI', 'Regulated']) {
      expect(README).toContain(mode);
    }
    expect(README).toContain('Four policy modes');
    expect(README).toContain('Three governed flows');
  });
});
