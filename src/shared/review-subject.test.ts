import { describe, expect, it } from 'vitest';
import { hashCanonicalRepositorySubject } from './review-subject.js';

describe('hashCanonicalRepositorySubject', () => {
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
