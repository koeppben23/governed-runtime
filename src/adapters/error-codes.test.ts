/**
 * @module error-codes.test
 * @description Typed error code union tests (FG-REL-040).
 *
 * Proves:
 * - HAPPY: All valid codes construct without error and expose typed `.code` property.
 * - BAD: Invalid codes are rejected at compile time (@ts-expect-error).
 * - CORNER: Error identity (name, instanceof, prototype chain) is preserved.
 * - EDGE: Code property is readonly and preserves exact literal type after construction.
 * - SMOKE: Error codes from all 8 classes match the exhaustive union membership.
 */
import { describe, it, expect } from 'vitest';

import { PersistenceError, type PersistenceErrorCode } from './persistence.js';
import { GitError, type GitErrorCode } from './git.js';
import { BindingError, type BindingErrorCode } from './binding.js';
import {
  ActorClaimError,
  ActorIdentityError,
  type ActorClaimErrorCode,
  type ActorIdentityErrorCode,
} from './actor.js';
import { WorkspaceError, type WorkspaceErrorCode } from './workspace/types.js';
import {
  EvidenceArtifactError,
  type EvidenceArtifactErrorCode,
} from './workspace/evidence-artifacts.js';
import { PolicyConfigurationError, type PolicyConfigurationErrorCode } from '../config/policy.js';

// ─── HAPPY PATH ──────────────────────────────────────────────────────────────

describe('error code type safety — HAPPY', () => {
  it('PersistenceError accepts all valid codes', () => {
    const codes: PersistenceErrorCode[] = [
      'READ_FAILED',
      'WRITE_FAILED',
      'PARSE_FAILED',
      'SCHEMA_VALIDATION_FAILED',
    ];
    for (const code of codes) {
      const err = new PersistenceError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('GitError accepts all valid codes', () => {
    const codes: GitErrorCode[] = [
      'GIT_NOT_FOUND',
      'GIT_TIMEOUT',
      'GIT_COMMAND_FAILED',
      'NOT_GIT_REPO',
    ];
    for (const code of codes) {
      const err = new GitError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('WorkspaceError accepts all valid codes', () => {
    const codes: WorkspaceErrorCode[] = [
      'INVALID_FINGERPRINT',
      'INVALID_SESSION_ID',
      'INIT_FAILED',
      'WRITE_FAILED',
      'READ_FAILED',
      'WORKSPACE_MISMATCH',
      'ARCHIVE_FAILED',
    ];
    for (const code of codes) {
      const err = new WorkspaceError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`[${code}] test ${code}`);
    }
  });

  it('EvidenceArtifactError accepts all valid codes', () => {
    const codes: EvidenceArtifactErrorCode[] = [
      'EVIDENCE_ARTIFACT_MISSING',
      'EVIDENCE_ARTIFACT_MISMATCH',
      'EVIDENCE_ARTIFACT_IMMUTABLE',
    ];
    for (const code of codes) {
      const err = new EvidenceArtifactError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('BindingError accepts all valid codes', () => {
    const codes: BindingErrorCode[] = [
      'MISSING_SESSION_ID',
      'NO_WORKTREE',
      'NOT_GIT_REPO',
      'WORKTREE_MISMATCH',
    ];
    for (const code of codes) {
      const err = new BindingError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('PolicyConfigurationError accepts all valid codes', () => {
    const codes: PolicyConfigurationErrorCode[] = [
      'EXISTING_POLICY_WEAKER_THAN_CENTRAL',
      'INVALID_POLICY_MODE',
      'CENTRAL_POLICY_INVALID_MODE',
      'CENTRAL_POLICY_INVALID_JSON',
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'CENTRAL_POLICY_PATH_EMPTY',
      'CENTRAL_POLICY_MISSING',
      'CENTRAL_POLICY_UNREADABLE',
      'EXPLICIT_WEAKER_THAN_CENTRAL',
    ];
    for (const code of codes) {
      const err = new PolicyConfigurationError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('ActorClaimError accepts all valid codes', () => {
    const codes: ActorClaimErrorCode[] = [
      'ACTOR_CLAIM_MISSING',
      'ACTOR_CLAIM_UNREADABLE',
      'ACTOR_CLAIM_INVALID',
      'ACTOR_CLAIM_EXPIRED',
      'ACTOR_CLAIM_PATH_EMPTY',
    ];
    for (const code of codes) {
      const err = new ActorClaimError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });

  it('ActorIdentityError accepts all valid codes', () => {
    const codes: ActorIdentityErrorCode[] = [
      'ACTOR_IDENTITY_UNAVAILABLE',
      'ACTOR_IDP_MODE_REQUIRED',
      'ACTOR_IDP_CONFIG_REQUIRED',
      'ACTOR_IDP_INVALID',
    ];
    for (const code of codes) {
      const err = new ActorIdentityError(code, `test ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`test ${code}`);
    }
  });
});

// ─── BAD PATH (compile-time rejection) ───────────────────────────────────────

describe('error code type safety — BAD (compile-time rejection)', () => {
  it('PersistenceError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid PersistenceErrorCode
    new PersistenceError('BOGUS', 'test');
  });

  it('GitError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid GitErrorCode
    new GitError('BOGUS', 'test');
  });

  it('WorkspaceError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid WorkspaceErrorCode
    new WorkspaceError('BOGUS', 'test');
  });

  it('EvidenceArtifactError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid EvidenceArtifactErrorCode
    new EvidenceArtifactError('BOGUS', 'test');
  });

  it('BindingError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid BindingErrorCode
    new BindingError('BOGUS', 'test');
  });

  it('PolicyConfigurationError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid PolicyConfigurationErrorCode
    new PolicyConfigurationError('BOGUS', 'test');
  });

  it('ActorClaimError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid ActorClaimErrorCode
    new ActorClaimError('BOGUS', 'test');
  });

  it('ActorIdentityError rejects invalid codes at compile time', () => {
    // @ts-expect-error — 'BOGUS' is not a valid ActorIdentityErrorCode
    new ActorIdentityError('BOGUS', 'test');
  });
});

// ─── CORNER CASES ────────────────────────────────────────────────────────────

describe('error code type safety — CORNER', () => {
  it('error identity: name and instanceof are preserved', () => {
    const errors = [
      {
        err: new PersistenceError('READ_FAILED', 'm'),
        cls: PersistenceError,
        name: 'PersistenceError',
      },
      { err: new GitError('GIT_NOT_FOUND', 'm'), cls: GitError, name: 'GitError' },
      { err: new WorkspaceError('INIT_FAILED', 'm'), cls: WorkspaceError, name: 'WorkspaceError' },
      {
        err: new EvidenceArtifactError('EVIDENCE_ARTIFACT_MISSING', 'm'),
        cls: EvidenceArtifactError,
        name: 'EvidenceArtifactError',
      },
      { err: new BindingError('MISSING_SESSION_ID', 'm'), cls: BindingError, name: 'BindingError' },
      {
        err: new PolicyConfigurationError('INVALID_POLICY_MODE', 'm'),
        cls: PolicyConfigurationError,
        name: 'PolicyConfigurationError',
      },
      {
        err: new ActorClaimError('ACTOR_CLAIM_MISSING', 'm'),
        cls: ActorClaimError,
        name: 'ActorClaimError',
      },
      {
        err: new ActorIdentityError('ACTOR_IDP_MODE_REQUIRED', 'm'),
        cls: ActorIdentityError,
        name: 'ActorIdentityError',
      },
    ];
    for (const { err, cls, name } of errors) {
      expect(err).toBeInstanceOf(cls);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('error prototype chain: stack trace is available', () => {
    const err = new PersistenceError('READ_FAILED', 'disk failure');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('disk failure');
  });

  it('WorkspaceError message includes code prefix in bracket format', () => {
    const err = new WorkspaceError('ARCHIVE_FAILED', 'tar creation');
    expect(err.message).toBe('[ARCHIVE_FAILED] tar creation');
    expect(err.code).toBe('ARCHIVE_FAILED');
  });
});

// ─── EDGE CASES ──────────────────────────────────────────────────────────────

describe('error code type safety — EDGE', () => {
  it('code property is readonly at compile time (TypeScript enforcement)', () => {
    const err = new PersistenceError('READ_FAILED', 'disk failure');
    // TypeScript `readonly` is compile-time only — cannot be reassigned in TS:
    // @ts-expect-error — Cannot assign to 'code' because it is a read-only property
    err.code = 'WRITE_FAILED';
    // At runtime the assignment goes through (JS has no readonly concept from TS),
    // but the compile-time guard is the contract we enforce.
    expect(err.code).toBeDefined();
  });

  it('code literal type is preserved through type narrowing', () => {
    const err = new GitError('GIT_TIMEOUT', 'took too long');
    // TypeScript narrows: err.code is GitErrorCode
    // At runtime, the string is exactly the literal:
    const code: string = err.code;
    expect(code).toBe('GIT_TIMEOUT');
    expect(typeof err.code).toBe('string');
  });

  it('union exhaustiveness: all PolicyConfigurationErrorCode members are distinct', () => {
    const allCodes: PolicyConfigurationErrorCode[] = [
      'EXISTING_POLICY_WEAKER_THAN_CENTRAL',
      'INVALID_POLICY_MODE',
      'CENTRAL_POLICY_INVALID_MODE',
      'CENTRAL_POLICY_INVALID_JSON',
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'CENTRAL_POLICY_PATH_EMPTY',
      'CENTRAL_POLICY_MISSING',
      'CENTRAL_POLICY_UNREADABLE',
      'EXPLICIT_WEAKER_THAN_CENTRAL',
    ];
    const unique = new Set(allCodes);
    expect(unique.size).toBe(allCodes.length);
    expect(unique.size).toBe(9);
  });

  it('ActorIdentityError unused codes still compile (forward-compatibility)', () => {
    // ACTOR_IDENTITY_UNAVAILABLE and ACTOR_IDP_INVALID are declared but not currently
    // thrown in production code. They must remain valid for forward-compatibility.
    const err1 = new ActorIdentityError('ACTOR_IDENTITY_UNAVAILABLE', 'not available');
    const err2 = new ActorIdentityError('ACTOR_IDP_INVALID', 'bad config');
    expect(err1.code).toBe('ACTOR_IDENTITY_UNAVAILABLE');
    expect(err2.code).toBe('ACTOR_IDP_INVALID');
  });
});

// ─── SMOKE (end-to-end construction pattern) ─────────────────────────────────

describe('error code type safety — SMOKE', () => {
  it('catch block pattern: code can be matched in switch without type assertion', () => {
    const err = new PersistenceError('PARSE_FAILED', 'invalid JSON at line 42');

    // Simulates real catch-block pattern without any type assertion:
    let matched = false;
    if (err instanceof PersistenceError) {
      switch (err.code) {
        case 'READ_FAILED':
        case 'WRITE_FAILED':
        case 'PARSE_FAILED':
        case 'SCHEMA_VALIDATION_FAILED':
          matched = true;
          break;
      }
    }
    expect(matched).toBe(true);
  });

  it('production catch pattern from install.ts: code comparison works', () => {
    // Reproduces the pattern at src/cli/install.ts:919
    const err = new PersistenceError('PARSE_FAILED', 'bad json');
    const isRecoverable = err.code === 'PARSE_FAILED' || err.code === 'SCHEMA_VALIDATION_FAILED';
    expect(isRecoverable).toBe(true);
  });

  it('production catch pattern from git.ts: GIT_COMMAND_FAILED detection', () => {
    // Reproduces the pattern at src/adapters/git.ts:190
    const err = new GitError('GIT_COMMAND_FAILED', 'exit code 128');
    expect(err.code === 'GIT_COMMAND_FAILED').toBe(true);
  });

  it('all 8 error classes produce throwable errors with typed codes', () => {
    const factories = [
      () => new PersistenceError('READ_FAILED', 'test'),
      () => new GitError('GIT_NOT_FOUND', 'test'),
      () => new WorkspaceError('INIT_FAILED', 'test'),
      () => new EvidenceArtifactError('EVIDENCE_ARTIFACT_MISSING', 'test'),
      () => new BindingError('MISSING_SESSION_ID', 'test'),
      () => new PolicyConfigurationError('INVALID_POLICY_MODE', 'test'),
      () => new ActorClaimError('ACTOR_CLAIM_MISSING', 'test'),
      () => new ActorIdentityError('ACTOR_IDP_MODE_REQUIRED', 'test'),
    ];

    for (const factory of factories) {
      const err = factory();
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
      expect(() => {
        throw err;
      }).toThrow();
    }
  });
});
