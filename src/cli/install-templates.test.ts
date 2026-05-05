/**
 * @module cli/install-templates.test
 * @description Tests for DEV_REPO_INVARIANTS, crypto helpers, and template functions.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, computeMandatesDigest } from './install.js';
import {
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  MANDATES_FILENAME,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  extractManagedBody,
  isManagedArtifact,
} from './templates.js';
import { REPO_ROOT, setupCliTestEnvironment } from './install-test-helpers.test.js';

setupCliTestEnvironment();

// ─── DEV_REPO_INVARIANTS ──────────────────────────────────────────────────────

describe('DEV_REPO_INVARIANTS', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('AGENTS.md exists in repo root (dev ruleset)', () => {
      expect(existsSync(path.join(REPO_ROOT, 'AGENTS.md'))).toBe(true);
    });

    it('opencode.json exists in repo root', () => {
      expect(existsSync(path.join(REPO_ROOT, 'opencode.json'))).toBe(true);
    });

    it('.opencode/ is NOT tracked in git (install artifacts are not committed)', () => {
      const gitignorePath = path.join(REPO_ROOT, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);
      const gitignore = readFileSync(gitignorePath, 'utf-8');
      expect(gitignore).toContain('.opencode/');
    });

    it('AGENTS.md has no dead links to docs/agent-guidance/', async () => {
      const content = await fs.readFile(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
      expect(content).not.toContain('docs/agent-guidance/');
    });

    it('AGENTS.md contains v3 core sections matching FLOWGUARD_MANDATES_BODY', async () => {
      const agentsContent = await fs.readFile(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
      expect(agentsContent).toContain('## 1. Mission');
      expect(agentsContent).toContain('## 2. Priority Ladder');
      expect(agentsContent).toContain('## 3. Task Class Router');
      expect(agentsContent).toContain('## Red Lines');
      expect(agentsContent).toContain('## 8. Output Contract');
      expect(agentsContent).toContain('## 12. Extended Guidance');
    });

    it('AGENTS.md is self-contained (no dead links)', async () => {
      const content = await fs.readFile(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('This document is self-contained');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('opencode.json has empty instructions array (dev repo uses AGENTS.md, not installer path)', async () => {
      const content = await fs.readFile(path.join(REPO_ROOT, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.instructions).toEqual([]);
    });

    it('COMMANDS template covers all slash commands', () => {
      const commandNames = Object.keys(COMMANDS);
      expect(commandNames).toHaveLength(20);
      for (const expected of [
        'hydrate.md',
        'status.md',
        'ticket.md',
        'plan.md',
        'continue.md',
        'implement.md',
        'validate.md',
        'review-decision.md',
        'review.md',
        'architecture.md',
        'abort.md',
        'archive.md',
        'start.md',
        'task.md',
        'approve.md',
        'request-changes.md',
        'reject.md',
        'check.md',
        'export.md',
        'why.md',
      ]) {
        expect(commandNames).toContain(expected);
      }
    });

    it('all slash commands use Goal/Rules/Governance/Done-when structure', () => {
      for (const [name, content] of Object.entries(COMMANDS)) {
        expect(content, `${name} missing ## Goal`).toContain('## Goal');
        expect(content, `${name} missing ## Governance rules`).toContain('## Governance rules');
        expect(content, `${name} missing ## Done-when`).toContain('## Done-when');
        expect(content, `${name} has legacy ## Task`).not.toMatch(/^## Task$/m);
        expect(content, `${name} has legacy ## Constraints`).not.toMatch(/^## Constraints$/m);
      }
    });

    it('all slash commands have Done-when with verifiable completion criteria', () => {
      for (const [name, content] of Object.entries(COMMANDS)) {
        const doneIdx = content.indexOf('## Done-when');
        expect(doneIdx, `${name} missing ## Done-when`).toBeGreaterThan(-1);
        const doneSection = content.substring(doneIdx);
        const bullets = doneSection.match(/^- /gm);
        expect(
          bullets && bullets.length >= 2,
          `${name} Done-when should have >= 2 criteria, found ${bullets?.length ?? 0}`,
        ).toBe(true);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('REPO_ROOT resolves to a directory containing package.json with name @flowguard/core', async () => {
      const content = await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe('@flowguard/core');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('REPO_ROOT resolution is sub-millisecond', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── crypto helpers ───────────────────────────────────────────────────────────

describe('cli/crypto', () => {
  describe('HAPPY', () => {
    it('sha256 returns 64-char hex string', () => {
      const digest = sha256('hello');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('computeMandatesDigest returns consistent digest', () => {
      const d1 = computeMandatesDigest();
      const d2 = computeMandatesDigest();
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('BAD', () => {
    it('sha256 of empty string is valid', () => {
      const digest = sha256('');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('CORNER', () => {
    it('computeMandatesDigest matches sha256 of FLOWGUARD_MANDATES_BODY', () => {
      expect(computeMandatesDigest()).toBe(sha256(FLOWGUARD_MANDATES_BODY));
    });
  });

  describe('EDGE', () => {
    it('different inputs produce different digests', () => {
      expect(sha256('a')).not.toBe(sha256('b'));
    });
  });

  describe('PERF', () => {
    it('sha256 of mandates body completes in < 5ms', () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        sha256(FLOWGUARD_MANDATES_BODY);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });
});

// ─── templates helpers ────────────────────────────────────────────────────────

describe('cli/templates', () => {
  describe('HAPPY', () => {
    it('mandatesInstructionEntry returns bare filename for global', () => {
      expect(mandatesInstructionEntry('global')).toBe(MANDATES_FILENAME);
    });

    it('mandatesInstructionEntry returns .opencode/ prefixed for repo', () => {
      expect(mandatesInstructionEntry('repo')).toBe(`.opencode/${MANDATES_FILENAME}`);
    });

    it('buildMandatesContent includes version and digest in header', () => {
      const content = buildMandatesContent('2.0.0', 'abcd1234'.repeat(8));
      expect(content).toContain('@flowguard/core v2.0.0');
      expect(content).toContain('content-digest: sha256:');
      expect(content).toContain('# FlowGuard Agent Rules');
    });

    it('isManagedArtifact returns true for valid managed content', () => {
      const content = buildMandatesContent('2.0.0', computeMandatesDigest());
      expect(isManagedArtifact(content)).toBe(true);
    });

    it('extractManagedDigest returns correct digest', () => {
      const digest = computeMandatesDigest();
      const content = buildMandatesContent('2.0.0', digest);
      expect(extractManagedDigest(content)).toBe(digest);
    });

    it('extractManagedVersion returns correct version', () => {
      const content = buildMandatesContent('2.0.0', computeMandatesDigest());
      expect(extractManagedVersion(content)).toBe('2.0.0');
    });

    it('extractManagedBody returns the body without header', () => {
      const digest = computeMandatesDigest();
      const content = buildMandatesContent('2.0.0', digest);
      const body = extractManagedBody(content);
      expect(body).toBe(FLOWGUARD_MANDATES_BODY);
    });
  });

  describe('BAD', () => {
    it('isManagedArtifact returns false for plain markdown', () => {
      expect(isManagedArtifact('# Just a file\n')).toBe(false);
    });

    it('extractManagedDigest returns null for content without header', () => {
      expect(extractManagedDigest('# No header')).toBeNull();
    });

    it('extractManagedVersion returns null for content without header', () => {
      expect(extractManagedVersion('# No header')).toBeNull();
    });

    it('extractManagedBody returns null for content without header', () => {
      expect(extractManagedBody('# No header')).toBeNull();
    });
  });

  describe('CORNER', () => {
    it("LEGACY_INSTRUCTION_ENTRY is 'AGENTS.md'", () => {
      expect(LEGACY_INSTRUCTION_ENTRY).toBe('AGENTS.md');
    });

    it("MANDATES_FILENAME is 'flowguard-mandates.md'", () => {
      expect(MANDATES_FILENAME).toBe('flowguard-mandates.md');
    });
  });

  describe('EDGE', () => {
    it('buildMandatesContent body starts with # FlowGuard Agent Rules', () => {
      const content = buildMandatesContent('1.0.0', 'a'.repeat(64));
      const lines = content.split('\n');
      expect(lines[3]).toBe('# FlowGuard Agent Rules');
    });

    it('FLOWGUARD_MANDATES_BODY contains v3 structure with all core sections', () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 1. Mission');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Language Conventions');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 2. Priority Ladder');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 3. Task Class Router');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 4. Hard Invariants');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Red Lines');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Before Acting Rule');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 5. Evidence Rules');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 6. Tool and Verification Policy');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 7. Ambiguity Policy');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 8. Output Contract');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 9. Implementation Checklist');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 10. Review Checklist');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 11. High-Risk Extension');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 12. Extended Guidance');
    });

    it('v3 sections are followed by end marker (no legacy sections)', () => {
      const v3EndIdx = FLOWGUARD_MANDATES_BODY.indexOf('## 12. Extended Guidance');
      const endMarkerIdx = FLOWGUARD_MANDATES_BODY.indexOf('[End of v3 Agent Rules]');
      expect(v3EndIdx).toBeGreaterThan(-1);
      expect(endMarkerIdx).toBeGreaterThan(v3EndIdx);
    });

    it('FLOWGUARD_MANDATES_BODY does not reference AGENTS.md', () => {
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('AGENTS.md');
    });

    it('FLOWGUARD_MANDATES_BODY contains v3 output contract with task-class scaling', () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain('Use one output contract, scaled by task class:');
      expect(FLOWGUARD_MANDATES_BODY).toContain('TRIVIAL:');
      expect(FLOWGUARD_MANDATES_BODY).toContain('STANDARD:');
      expect(FLOWGUARD_MANDATES_BODY).toContain('HIGH-RISK:');
    });

    it('FLOWGUARD_MANDATES_BODY is self-contained (no dead links)', () => {
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('docs/agent-guidance/');
      expect(FLOWGUARD_MANDATES_BODY).toContain('[End of v3 Agent Rules]');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Deprecated');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Legacy');
    });

    it('FLOWGUARD_MANDATES_BODY contains all v3 core sections', () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 1. Mission');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 2. Priority Ladder');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 3. Task Class Router');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Before Acting Rule');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Before Completing Rule');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## Red Lines');
      expect(FLOWGUARD_MANDATES_BODY).toContain('## 8. Output Contract');
    });

    it('FLOWGUARD_MANDATES_BODY red lines include WHY-context and fail-closed alternatives', () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain('because hidden failures corrupt downstream state');
      expect(FLOWGUARD_MANDATES_BODY).toContain(
        'because conflicting authorities cause non-deterministic decisions',
      );
      expect(FLOWGUARD_MANDATES_BODY).toContain(
        'Instead: surface errors explicitly, return BLOCKED or an explicit failure, and stop.',
      );
      expect(FLOWGUARD_MANDATES_BODY).toContain(
        'Instead: extend the existing canonical authority.',
      );
    });

    it('FLOWGUARD_MANDATES_BODY declares explicit scope on universal rules', () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain('These apply across all task classes:');
      expect(FLOWGUARD_MANDATES_BODY).toContain('These are prohibited across all task classes:');
      expect(FLOWGUARD_MANDATES_BODY).toContain('Use explicit markers across all task classes:');
    });

    it('FLOWGUARD_MANDATES_BODY contains no legacy mandate sections', () => {
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('## 1. Developer Mandate');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('## 2. Review Mandate');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('## 3. Output Quality Contract');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('## 4. Risk Tiering');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('## 5. Cross-Cutting Principles');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Developer Output Contract');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Review Output Contract');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Quality Index');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Canonical Tiers');
      expect(FLOWGUARD_MANDATES_BODY).not.toContain('Cross-Cutting');
    });

    it('FLOWGUARD_MANDATES_BODY ends cleanly after v3 rules', () => {
      const endMarkerIdx = FLOWGUARD_MANDATES_BODY.indexOf('[End of v3 Agent Rules]');
      const afterEnd = FLOWGUARD_MANDATES_BODY.substring(endMarkerIdx + 30);
      expect(afterEnd.trim()).toBe('');
    });
  });

  describe('PERF', () => {
    it('buildMandatesContent completes in < 5ms per call', () => {
      const digest = computeMandatesDigest();
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        buildMandatesContent('2.0.0', digest);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
