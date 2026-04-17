import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG, type FlowGuardConfig } from '../config/flowguard-config';
import { benchmarkSync } from '../test-policy';
import { evaluateApprovalConstraints, resolveActorRoles } from './rbac';
import type { IdentityAssertion } from '../state/evidence';

function cfg(overrides: Partial<FlowGuardConfig> = {}): FlowGuardConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    identity: { ...DEFAULT_CONFIG.identity, ...(overrides.identity ?? {}) },
    rbac: { ...DEFAULT_CONFIG.rbac, ...(overrides.rbac ?? {}) },
    risk: { ...DEFAULT_CONFIG.risk, ...(overrides.risk ?? {}) },
    archive: { ...DEFAULT_CONFIG.archive, ...(overrides.archive ?? {}) },
  };
}

function assertion(overrides: Partial<IdentityAssertion> = {}): IdentityAssertion {
  return {
    subjectId: 'alice',
    identitySource: 'oidc',
    assertedAt: '2026-04-17T19:00:00.000Z',
    assuranceLevel: 'strong',
    issuer: 'https://idp.example.com',
    email: 'alice@example.com',
    groups: ['approvers'],
    sessionBindingId: '2c1885be-9f8d-4673-b0b7-2ce753f37c7e',
    ...overrides,
  };
}

describe('integration/rbac', () => {
  describe('HAPPY', () => {
    it('resolves roles from subjectId matcher', () => {
      const config = cfg({
        rbac: {
          ...DEFAULT_CONFIG.rbac,
          roleBindings: [
            {
              subjectMatcher: { subjectId: 'alice' },
              roles: ['approver', 'policy_owner'],
            },
          ],
          approvalConstraints: DEFAULT_CONFIG.rbac.approvalConstraints,
        },
      });
      const result = resolveActorRoles(assertion(), config);
      expect(result.roles).toContain('approver');
      expect(result.roles).toContain('policy_owner');
      expect(result.matchedBindings).toBe(1);
    });

    it('approval constraints pass when required role is present and dual control satisfied', () => {
      const config = cfg();
      const blocked = evaluateApprovalConstraints({
        mode: 'regulated',
        initiatedBy: 'initiator',
        decidedBy: 'reviewer',
        actorRoles: ['approver'],
        config,
      });
      expect(blocked).toBeNull();
    });
  });

  describe('BAD', () => {
    it('blocks when required approver role is missing', () => {
      const blocked = evaluateApprovalConstraints({
        mode: 'regulated',
        initiatedBy: 'initiator',
        decidedBy: 'reviewer',
        actorRoles: ['operator'],
        config: cfg(),
      });
      expect(blocked?.code).toBe('APPROVER_ROLE_MISMATCH');
    });

    it('blocks when dual control is required and actor matches initiator', () => {
      const blocked = evaluateApprovalConstraints({
        mode: 'regulated',
        initiatedBy: 'alice',
        decidedBy: 'alice',
        actorRoles: ['approver'],
        config: cfg(),
      });
      expect(blocked?.code).toBe('DUAL_CONTROL_REQUIRED');
    });
  });

  describe('CORNER', () => {
    it('matches by email case-insensitively', () => {
      const config = cfg({
        rbac: {
          ...DEFAULT_CONFIG.rbac,
          roleBindings: [
            {
              subjectMatcher: { email: 'ALICE@EXAMPLE.COM' },
              roles: ['approver'],
            },
          ],
          approvalConstraints: DEFAULT_CONFIG.rbac.approvalConstraints,
        },
      });
      const result = resolveActorRoles(assertion({ email: 'alice@example.com' }), config);
      expect(result.roles).toContain('approver');
    });

    it('uses operator fallback when no bindings match', () => {
      const result = resolveActorRoles(assertion({ subjectId: 'nobody' }), cfg());
      expect(result.roles).toEqual(['operator']);
    });
  });

  describe('EDGE', () => {
    it('uses service fallback role for service identities', () => {
      const result = resolveActorRoles(assertion({ identitySource: 'service' }), cfg());
      expect(result.roles).toEqual(['service']);
    });

    it('binding conditions enforce min assurance and source', () => {
      const config = cfg({
        rbac: {
          ...DEFAULT_CONFIG.rbac,
          roleBindings: [
            {
              subjectMatcher: { subjectId: 'alice' },
              roles: ['approver'],
              conditions: { identitySource: ['oidc'], minAssuranceLevel: 'strong' },
            },
          ],
          approvalConstraints: DEFAULT_CONFIG.rbac.approvalConstraints,
        },
      });
      const weak = resolveActorRoles(assertion({ assuranceLevel: 'basic' }), config);
      expect(weak.roles).toEqual(['operator']);
      const strong = resolveActorRoles(assertion({ assuranceLevel: 'strong' }), config);
      expect(strong.roles).toContain('approver');
    });
  });

  describe('PERF', () => {
    it('role resolution p95 < 1ms', () => {
      const config = cfg({
        rbac: {
          ...DEFAULT_CONFIG.rbac,
          roleBindings: Array.from({ length: 80 }, (_, i) => ({
            subjectMatcher: { subjectId: `user-${i}` },
            roles: ['operator'],
          })).concat([{ subjectMatcher: { subjectId: 'alice' }, roles: ['approver'] }]),
          approvalConstraints: DEFAULT_CONFIG.rbac.approvalConstraints,
        },
      });

      const result = benchmarkSync(() => resolveActorRoles(assertion(), config), 500, 50);
      expect(result.p95Ms).toBeLessThan(1);
    });
  });
});
