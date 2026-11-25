/**
 * @module documentation/readme-positioning
 * @description Structural guards for public README positioning and discoverability.
 *
 * These tests protect the information architecture, verifiable links, and
 * security-relevant guardrails. They are not a semantic proof of every
 * statement and intentionally avoid freezing editorial prose.
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

  it('leads with the reference result and keeps the release boundary explicit', () => {
    const evidence = section('Green checks are not enough');
    expect(evidence).toContain('build and tests passed in both runs');
    expect(evidence).toContain('required adversarial assertion passed');
    expect(evidence).toContain('`PROVEN`');
    expect(evidence).toContain('adversarial assertion was skipped');
    expect(evidence).toContain('`NOT_VERIFIED`');
    expect(evidence).toContain('No export was produced');
    expect(evidence).toContain('](docs/case-studies/java-governed-delivery.md)');
    expect(existsSync(join(REPO_ROOT, 'docs/case-studies/java-governed-delivery.md'))).toBe(true);
    expect(evidence).toContain('`develop@ede07f02`');
    expect(evidence).toContain('published Technical Preview is a');
    expect(evidence).toContain('separate, version-bound artifact');

    expect(README.indexOf('## Green checks are not enough')).toBeLessThan(
      README.indexOf('## Explore the Java demo'),
    );
    expect(README.indexOf('## Explore the Java demo')).toBeLessThan(
      README.indexOf('## Request a hands-on evaluation'),
    );
  });

  it('offers an authorized evaluation path under the proprietary boundary', () => {
    const evaluation = section('Request a hands-on evaluation');
    expect(evaluation).toContain('proprietary software');
    expect(evaluation).toContain('read-only evaluation');
    expect(evaluation).toContain('prior written permission');
    expect(evaluation).toMatch(/\[Contact the author\]\(mailto:[^)]+\)/);
    expect(evaluation).not.toMatch(/download|install|run-demo-setup/i);
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
    for (const uncertainty of [
      '`UNPROVEN`',
      '`CONTRADICTED`',
      '`STALE`',
      '`BLOCKED`',
      '`NOT_VERIFIED`',
    ]) {
      expect(capabilities).toContain(uncertainty);
    }
    expect(capabilities.toLowerCase()).toContain('integrity');
    expect(capabilities.toLowerCase()).toContain('identity attestation');
    expect(capabilities.toLowerCase()).toContain('human approval');
  });

  it('keeps audit claims inside the documented trust model', () => {
    const capabilities = section('Core Capabilities');
    expect(capabilities.toLowerCase()).toContain('tamper detection');
    expect(capabilities.toLowerCase()).toContain('trust model');
    expect(capabilities).not.toMatch(/immutable\s+`?decision:/i);
    expect(README).not.toContain('Immutable audit');
    expect(README).toContain('Tamper-evident audit');
  });

  it('documents supported engineering environments and archive provenance', () => {
    const capabilities = section('Core Capabilities');
    expect(capabilities).toContain('Supported engineering environments');

    for (const marker of [
      'TypeScript',
      'Java',
      'Angular',
      'Python',
      'Rust',
      'Go',
      'PostgreSQL',
      'MySQL',
      'MariaDB',
      'MongoDB',
      'Redis',
      'H2',
      'SQLite',
      'Oracle',
      'SQL Server',
      'sourceStateHash',
      'redacted',
    ]) {
      expect(capabilities, `Core Capabilities must retain ${marker}`).toContain(marker);
    }
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

    const altText = README.split('\n').find(
      (line) => line.startsWith('![') && line.includes('development-lifecycle.svg'),
    );
    expect(altText, 'lifecycle image must keep descriptive alt text').toBeTruthy();
    expect(altText).toContain('intended');
    expect(altText).toContain('independent implementation review');
    expect(altText).toContain('persisted export');
  });

  it('keeps the peer-review host preconditions and canonical reference', () => {
    const how = section('How FlowGuard Works');
    expect(how).toMatch(/plugin orchestration/i);
    expect(how).toMatch(/verified native review transport/i);
    expect(how).toContain('[Independent Review](./docs/independent-review.md)');
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
      'tool-result bytes',
      '[Platform Limitations](./docs/platform-limitations.md)',
      'trusted-plugin',
      '/hydrate',
      'flowguard run',
      'opencode run',
      'offline-capable',
      'jwksUri',
      'Released Technical Preview',
      'Current Development Snapshot',
      'Installed Host Acceptance',
      'Production Readiness',
      `**Version:** ${VERSION}`,
    ]) {
      expect(status, `Current Release Status must retain ${marker}`).toContain(marker);
    }

    for (const mode of ['Solo', 'Team', 'Team-CI', 'Regulated']) {
      expect(README).toContain(mode);
    }
    expect(README).toContain('Four policy modes');
    expect(README).toContain('Three governed flows');
    expect(existsSync(join(REPO_ROOT, 'docs/platform-limitations.md'))).toBe(true);
  });

  it('requires the release checksum evidence next to the install tarball', () => {
    const install = section('Installation & Licensing');
    expect(install).toContain('checksums.sha256');
    expect(install).toMatch(/same directory/i);
    expect(install).toMatch(/checksum evidence blocks installation/i);
  });

  it('does not publish unmeasured onboarding time promises', () => {
    const docsIndex = readFileSync(join(REPO_ROOT, 'docs/index.md'), 'utf8');
    expect(`${README}\n${docsIndex}`).not.toMatch(/5[- ]minute/i);
  });
});
