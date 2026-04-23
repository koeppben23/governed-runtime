import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdpConfigSchema, IdpError, resolveIdpToken } from './index.js';
import { JwksRemoteKeyResolver } from './key-resolver.js';

interface RsaFixture {
  readonly privateKey: crypto.KeyObject;
  readonly publicPem: string;
  readonly publicJwk: JsonWebKey;
}

function createRsaFixture(): RsaFixture {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
}

function encodeB64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function createJwtToken(opts: {
  privateKey: crypto.KeyObject;
  kid?: string;
  alg?: 'RS256' | 'ES256';
  payloadOverrides?: Partial<Record<string, unknown>>;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    typ: 'JWT',
    alg: opts.alg ?? 'RS256',
    ...(opts.kid ? { kid: opts.kid } : {}),
  };
  const payload = {
    iss: 'https://issuer.example.com',
    aud: ['flowguard'],
    sub: 'user-123',
    email: 'user@example.com',
    name: 'Flow Guard',
    iat: now - 5,
    exp: now + 600,
    ...opts.payloadOverrides,
  };

  const headerB64 = encodeB64Url(JSON.stringify(header));
  const payloadB64 = encodeB64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), opts.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function writeTempFile(dir: string, fileName: string, content: string): Promise<string> {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('identity resolveIdpToken (P35b1)', () => {
  let tempDir = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    JwksRemoteKeyResolver.clearCacheForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('HAPPY static mode verifies token with configured PEM key', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-static-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'static-key-1' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    const actor = await resolveIdpToken(tokenPath, config);
    expect(actor.id).toBe('user-123');
    expect(actor.assurance).toBe('idp_verified');
    expect(actor.verificationMeta.keyId).toBe('static-key-1');
  });

  it('HAPPY parses legacy static config without mode (backward-compat)', () => {
    const parsed = IdpConfigSchema.parse({
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [
        {
          kind: 'pem',
          kid: 'legacy-static-key',
          alg: 'RS256',
          pem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
        },
      ],
    });

    expect(parsed.mode).toBe('static');
  });

  it('HAPPY jwks mode verifies token by kid from multi-key JWKS', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-'));
    const used = createRsaFixture();
    const unused = createRsaFixture();
    const token = createJwtToken({ privateKey: used.privateKey, kid: 'active-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(
      tempDir,
      'jwks.json',
      JSON.stringify({
        keys: [
          { ...unused.publicJwk, kid: 'old-key', alg: 'RS256' },
          { ...used.publicJwk, kid: 'active-key', alg: 'RS256' },
        ],
      }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    const actor = await resolveIdpToken(tokenPath, config);
    expect(actor.id).toBe('user-123');
    expect(actor.verificationMeta.keyId).toBe('active-key');
  });

  it('HAPPY jwksUri mode fetches remote JWKS and verifies token', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-uri-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'remote-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'remote-key', alg: 'RS256' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: 'https://id.example.com/.well-known/jwks.json',
      cacheTtlSeconds: 300,
    });

    const actor = await resolveIdpToken(tokenPath, config);
    expect(actor.id).toBe('user-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HAPPY jwksUri mode uses cache within TTL', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-cache-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'cached-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'cached-key', alg: 'RS256' }] }),
        {
          status: 200,
        },
      ),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: 'https://id.example.com/.well-known/jwks.json',
      cacheTtlSeconds: 300,
    });

    await resolveIdpToken(tokenPath, config);
    await resolveIdpToken(tokenPath, config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('BAD jwksUri mode fails closed when fetch fails after cache expiry', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-expiry-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'expiring-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'expiring-key', alg: 'RS256' }] }),
        { status: 200 },
      ),
    );
    fetchMock.mockRejectedValueOnce(new Error('network-down'));

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: 'https://id.example.com/.well-known/jwks.json',
      cacheTtlSeconds: 1,
    });

    await resolveIdpToken(tokenPath, config);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_FETCH_FAILED',
    });
  });

  it('BAD rejects missing kid with IDP_TOKEN_KID_MISSING', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-kid-missing-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(
      tempDir,
      'jwks.json',
      JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'key-a', alg: 'RS256' }] }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_TOKEN_KID_MISSING',
    });
  });

  it('BAD maps token read errors to IDP_TOKEN_MISSING', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-token-read-'));
    const fixture = createRsaFixture();
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tempDir, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_TOKEN_MISSING',
    });
  });

  it('BAD rejects empty token file with IDP_TOKEN_MISSING', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-token-empty-'));
    const fixture = createRsaFixture();
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', '   ');
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_TOKEN_MISSING',
    });
  });

  it('BAD rejects unknown kid with IDP_JWKS_KEY_NOT_FOUND', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-kid-not-found-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'missing-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(
      tempDir,
      'jwks.json',
      JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'existing-key', alg: 'RS256' }] }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_KEY_NOT_FOUND',
    });
  });

  it('BAD rejects malformed JWT format with IDP_TOKEN_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwt-format-'));
    const fixture = createRsaFixture();
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', 'not-a-jwt');
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_TOKEN_INVALID',
    });
  });

  it('BAD rejects issuer mismatch with IDP_ISSUER_MISMATCH', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-iss-mismatch-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({
      privateKey: fixture.privateKey,
      kid: 'static-key-1',
      payloadOverrides: { iss: 'https://other-issuer.example.com' },
    });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_ISSUER_MISMATCH',
    });
  });

  it('BAD rejects audience mismatch with IDP_AUDIENCE_MISMATCH', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-aud-mismatch-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({
      privateKey: fixture.privateKey,
      kid: 'static-key-1',
      payloadOverrides: { aud: ['other-audience'] },
    });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_AUDIENCE_MISMATCH',
    });
  });

  it('BAD rejects expired token with IDP_EXPIRED', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-expired-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({
      privateKey: fixture.privateKey,
      kid: 'static-key-1',
      payloadOverrides: {
        exp: Math.floor(Date.now() / 1000) - 60,
      },
    });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_EXPIRED',
    });
  });

  it('BAD rejects not-yet-valid token with IDP_NOT_YET_VALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-not-yet-valid-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({
      privateKey: fixture.privateKey,
      kid: 'static-key-1',
      payloadOverrides: {
        nbf: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const config = IdpConfigSchema.parse({
      mode: 'static',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [{ kind: 'pem', kid: 'static-key-1', alg: 'RS256', pem: fixture.publicPem }],
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_NOT_YET_VALID',
    });
  });

  it('BAD rejects JWKS key alg mismatch with IDP_JWKS_ALGORITHM_MISMATCH', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-alg-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'mismatch-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(
      tempDir,
      'jwks.json',
      JSON.stringify({ keys: [{ ...fixture.publicJwk, kid: 'mismatch-key', alg: 'ES256' }] }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_ALGORITHM_MISMATCH',
    });
  });

  it('EDGE rejects malformed JWKS JSON with IDP_JWKS_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-invalid-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'key-a' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(tempDir, 'jwks.json', '{bad-json');

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_INVALID',
    });
  });

  it('EDGE maps cryptographically invalid JWKS key material to IDP_JWKS_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-key-material-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'broken-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);
    const jwksPath = await writeTempFile(
      tempDir,
      'jwks.json',
      JSON.stringify({
        keys: [
          // schema-valid for current P35b1 parser, but not importable as RSA key material
          { kid: 'broken-key', alg: 'RS256', kty: 'RSA' },
        ],
      }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_INVALID',
    });
  });

  it('BAD jwksUri mode fails on non-OK HTTP response', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-http-status-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'http-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    );

    const config = IdpConfigSchema.parse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: 'https://id.example.com/.well-known/jwks.json',
      cacheTtlSeconds: 300,
    });

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_FETCH_FAILED',
    });
  });

  it('EDGE runtime-guards missing jwksPath/jwksUri with IDP_JWKS_URI_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-runtime-guard-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'guard-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const config = {
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      cacheTtlSeconds: 300,
    } as unknown as Parameters<typeof resolveIdpToken>[1];

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_URI_INVALID',
    });
  });

  it('EDGE rejects non-HTTPS jwksUri with IDP_JWKS_URI_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-http-uri-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'http-uri-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const config = {
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: 'http://id.example.com/.well-known/jwks.json',
      cacheTtlSeconds: 300,
    } as unknown as Parameters<typeof resolveIdpToken>[1];

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_URI_INVALID',
    });
  });

  it('EDGE rejects malformed jwksUri with IDP_JWKS_URI_INVALID', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-jwks-bad-uri-'));
    const fixture = createRsaFixture();
    const token = createJwtToken({ privateKey: fixture.privateKey, kid: 'bad-uri-key' });
    const tokenPath = await writeTempFile(tempDir, 'token.jwt', token);

    const config = {
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksUri: '::not-a-uri::',
      cacheTtlSeconds: 300,
    } as unknown as Parameters<typeof resolveIdpToken>[1];

    await expect(resolveIdpToken(tokenPath, config)).rejects.toMatchObject<Partial<IdpError>>({
      code: 'IDP_JWKS_URI_INVALID',
    });
  });

  it('CORNER rejects mixed static+jwks config at schema boundary', () => {
    const parsed = IdpConfigSchema.safeParse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath: '/tmp/jwks.json',
      signingKeys: [{ kind: 'pem', kid: 'x', alg: 'RS256', pem: 'pem' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('CORNER rejects jwks config with both jwksPath and jwksUri', () => {
    const parsed = IdpConfigSchema.safeParse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      jwksPath: '/tmp/jwks.json',
      jwksUri: 'https://id.example.com/.well-known/jwks.json',
    });
    expect(parsed.success).toBe(false);
  });

  it('CORNER rejects jwks config without jwksPath and jwksUri', () => {
    const parsed = IdpConfigSchema.safeParse({
      mode: 'jwks',
      issuer: 'https://issuer.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
    });
    expect(parsed.success).toBe(false);
  });
});
