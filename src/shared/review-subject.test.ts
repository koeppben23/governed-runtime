import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ReviewRepositoryIdentity } from '../state/evidence-review-subject.js';
import {
  hashCanonicalRepositorySubject,
  type ReviewRepositoryIdentityValue,
} from './review-subject.js';

describe('hashCanonicalRepositorySubject', () => {
  it('keeps the state-owned identity authority assignable to the shared port', () => {
    // Compile-time drift pin: if state/ changes the identity shape
    // incompatibly, this assertion fails instead of the port silently drifting.
    expectTypeOf<ReviewRepositoryIdentity>().toMatchTypeOf<ReviewRepositoryIdentityValue>();
  });

  const input = {
    baseRepository: { kind: 'local' as const, rootCommitDigest: 'd'.repeat(64) },
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    changedPaths: ['src/auth.ts'],
    materialDigest: 'c'.repeat(64),
  };

  it('creates a stable digest with local repository identity', () => {
    expect(hashCanonicalRepositorySubject(input)).toBe(hashCanonicalRepositorySubject(input));
  });

  it('preserves the existing remote-backed digest input shape', () => {
    const repository = { host: 'github.com', owner: 'flowguard', name: 'core' };
    expect(
      hashCanonicalRepositorySubject({
        ...input,
        baseRepository: repository,
        headRepository: repository,
      }),
    ).toBe(
      hashCanonicalRepositorySubject({
        ...input,
        baseRepository: repository,
        headRepository: repository,
      }),
    );
  });

  it('binds local provenance to frozen commit and content fields', () => {
    const digest = hashCanonicalRepositorySubject(input);
    expect(
      hashCanonicalRepositorySubject({
        ...input,
        baseRepository: { kind: 'local', rootCommitDigest: 'e'.repeat(64) },
      }),
    ).not.toBe(digest);
    expect(hashCanonicalRepositorySubject({ ...input, headSha: 'd'.repeat(40) })).not.toBe(digest);
    expect(hashCanonicalRepositorySubject({ ...input, changedPaths: ['src/other.ts'] })).not.toBe(
      digest,
    );
  });
});
