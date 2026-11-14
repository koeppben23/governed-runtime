/**
 * @module integration/tools/plan/plan-evidence-design
 * @description Structural Evidence Design preflight for critical plan claims.
 *
 * This module validates only that the author declared a complete, bounded
 * falsification design against the canonical claim and verification-candidate
 * authorities. It never decides whether the described variant is semantically
 * sufficient; that remains the independent reviewer's judgment.
 */

import { z } from 'zod';
import { parseStrictJsonObject } from '../../../shared/strict-json-object.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import {
  normalizeClaimStatement,
  type PlanClaimDeclaration,
} from '../../../state/proofgraph-approval.js';
import { resolveCounterexampleCandidate } from '../../proofgraph/claim-contract-rules.js';
import { extractFencedBlock } from './plan-fenced-block.js';

export const EVIDENCE_DESIGN_LANGUAGE = 'flowguard-evidence-design';

const DesignClaim = z
  .object({
    authoritySectionId: z.string().min(1),
    statement: z.string().min(1),
    positiveObservable: z.string().min(1),
    faultyVariant: z.string().min(1),
    expectedFailure: z.string().min(1),
    executionRoute: z.string().min(1),
  })
  .strict()
  .readonly();

const EvidenceDesign = z
  .object({
    version: z.literal(1),
    claims: z.array(DesignClaim),
  })
  .strict()
  .readonly();

type Design = z.infer<typeof EvidenceDesign>;
type DesignEntry = z.infer<typeof DesignClaim>;

export type PlanPreflightDiagnostic = {
  readonly field: string;
  readonly detail: string;
};

type EvidenceDesignCode = 'PLAN_EVIDENCE_DESIGN_REQUIRED' | 'PLAN_EVIDENCE_DESIGN_INVALID';

export type EvidenceDesignValidation =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'blocked';
      readonly code: EvidenceDesignCode;
      readonly reason: string;
      readonly diagnostics: readonly PlanPreflightDiagnostic[];
    };

const PLACEHOLDERS = new Set(['tbd', 'todo', 'n/a', 'na', 'none', '...', 'same as above']);

function placeholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase());
}

function key(authoritySectionId: string, statement: string): string {
  return `${authoritySectionId}\u001f${normalizeClaimStatement(statement)}`;
}

function label(claim: { readonly authoritySectionId: string; readonly statement: string }): string {
  return `claims[${claim.authoritySectionId}: ${claim.statement}]`;
}

function blocked(
  code: EvidenceDesignCode,
  reason: string,
  diagnostics: readonly PlanPreflightDiagnostic[],
): EvidenceDesignValidation {
  return { kind: 'blocked', code, reason, diagnostics };
}

function missingCritical(
  claims: readonly PlanClaimDeclaration[],
): readonly PlanPreflightDiagnostic[] {
  return claims.map((claim) => ({
    field: label(claim),
    detail: 'missing evidence-design entry for this critical claim',
  }));
}

function parseDesign(
  planText: string,
):
  | { readonly kind: 'ok'; readonly design: Design }
  | { readonly kind: 'blocked'; readonly result: EvidenceDesignValidation } {
  const block = extractFencedBlock(planText, EVIDENCE_DESIGN_LANGUAGE);
  if (block.kind !== 'ok') {
    return {
      kind: 'blocked',
      result: blocked(
        'PLAN_EVIDENCE_DESIGN_INVALID',
        `The ${EVIDENCE_DESIGN_LANGUAGE} block is ${block.kind}.`,
        [{ field: EVIDENCE_DESIGN_LANGUAGE, detail: `block is ${block.kind}` }],
      ),
    };
  }
  const decoded = parseStrictJsonObject(block.content);
  if (decoded.kind !== 'ok') {
    return {
      kind: 'blocked',
      result: blocked('PLAN_EVIDENCE_DESIGN_INVALID', decoded.reason, [
        { field: EVIDENCE_DESIGN_LANGUAGE, detail: decoded.reason },
      ]),
    };
  }
  const parsed = EvidenceDesign.safeParse(decoded.value);
  if (!parsed.success) {
    return {
      kind: 'blocked',
      result: blocked(
        'PLAN_EVIDENCE_DESIGN_INVALID',
        'The evidence-design payload violates its strict schema.',
        parsed.error.issues.slice(0, 8).map((issue) => ({
          field: issue.path.join('.'),
          detail: issue.message,
        })),
      ),
    };
  }
  return { kind: 'ok', design: parsed.data };
}

function designValues(design: DesignEntry): readonly PlanPreflightDiagnostic[] {
  const diagnostics: PlanPreflightDiagnostic[] = [];
  for (const field of [
    'positiveObservable',
    'faultyVariant',
    'expectedFailure',
    'executionRoute',
  ] as const) {
    if (placeholder(design[field])) {
      diagnostics.push({
        field,
        detail: `${field} must be a concrete declaration, not a placeholder.`,
      });
    }
  }
  return diagnostics;
}

function candidateDiagnostics(
  claim: PlanClaimDeclaration,
  design: DesignEntry,
  verificationCandidates: readonly VerificationCandidate[],
): readonly PlanPreflightDiagnostic[] {
  if (!claim.counterexampleRequirement) {
    return [
      {
        field: 'counterexampleRequirement',
        detail: 'a critical claim requires a counterexample requirement',
      },
    ];
  }
  const candidate = resolveCounterexampleCandidate(
    verificationCandidates,
    claim.counterexampleRequirement,
  );
  if (!candidate) {
    return [
      {
        field: 'executionRoute',
        detail: `counterexample check '${claim.counterexampleRequirement.checkId}' has no active verification candidate`,
      },
    ];
  }
  return design.executionRoute.includes(candidate.candidateId)
    ? []
    : [
        {
          field: 'executionRoute',
          detail: `executionRoute must name the active counterexample candidateId '${candidate.candidateId}'.`,
        },
      ];
}

function entryDiagnostics(
  claim: PlanClaimDeclaration,
  design: DesignEntry,
  verificationCandidates: readonly VerificationCandidate[],
): readonly PlanPreflightDiagnostic[] {
  const diagnostics = designValues(design);
  if (!claim.critical) return diagnostics;
  return [...diagnostics, ...candidateDiagnostics(claim, design, verificationCandidates)];
}

function matchEntries(
  claims: readonly PlanClaimDeclaration[],
  design: Design,
  verificationCandidates: readonly VerificationCandidate[],
): readonly PlanPreflightDiagnostic[] {
  const byClaim = new Map(
    claims.map((claim) => [key(claim.authoritySectionId, claim.statement), claim]),
  );
  const seen = new Set<string>();
  const diagnostics: PlanPreflightDiagnostic[] = [];
  for (const entry of design.claims) {
    const entryKey = key(entry.authoritySectionId, entry.statement);
    const claim = byClaim.get(entryKey);
    if (!claim) {
      diagnostics.push({
        field: label({ authoritySectionId: entry.authoritySectionId, statement: entry.statement }),
        detail: 'evidence-design entry does not match any accepted claim',
      });
      continue;
    }
    if (seen.has(entryKey)) {
      diagnostics.push({
        field: label({ authoritySectionId: entry.authoritySectionId, statement: entry.statement }),
        detail: 'duplicate evidence-design entry',
      });
      continue;
    }
    seen.add(entryKey);
    diagnostics.push(
      ...entryDiagnostics(claim, entry, verificationCandidates).map((diagnostic) => ({
        field: `${label(claim)}.${diagnostic.field}`,
        detail: diagnostic.detail,
      })),
    );
  }
  for (const claim of claims.filter((item) => item.critical)) {
    if (!seen.has(key(claim.authoritySectionId, claim.statement))) {
      diagnostics.push({
        field: label(claim),
        detail: 'missing evidence-design entry for this critical claim',
      });
    }
  }
  return diagnostics;
}

/** Validate the Evidence Design block against accepted canonical claims. */
export function validateEvidenceDesign(input: {
  readonly planText: string;
  readonly claims: readonly PlanClaimDeclaration[];
  readonly verificationCandidates: readonly VerificationCandidate[];
}): EvidenceDesignValidation {
  const critical = input.claims.filter((claim) => claim.critical);
  const block = extractFencedBlock(input.planText, EVIDENCE_DESIGN_LANGUAGE);
  if (block.kind === 'missing') {
    return critical.length === 0
      ? { kind: 'ok' }
      : blocked(
          'PLAN_EVIDENCE_DESIGN_REQUIRED',
          `The plan declares ${critical.length} critical claim(s) but has no ${EVIDENCE_DESIGN_LANGUAGE} block.`,
          missingCritical(critical),
        );
  }
  const parsed = parseDesign(input.planText);
  if (parsed.kind === 'blocked') return parsed.result;
  const diagnostics = matchEntries(input.claims, parsed.design, input.verificationCandidates);
  return diagnostics.length === 0
    ? { kind: 'ok' }
    : blocked(
        'PLAN_EVIDENCE_DESIGN_INVALID',
        'The evidence design is structurally incomplete.',
        diagnostics,
      );
}
