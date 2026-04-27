/**
 * @module actor.test
 * @description Unit tests for the FlowGuard actor identity resolver (P27).
 *
 * Covers the resolveActor() function — env → git → unknown resolution.
 *
 * Test matrix:
 * 1. FLOWGUARD_ACTOR_ID + EMAIL → source: 'env'                     (HAPPY)
 * 2. git user.name/email available → source: 'git'                   (HAPPY)
 * 3. neither available → unknown                                     (HAPPY)
 * 4. env beats git when both available                               (CORNER)
 * 5. FLOWGUARD_ACTOR_EMAIL without ACTOR_ID → falls through          (CORNER)
 * 6. malformed/missing email does not crash                          (EDGE)
 * 7. git unavailable / not a repo → source: 'unknown'               (EDGE)
 *
 * @test-policy HAPPY, CORNER, EDGE — all three categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  resolveActor,
  resolveActorFromClaim,
  ActorClaimError,
  ActorIdentityError,
} from './actor.js';
import type { IdpConfig } from '../identity/types.js';

// Mock git adapter — actor resolution must not depend on real git
vi.mock('./git', () => ({
  gitUserName: vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue(null),
  gitUserEmail: vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue(null),
  // Re-export stubs for other functions to prevent import errors
  gitRoot: vi.fn(),
  gitFingerprint: vi.fn(),
  gitDiffFiles: vi.fn(),
  gitTreeFiles: vi.fn(),
  GitError: class extends Error {},
}));

// Import mocked functions for per-test configuration
import { gitUserName, gitUserEmail } from './git.js';
const mockGitUserName = vi.mocked(gitUserName);
const mockGitUserEmail = vi.mocked(gitUserEmail);

const WORKTREE = '/fake/worktree';

describe('resolveActor', () => {
  // Save and restore env vars
  const envBackup: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'FLOWGUARD_ACTOR_ID',
    'FLOWGUARD_ACTOR_EMAIL',
    'FLOWGUARD_ACTOR_CLAIMS_PATH',
    'FLOWGUARD_ACTOR_TOKEN_PATH',
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
    mockGitUserName.mockReset().mockResolvedValue(null);
    mockGitUserEmail.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  // ── HAPPY ──────────────────────────────────────────────────────────────────

  it('resolves from env when FLOWGUARD_ACTOR_ID + EMAIL set', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'ci-operator';
    process.env.FLOWGUARD_ACTOR_EMAIL = 'ci@example.com';

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'ci-operator',
      email: 'ci@example.com',
      displayName: null,
      source: 'env',
      assurance: 'best_effort',
    });
    expect(mockGitUserName).not.toHaveBeenCalled();
  });

  it('resolves from git when user.name/email available', async () => {
    mockGitUserName.mockResolvedValue('Jane Dev');
    mockGitUserEmail.mockResolvedValue('jane@dev.io');

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'Jane Dev',
      email: 'jane@dev.io',
      displayName: null,
      source: 'git',
      assurance: 'best_effort',
    });
    expect(mockGitUserName).toHaveBeenCalledWith(WORKTREE);
    expect(mockGitUserEmail).toHaveBeenCalledWith(WORKTREE);
  });

  it('resolves to unknown when neither env nor git available', async () => {
    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'unknown',
      email: null,
      displayName: null,
      source: 'unknown',
      assurance: 'best_effort',
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────────

  it('env beats git when both available', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'env-user';
    process.env.FLOWGUARD_ACTOR_EMAIL = 'env@example.com';
    mockGitUserName.mockResolvedValue('Git User');
    mockGitUserEmail.mockResolvedValue('git@example.com');

    const actor = await resolveActor(WORKTREE);

    expect(actor.source).toBe('env');
    expect(actor.id).toBe('env-user');
    // Git should not be called at all
    expect(mockGitUserName).not.toHaveBeenCalled();
  });

  it('FLOWGUARD_ACTOR_EMAIL without ACTOR_ID falls through to git', async () => {
    process.env.FLOWGUARD_ACTOR_EMAIL = 'orphan@example.com';
    mockGitUserName.mockResolvedValue('Git Fallback');

    const actor = await resolveActor(WORKTREE);

    expect(actor.source).toBe('git');
    expect(actor.id).toBe('Git Fallback');
    // Orphaned email is ignored — git email used instead
    expect(actor.email).toBeNull(); // git email returns null
  });

  // ── EDGE ───────────────────────────────────────────────────────────────────

  it('malformed/missing email does not crash', async () => {
    process.env.FLOWGUARD_ACTOR_ID = 'no-email-user';
    // No FLOWGUARD_ACTOR_EMAIL set

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'no-email-user',
      email: null,
      displayName: null,
      source: 'env',
      assurance: 'best_effort',
    });
  });

  it('git unavailable / not a repo falls to unknown', async () => {
    mockGitUserName.mockResolvedValue(null);

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'unknown',
      email: null,
      displayName: null,
      source: 'unknown',
      assurance: 'best_effort',
    });
  });

  it('whitespace-only FLOWGUARD_ACTOR_ID falls through', async () => {
    process.env.FLOWGUARD_ACTOR_ID = '   ';

    const actor = await resolveActor(WORKTREE);

    // trim() produces empty string, which is falsy → falls through
    expect(actor.source).not.toBe('env');
  });

  it('git user.name present but email absent still resolves git', async () => {
    mockGitUserName.mockResolvedValue('Name Only');
    mockGitUserEmail.mockResolvedValue(null);

    const actor = await resolveActor(WORKTREE);

    expect(actor).toEqual({
      id: 'Name Only',
      email: null,
      displayName: null,
      source: 'git',
      assurance: 'best_effort',
    });
  });

  it('uses injected env instead of process.env', async () => {
    // Verifies env DI: custom env is used, process.env is NOT touched
    const customEnv = {
      FLOWGUARD_ACTOR_ID: 'injected-user',
      FLOWGUARD_ACTOR_EMAIL: 'injected@test.com',
    } as NodeJS.ProcessEnv;

    const actor = await resolveActor(WORKTREE, { env: customEnv });

    expect(actor.source).toBe('env');
    expect(actor.id).toBe('injected-user');
    expect(actor.email).toBe('injected@test.com');
  });

  it('injected env does not leak to subsequent calls (no shared state)', async () => {
    // First call with custom env
    const customEnv = { FLOWGUARD_ACTOR_ID: 'first-user' } as NodeJS.ProcessEnv;
    const actor1 = await resolveActor(WORKTREE, { env: customEnv });
    expect(actor1.id).toBe('first-user');

    // Verify process.env was not mutated by the injection
    expect(process.env.FLOWGUARD_ACTOR_ID).not.toBe('first-user');

    // Second call without env option — uses default process.env, not the injected env
    const actor2 = await resolveActor(WORKTREE);
    expect(actor2.id).not.toBe('first-user');
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // P33: Actor Claim Tests
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('P33 resolveActorFromClaim', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-claim-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // Helper to check error code
    async function expectActorClaimError(promise: Promise<unknown>, code: string): Promise<void> {
      try {
        await promise;
        throw new Error('Expected ActorClaimError but no error was thrown');
      } catch (err) {
        if (err instanceof ActorClaimError) {
          expect(err.code).toBe(code);
        } else {
          throw err;
        }
      }
    }

    // ── HAPPY ──────────────────────────────────────────────────────────────────
    describe('HAPPY', () => {
      it('resolves from valid claim file', async () => {
        const claimPath = path.join(tmpDir, 'valid-claim.json');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 3600000);
        const issuedAt = new Date(now.getTime() - 60000);

        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: 'alice',
            actorEmail: 'alice@example.com',
            issuer: 'ci-oidc-bridge',
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        );

        const claim = await resolveActorFromClaim(claimPath);

        expect(claim.actorId).toBe('alice');
        expect(claim.actorEmail).toBe('alice@example.com');
        expect(claim.issuer).toBe('ci-oidc-bridge');
      });

      it('resolves claim with optional null email', async () => {
        const claimPath = path.join(tmpDir, 'no-email-claim.json');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 3600000);
        const issuedAt = new Date(now.getTime() - 60000);

        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: 'bob',
            actorEmail: null,
            issuer: 'ci-oidc-bridge',
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        );

        const claim = await resolveActorFromClaim(claimPath);

        expect(claim.actorId).toBe('bob');
        expect(claim.actorEmail).toBeNull();
      });
    });

    // ── BAD ────────────────────────────────────────────────────────────────────
    describe('BAD', () => {
      it('throws ACTOR_CLAIM_MISSING when file does not exist', async () => {
        await expectActorClaimError(
          resolveActorFromClaim('/nonexistent.json'),
          'ACTOR_CLAIM_MISSING',
        );
      });

      it('throws ACTOR_CLAIM_INVALID when schema is wrong', async () => {
        const claimPath = path.join(tmpDir, 'wrong-schema.json');
        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v2',
            actorId: 'charlie',
            issuer: 'test',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );

        await expectActorClaimError(resolveActorFromClaim(claimPath), 'ACTOR_CLAIM_INVALID');
      });

      it('throws ACTOR_CLAIM_INVALID when actorId is empty', async () => {
        const claimPath = path.join(tmpDir, 'empty-actor.json');
        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: '',
            issuer: 'test',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );

        await expectActorClaimError(resolveActorFromClaim(claimPath), 'ACTOR_CLAIM_INVALID');
      });

      it('throws ACTOR_CLAIM_EXPIRED when claim has expired', async () => {
        const claimPath = path.join(tmpDir, 'expired-claim.json');
        const issuedAt = new Date(Date.now() - 7200000);
        const expiresAt = new Date(Date.now() - 3600000);

        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: 'expired-user',
            issuer: 'ci-oidc-bridge',
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        );

        await expectActorClaimError(resolveActorFromClaim(claimPath), 'ACTOR_CLAIM_EXPIRED');
      });

      it('throws ACTOR_CLAIM_INVALID when issuedAt is in the future', async () => {
        const claimPath = path.join(tmpDir, 'future-issued.json');
        const issuedAt = new Date(Date.now() + 3600000);
        const expiresAt = new Date(Date.now() + 7200000);

        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: 'future-user',
            issuer: 'ci-oidc-bridge',
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        );

        await expectActorClaimError(resolveActorFromClaim(claimPath), 'ACTOR_CLAIM_INVALID');
      });
    });

    // ── CORNER ─────────────────────────────────────────────────────────────────
    describe('CORNER', () => {
      it('P34: claim wins over env when both available (fail-closed)', async () => {
        const claimPath = path.join(tmpDir, 'claim-wins-over-env.json');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 3600000);
        const issuedAt = new Date(now.getTime() - 60000);

        await fs.writeFile(
          claimPath,
          JSON.stringify({
            schemaVersion: 'v1',
            actorId: 'claim-user',
            actorEmail: 'claim@example.com',
            issuer: 'ci-oidc-bridge',
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        );
        process.env.FLOWGUARD_ACTOR_CLAIMS_PATH = claimPath;
        process.env.FLOWGUARD_ACTOR_ID = 'env-user';
        process.env.FLOWGUARD_ACTOR_EMAIL = 'env@example.com';

        const actor = await resolveActor(WORKTREE);

        // P34: claim wins over env when configured (fail-closed)
        expect(actor.source).toBe('claim');
        expect(actor.id).toBe('claim-user');
        expect(actor.assurance).toBe('claim_validated');
      });

      it('fails closed when claim path is set but missing, even if env actor is present', async () => {
        process.env.FLOWGUARD_ACTOR_CLAIMS_PATH = path.join(tmpDir, 'missing-claim.json');
        process.env.FLOWGUARD_ACTOR_ID = 'env-user';
        process.env.FLOWGUARD_ACTOR_EMAIL = 'env@example.com';

        await expectActorClaimError(resolveActor(WORKTREE), 'ACTOR_CLAIM_MISSING');
        expect(mockGitUserName).not.toHaveBeenCalled();
      });

      it('fails closed when claim path is empty/whitespace', async () => {
        process.env.FLOWGUARD_ACTOR_CLAIMS_PATH = '   ';
        process.env.FLOWGUARD_ACTOR_ID = 'env-user';

        await expectActorClaimError(resolveActor(WORKTREE), 'ACTOR_CLAIM_PATH_EMPTY');
        expect(mockGitUserName).not.toHaveBeenCalled();
      });
    });
  });

  describe('P35b1 IdP mode behavior', () => {
    async function createJwksFixture(dir: string): Promise<{
      idpConfig: IdpConfig;
      tokenPath: string;
    }> {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicJwk = publicKey.export({ format: 'jwk' });
      const now = Math.floor(Date.now() / 1000);
      const header = {
        typ: 'JWT',
        alg: 'RS256',
        kid: 'active-key',
      };
      const payload = {
        iss: 'https://issuer.example.com',
        aud: ['flowguard'],
        sub: 'oidc-user',
        exp: now + 600,
        iat: now - 10,
      };
      const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const signingInput = `${headerB64}.${payloadB64}`;
      const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
      const token = `${signingInput}.${signature.toString('base64url')}`;

      const tokenPath = path.join(dir, 'actor.jwt');
      const jwksPath = path.join(dir, 'jwks.json');
      await fs.writeFile(tokenPath, token, 'utf8');
      await fs.writeFile(
        jwksPath,
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'active-key', alg: 'RS256' }] }),
        'utf8',
      );

      return {
        tokenPath,
        idpConfig: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath,
        },
      };
    }

    it('fails closed when IdP mode is required and token path is missing', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-actor-idp-required-'));
      try {
        const { idpConfig } = await createJwksFixture(tempDir);
        await expect(resolveActor(WORKTREE, { idpConfig, idpMode: 'required' })).rejects.toThrow(
          ActorIdentityError,
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('falls back to env actor when IdP mode is optional and token verification fails', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-actor-idp-optional-'));
      try {
        const { idpConfig } = await createJwksFixture(tempDir);
        process.env.FLOWGUARD_ACTOR_ID = 'fallback-user';
        process.env.FLOWGUARD_ACTOR_EMAIL = 'fallback@example.com';
        process.env.FLOWGUARD_ACTOR_TOKEN_PATH = path.join(tempDir, 'missing.jwt');

        const actor = await resolveActor(WORKTREE, { idpConfig, idpMode: 'optional' });

        expect(actor.source).toBe('env');
        expect(actor.assurance).toBe('best_effort');
        expect(actor.id).toBe('fallback-user');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('falls back to env actor when IdP mode is optional and JWKS key material is invalid', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'fg-actor-idp-optional-jwks-invalid-'),
      );
      try {
        const { tokenPath, idpConfig } = await createJwksFixture(tempDir);
        process.env.FLOWGUARD_ACTOR_ID = 'fallback-user';
        process.env.FLOWGUARD_ACTOR_EMAIL = 'fallback@example.com';
        process.env.FLOWGUARD_ACTOR_TOKEN_PATH = tokenPath;

        await fs.writeFile(
          idpConfig.jwksPath,
          JSON.stringify({ keys: [{ kid: 'active-key', alg: 'RS256', kty: 'RSA' }] }),
          'utf8',
        );

        const actor = await resolveActor(WORKTREE, { idpConfig, idpMode: 'optional' });

        expect(actor.source).toBe('env');
        expect(actor.assurance).toBe('best_effort');
        expect(actor.id).toBe('fallback-user');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('resolves oidc actor when JWKS verification succeeds', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-actor-idp-happy-'));
      try {
        const { tokenPath, idpConfig } = await createJwksFixture(tempDir);
        process.env.FLOWGUARD_ACTOR_TOKEN_PATH = tokenPath;

        const actor = await resolveActor(WORKTREE, { idpConfig, idpMode: 'required' });

        expect(actor.source).toBe('oidc');
        expect(actor.assurance).toBe('idp_verified');
        expect(actor.id).toBe('oidc-user');
        expect(actor.verificationMeta?.keyId).toBe('active-key');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('falls back to env actor when IdP mode is optional and remote JWKS fetch fails', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'fg-actor-idp-optional-remote-fail-'),
      );
      try {
        process.env.FLOWGUARD_ACTOR_ID = 'fallback-user';
        process.env.FLOWGUARD_ACTOR_EMAIL = 'fallback@example.com';
        process.env.FLOWGUARD_ACTOR_TOKEN_PATH = path.join(tempDir, 'token.jwt');
        await fs.writeFile(
          process.env.FLOWGUARD_ACTOR_TOKEN_PATH,
          'header.payload.signature',
          'utf8',
        );

        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockRejectedValue(new Error('network-down'));

        const actor = await resolveActor(WORKTREE, {
          idpConfig: {
            mode: 'jwks',
            issuer: 'https://issuer.example.com',
            audience: ['flowguard'],
            claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
            jwksUri: 'https://id.example.com/.well-known/jwks.json',
            cacheTtlSeconds: 300,
          },
          idpMode: 'optional',
        });

        expect(fetchMock).toHaveBeenCalled();
        expect(actor.source).toBe('env');
        expect(actor.id).toBe('fallback-user');
        expect(actor.assurance).toBe('best_effort');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
