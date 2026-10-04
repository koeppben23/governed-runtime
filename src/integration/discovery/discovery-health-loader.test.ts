/**
 * @module integration/discovery/discovery-health-loader.test
 * @description Adapter-error classification for the discovery health loader.
 */

import { describe, expect, it } from 'vitest';
import { PersistenceError, type PersistenceErrorCode } from '../../adapters/persistence.js';
import type { DiscoveryHealthUnavailableReason } from '../../discovery/discovery-health.js';
import { classifyDiscoveryHealthUnavailable } from './discovery-health-loader.js';

describe('discovery-health-loader', () => {
  describe('classifyDiscoveryHealthUnavailable', () => {
    /**
     * Compile-time exhaustive mapping: adding a `PersistenceErrorCode` without
     * deciding its health classification fails the typecheck of this record.
     */
    const EXPECTED_BY_CODE: Record<PersistenceErrorCode, DiscoveryHealthUnavailableReason> = {
      PARSE_FAILED: 'corrupt',
      SCHEMA_VALIDATION_FAILED: 'schema_invalid',
      SESSION_STATE_INCOMPATIBLE: 'schema_invalid',
      READ_FAILED: 'read_failed',
      WRITE_FAILED: 'read_failed',
      DIRECT_WRITE_REQUIRES_PREPARE: 'read_failed',
      OUTBOX_ORDER_CONFLICT: 'read_failed',
      LOCK_TIMEOUT: 'read_failed',
      LOCK_TIMEOUT_EXHAUSTED: 'read_failed',
    };

    it('maps every PersistenceErrorCode to its pinned unavailable reason', () => {
      for (const [code, expected] of Object.entries(EXPECTED_BY_CODE)) {
        expect(
          classifyDiscoveryHealthUnavailable(
            new PersistenceError(code as PersistenceErrorCode, 'x'),
          ),
          code,
        ).toBe(expected);
      }
      expect(Object.keys(EXPECTED_BY_CODE)).toHaveLength(9);
    });

    it('maps unknown errors and non-errors to read_failed', () => {
      expect(classifyDiscoveryHealthUnavailable(new Error('boom'))).toBe('read_failed');
      expect(classifyDiscoveryHealthUnavailable('not an error')).toBe('read_failed');
      expect(classifyDiscoveryHealthUnavailable(undefined)).toBe('read_failed');
    });
  });
});
