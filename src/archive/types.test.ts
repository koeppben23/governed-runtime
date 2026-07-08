/**
 * @module archive/types.test
 * @description Guards the archive manifest schema's session-id acceptance.
 *
 * Regression: ArchiveManifestSchema.sessionId was z.string().uuid(), which
 * rejected OpenCode's opaque "ses_..." session ids — so verifyArchive emitted
 * manifest_parse_error and archiveStatus became "failed" on every real session.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import { ArchiveManifestSchema } from './types.js';

describe('ArchiveManifestSchema sessionId', () => {
  const sessionId = ArchiveManifestSchema.shape.sessionId;

  describe('HAPPY', () => {
    it('accepts an OpenCode opaque session id (ses_...)', () => {
      expect(sessionId.safeParse('ses_10ba4085dffeR7WmrOOcVGqRnk').success).toBe(true);
    });

    it('still accepts a UUID session id', () => {
      expect(sessionId.safeParse('0e2d6869-0819-436c-8b88-5d0128eee5b8').success).toBe(true);
    });

    it('accepts a short kebab id used in adapter tests', () => {
      expect(sessionId.safeParse('archive-test-001').success).toBe(true);
    });
  });

  describe('BAD', () => {
    it('rejects an empty session id', () => {
      expect(sessionId.safeParse('').success).toBe(false);
    });
  });
});
