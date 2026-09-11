import { describe, expect, it } from 'vitest';
import { hashText } from '../shared/hashing.js';
import {
  FLOWGUARD_MANDATES_FULL_BODY,
  FLOWGUARD_MANDATES_KERNEL,
} from '../templates/mandates.js';
import { computeMandatesDigest } from './install-helpers.js';
import { buildMandatesContent, extractManagedBody, extractManagedDigest } from './templates.js';

describe('installed mandate kernel contract', () => {
  it('hashes the exact persistent kernel bytes', () => {
    expect(computeMandatesDigest()).toBe(hashText(FLOWGUARD_MANDATES_KERNEL));
  });

  it('installs the kernel rather than the full runtime projection', () => {
    const digest = computeMandatesDigest();
    const managed = buildMandatesContent('1.2.3', digest);

    expect(extractManagedDigest(managed)).toBe(digest);
    expect(extractManagedBody(managed)).toBe(FLOWGUARD_MANDATES_KERNEL);
    expect(extractManagedBody(managed)).not.toBe(FLOWGUARD_MANDATES_FULL_BODY);
  });

  it('keeps digest and installed bytes cryptographically aligned', () => {
    const digest = computeMandatesDigest();
    const body = extractManagedBody(buildMandatesContent('1.2.3', digest));

    expect(body).not.toBeNull();
    expect(hashText(body!)).toBe(digest);
  });
});
