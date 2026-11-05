/**
 * @module documentation/__tests__/post-cutover-diagnostics-contract
 * @description Drift guard for ADR-011 and its delegation from ADR-010.
 *
 * The post-cutover diagnostics work is deliberately not part of the V2
 * cutover. This guard pins the contract boundaries that later implementation
 * PRs must consume: one read-only projection, honest completeness, scope-limited
 * collection, `host_command` decisions without a verified-human claim, and
 * server-side revision binding.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const ADR_010 = 'docs/decisions/010-host-neutral-opt-in-governance.md';
const ADR_011 = 'docs/decisions/011-post-cutover-diagnostics-contract.md';

/** Compare prose across source line wrapping without weakening its content. */
function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ');
}

describe('documentation/post-cutover-diagnostics-contract', () => {
  describe('HAPPY — ADR-011 is the post-cutover contract', () => {
    it('exists with an explicit not-yet-implemented status and ticket ownership', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('Post-cutover diagnostics and human-decision UX contract');
      expect(adr).toContain('implementation and installed-host acceptance **NOT_VERIFIED**');
      expect(adr).toContain('#1191');
      expect(adr).toContain('#1196');
    });

    it('stays subordinate to ADR-010 and its native command amendment', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('010-host-neutral-opt-in-governance.md');
      expect(adr).toContain('#native-command-channel-amendment-2026-11-03');
    });
  });

  describe('BAD — superseded human-origin requirements cannot re-enter', () => {
    it('records host_command as a channel, never as verified human authorship', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('`host_command`');
      expect(adr).toContain('never proves a human');
      expect(adr).toContain('never raises actor assurance');
      expect(adr).not.toContain('verified human authorship is required');
    });

    it('keeps the distinguishing host-UI requirement withdrawn for OpenCode', () => {
      const adr010 = readDoc(ADR_010);

      expect(adr010).toContain('## Native command channel amendment (2026-11-03)');
      expect(adr010).toContain('The requirement is withdrawn for OpenCode');
      expect(adr010).toContain('never a verified-human claim');
    });
  });

  describe('CORNER — revision-bound decisions and honest capture', () => {
    it('requires an expected binding at the canonical commit boundary', () => {
      const adr = readDoc(ADR_011);

      for (const field of [
        'root session and workspace/worktree',
        'activation identity and generation',
        'policy digest',
        'gate phase',
        'relevant review obligation',
        'subject kind and displayed subject digest',
      ]) {
        expect(adr).toContain(field);
      }
      expect(adr).toContain('untrusted expected binding');
      expect(adr).toContain('read-only and offers command instructions');
    });

    it('preserves known-but-unreachable children in the completeness denominator', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('Known-but-inaccessible children stay in the inventory');
      expect(adr).toContain('Removing an unreachable known child from the denominator');
      expect(adr).toContain('`COMPLETE`');
      expect(adr).toContain('`PARTIAL`');
      expect(adr).toContain('`NOT_VERIFIED`');
    });
  });

  describe('EDGE — diagnostics remain read-only and host claims stay unverified', () => {
    it('separates the diagnostic entry from repair and activation', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('MUST NOT start governance, hydrate, reconcile audit');
      expect(adr).toContain('never becomes an authorization or evidence source');
      expect(adr).toContain('does not fetch or merge foreign session content');
    });

    it('does not claim installed Desktop support from documentation', () => {
      const adr = readDoc(ADR_011);

      expect(adr).toContain('A documented API is not evidence for the pinned installed build');
      expect(adr).toContain('Desktop, CLI/TUI and headless capabilities are probed');
      expect(adr).toContain('No claim of supported Desktop UX without an installed');
    });
  });
});
