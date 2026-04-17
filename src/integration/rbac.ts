/**
 * @module integration/rbac
 * @description Identity-to-role resolution and approval constraint checks.
 */

import type { FlowGuardConfig } from '../config/flowguard-config';
import type { IdentityAssertion, ActorRole, AssuranceLevel, PolicyMode } from '../state/evidence';

const ASSURANCE_RANK: Record<AssuranceLevel, number> = {
  none: 0,
  basic: 1,
  strong: 2,
};

export interface ResolvedActorRoles {
  readonly roles: ActorRole[];
  readonly matchedBindings: number;
}

export interface ApprovalConstraintInput {
  readonly mode: PolicyMode;
  readonly initiatedBy: string;
  readonly decidedBy: string;
  readonly actorRoles: readonly ActorRole[];
  readonly config: FlowGuardConfig;
}

export interface ApprovalConstraintBlocked {
  readonly code: 'APPROVER_ROLE_MISMATCH' | 'DUAL_CONTROL_REQUIRED';
  readonly vars: Record<string, string>;
}

function isAssuranceSufficient(actual: AssuranceLevel, min: 'basic' | 'strong'): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[min];
}

function normalizeLower(value: string | undefined): string | null {
  return value ? value.trim().toLowerCase() : null;
}

function matchesBinding(
  assertion: IdentityAssertion,
  binding: FlowGuardConfig['rbac']['roleBindings'][number],
): boolean {
  const matcher = binding.subjectMatcher;

  if (matcher.subjectId && matcher.subjectId !== assertion.subjectId) {
    return false;
  }

  if (matcher.email) {
    const expected = normalizeLower(matcher.email);
    const actual = normalizeLower(assertion.email);
    if (!expected || !actual || expected !== actual) {
      return false;
    }
  }

  if (matcher.group) {
    const groups = assertion.groups ?? [];
    if (!groups.includes(matcher.group)) {
      return false;
    }
  }

  const cond = binding.conditions;
  if (!cond) {
    return true;
  }

  if (cond.identitySource && !cond.identitySource.includes(assertion.identitySource)) {
    return false;
  }

  if (
    cond.minAssuranceLevel &&
    !isAssuranceSufficient(assertion.assuranceLevel, cond.minAssuranceLevel)
  ) {
    return false;
  }

  return true;
}

/**
 * Resolve actor roles from configured role bindings.
 *
 * Fallback behavior:
 * - service identity => service role
 * - otherwise => operator role
 */
export function resolveActorRoles(
  assertion: IdentityAssertion,
  config: FlowGuardConfig,
): ResolvedActorRoles {
  const roles = new Set<ActorRole>();
  let matchedBindings = 0;

  for (const binding of config.rbac.roleBindings) {
    if (!matchesBinding(assertion, binding)) {
      continue;
    }
    matchedBindings += 1;
    for (const role of binding.roles) {
      roles.add(role);
    }
  }

  if (roles.size === 0) {
    roles.add(assertion.identitySource === 'service' ? 'service' : 'operator');
  }

  return {
    roles: Array.from(roles),
    matchedBindings,
  };
}

/**
 * Evaluate approval constraints from role config and mode.
 *
 * Returns first blocking reason (if any).
 */
export function evaluateApprovalConstraints(
  input: ApprovalConstraintInput,
): ApprovalConstraintBlocked | null {
  const { mode, initiatedBy, decidedBy, actorRoles, config } = input;
  const dualControlRequired =
    config.rbac.approvalConstraints.dualControlRequiredModes.includes(mode);

  if (dualControlRequired && initiatedBy === decidedBy) {
    return {
      code: 'DUAL_CONTROL_REQUIRED',
      vars: {
        mode,
        initiatedBy,
        decidedBy,
      },
    };
  }

  const requiredRoles = config.rbac.approvalConstraints.requiredApproverRolesByMode[mode] ?? [];
  if (requiredRoles.length === 0) {
    return null;
  }

  const hasRequiredRole = requiredRoles.some((role) => actorRoles.includes(role));
  if (!hasRequiredRole) {
    return {
      code: 'APPROVER_ROLE_MISMATCH',
      vars: {
        mode,
        requiredRoles: requiredRoles.join(', '),
        actualRoles: actorRoles.join(', ') || 'none',
      },
    };
  }

  return null;
}
