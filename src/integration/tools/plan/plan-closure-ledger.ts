/**
 * @module integration/tools/plan/plan-closure-ledger
 * @description Structural author-response and claim-lineage contracts.
 *
 * The ledger proves only that the author answered every bound blocking finding
 * and documented every change to a prior critical claim. It never proves that a
 * finding is resolved, that a replacement preserves the requirement, or that a
 * withdrawal is ticket-compliant. Those remain independent-review judgments.
 */

import { z } from 'zod';
import { parseStrictJsonObject } from '../../../shared/strict-json-object.js';
import {
  mintProofGraphClaimId,
  normalizeClaimStatement,
  type PlanClaimDeclaration,
} from '../../../state/proofgraph-approval.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import { extractFencedBlock } from './plan-fenced-block.js';
import type { PlanPreflightDiagnostic } from './plan-evidence-design.js';

export const FINDING_RESOLUTIONS_LANGUAGE = 'flowguard-finding-resolutions';
export const CLAIM_CHANGES_LANGUAGE = 'flowguard-claim-changes';

const FindingResolution = z
  .object({
    findingId: z.string().uuid(),
    planSection: z.string().min(1),
    response: z.string().min(1),
  })
  .strict()
  .readonly();

const FindingResolutions = z
  .object({
    version: z.literal(1),
    reviewObligationId: z.string().uuid(),
    reviewIteration: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    resolutions: z.array(FindingResolution),
  })
  .strict()
  .readonly();

const ReplacementClaim = z
  .object({
    authoritySectionId: z.string().min(1),
    statement: z.string().min(1),
  })
  .strict()
  .readonly();

const ClaimChange = z.discriminatedUnion('disposition', [
  z
    .object({ priorClaimId: z.string().uuid(), disposition: z.literal('retained') })
    .strict()
    .readonly(),
  z
    .object({
      priorClaimId: z.string().uuid(),
      disposition: z.literal('replaced'),
      replacementClaims: z.array(ReplacementClaim).min(1),
      rationale: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      priorClaimId: z.string().uuid(),
      disposition: z.literal('withdrawn'),
      rationale: z.string().min(1),
    })
    .strict()
    .readonly(),
]);

const ClaimChanges = z
  .object({ version: z.literal(1), claimChanges: z.array(ClaimChange) })
  .strict()
  .readonly();

type FindingLedger = z.infer<typeof FindingResolutions>;
type ClaimLedger = z.infer<typeof ClaimChanges>;
type ClaimEntry = z.infer<typeof ClaimChange>;

export type ClosureValidation =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'blocked';
      readonly code:
        | 'PLAN_REVIEW_FEEDBACK_UNAVAILABLE'
        | 'PLAN_FINDING_RESOLUTION_REQUIRED'
        | 'PLAN_FINDING_RESOLUTION_INVALID'
        | 'PLAN_CLAIM_LINEAGE_REQUIRED'
        | 'PLAN_CLAIM_LINEAGE_INVALID'
        | 'PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN';
      readonly reason: string;
      readonly diagnostics: readonly PlanPreflightDiagnostic[];
    };

type Parse<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked'; readonly result: ClosureValidation };

function blocked(
  code: Extract<ClosureValidation, { kind: 'blocked' }>['code'],
  reason: string,
  diagnostics: readonly PlanPreflightDiagnostic[],
): ClosureValidation {
  return { kind: 'blocked', code, reason, diagnostics };
}

function schemaDiagnostics(issues: readonly z.ZodIssue[]): readonly PlanPreflightDiagnostic[] {
  return issues.slice(0, 8).map((issue) => ({
    field: issue.path.join('.'),
    detail: issue.message,
  }));
}

function parseLedger<T>(
  planText: string,
  language: string,
  schema: z.ZodType<T>,
  invalidCode: 'PLAN_FINDING_RESOLUTION_INVALID' | 'PLAN_CLAIM_LINEAGE_INVALID',
): Parse<T> {
  const block = extractFencedBlock(planText, language);
  if (block.kind === 'missing') return { kind: 'missing' };
  if (block.kind !== 'ok') {
    return {
      kind: 'blocked',
      result: blocked(invalidCode, `The ${language} block is ${block.kind}.`, [
        { field: language, detail: `block is ${block.kind}` },
      ]),
    };
  }
  const decoded = parseStrictJsonObject(block.content);
  if (decoded.kind !== 'ok') {
    return {
      kind: 'blocked',
      result: blocked(invalidCode, decoded.reason, [{ field: language, detail: decoded.reason }]),
    };
  }
  const parsed = schema.safeParse(decoded.value);
  if (!parsed.success) {
    return {
      kind: 'blocked',
      result: blocked(
        invalidCode,
        `The ${language} payload violates its strict schema.`,
        schemaDiagnostics(parsed.error.issues),
      ),
    };
  }
  return { kind: 'ok', value: parsed.data };
}

function missingFindingResponses(
  findings: readonly ReviewFindings['blockingIssues'][number][],
): readonly PlanPreflightDiagnostic[] {
  return findings.map((finding) => ({
    field: `resolutions[${finding.findingId ?? 'missing'}]`,
    detail: 'missing author response for this blocking finding',
  }));
}

function findingBindingDiagnostics(
  ledger: FindingLedger,
  obligation: {
    readonly obligationId: string;
    readonly iteration: number;
    readonly planVersion: number;
  },
): readonly PlanPreflightDiagnostic[] {
  if (
    ledger.reviewObligationId === obligation.obligationId &&
    ledger.reviewIteration === obligation.iteration &&
    ledger.planVersion === obligation.planVersion
  ) {
    return [];
  }
  return [
    {
      field: 'reviewObligationId/reviewIteration/planVersion',
      detail: `expected '${obligation.obligationId}', iteration ${obligation.iteration}, planVersion ${obligation.planVersion}`,
    },
  ];
}

function findingCoverageDiagnostics(
  ledger: FindingLedger,
  findings: readonly ReviewFindings['blockingIssues'][number][],
): readonly PlanPreflightDiagnostic[] {
  const expected = new Set(findings.map((finding) => finding.findingId));
  const seen = new Set<string>();
  const diagnostics: PlanPreflightDiagnostic[] = [];
  for (const resolution of ledger.resolutions) {
    if (!expected.has(resolution.findingId)) {
      diagnostics.push({
        field: `resolutions[${resolution.findingId}]`,
        detail: 'resolution references a finding outside this review obligation',
      });
    } else if (seen.has(resolution.findingId)) {
      diagnostics.push({
        field: `resolutions[${resolution.findingId}]`,
        detail: 'duplicate resolution for the same finding',
      });
    }
    seen.add(resolution.findingId);
  }
  for (const finding of findings) {
    if (finding.findingId !== undefined && !seen.has(finding.findingId)) {
      diagnostics.push({
        field: `resolutions[${finding.findingId}]`,
        detail: 'missing author response for this blocking finding',
      });
    }
  }
  return diagnostics;
}

/** Validate that every bound blocking finding received an author response. */
export function validateFindingResolutions(input: {
  readonly planText: string;
  readonly findings: readonly ReviewFindings['blockingIssues'][number][];
  readonly obligation: {
    readonly obligationId: string;
    readonly iteration: number;
    readonly planVersion: number;
  };
}): ClosureValidation {
  if (input.findings.length === 0) return { kind: 'ok' };
  const withoutId = input.findings.filter((finding) => finding.findingId === undefined);
  if (withoutId.length > 0) {
    return blocked(
      'PLAN_REVIEW_FEEDBACK_UNAVAILABLE',
      'The bound review findings do not carry host-minted identities.',
      withoutId.map((finding) => ({
        field: 'reviewFeedback.blockingIssues',
        detail: `finding '${finding.message.slice(0, 120)}' has no findingId`,
      })),
    );
  }
  const parsed = parseLedger<FindingLedger>(
    input.planText,
    FINDING_RESOLUTIONS_LANGUAGE,
    FindingResolutions,
    'PLAN_FINDING_RESOLUTION_INVALID',
  );
  if (parsed.kind === 'missing') {
    return blocked(
      'PLAN_FINDING_RESOLUTION_REQUIRED',
      `The revision answers no prior blocking findings in a ${FINDING_RESOLUTIONS_LANGUAGE} block.`,
      missingFindingResponses(input.findings),
    );
  }
  if (parsed.kind === 'blocked') return parsed.result;
  const diagnostics = [
    ...findingBindingDiagnostics(parsed.value, input.obligation),
    ...findingCoverageDiagnostics(parsed.value, input.findings),
  ];
  return diagnostics.length === 0
    ? { kind: 'ok' }
    : blocked(
        'PLAN_FINDING_RESOLUTION_INVALID',
        'The finding-resolution set does not exactly cover the bound blocking findings.',
        diagnostics,
      );
}

function claimKey(authoritySectionId: string, statement: string): string {
  return `${authoritySectionId}\u001f${normalizeClaimStatement(statement)}`;
}

function replacementId(entry: z.infer<typeof ReplacementClaim>): string {
  return mintProofGraphClaimId({
    domain: 'plan',
    authoritySectionId: entry.authoritySectionId,
    statement: entry.statement,
  });
}

function downgradeCheck(
  priorCritical: readonly PlanClaimDeclaration[],
  currentById: ReadonlyMap<string, PlanClaimDeclaration>,
): ClosureValidation | null {
  for (const prior of priorCritical) {
    const current = currentById.get(prior.claimId);
    if (current && !current.critical) {
      return blocked(
        'PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN',
        `Critical claim '${prior.claimId}' remains present with critical: false.`,
        [
          {
            field: `claims[${prior.claimId}].critical`,
            detail: 'remove the claim and declare it withdrawn, or keep it critical',
          },
        ],
      );
    }
  }
  return null;
}

function changeEntryDiagnostics(
  ledger: ClaimLedger,
  priorById: ReadonlyMap<string, PlanClaimDeclaration>,
  currentById: ReadonlyMap<string, PlanClaimDeclaration>,
): readonly PlanPreflightDiagnostic[] {
  const diagnostics: PlanPreflightDiagnostic[] = [];
  const seen = new Set<string>();
  for (const change of ledger.claimChanges) {
    const prior = priorById.get(change.priorClaimId);
    if (!prior || !prior.critical) {
      diagnostics.push({
        field: `claimChanges[${change.priorClaimId}]`,
        detail: 'claimChanges may reference only a prior critical claim',
      });
      continue;
    }
    if (seen.has(change.priorClaimId)) {
      diagnostics.push({
        field: `claimChanges[${change.priorClaimId}]`,
        detail: 'duplicate claim-change entry',
      });
      continue;
    }
    seen.add(change.priorClaimId);
    diagnostics.push(...changeSpecificDiagnostics(change, currentById));
  }
  return diagnostics;
}

function changeSpecificDiagnostics(
  change: ClaimEntry,
  currentById: ReadonlyMap<string, PlanClaimDeclaration>,
): readonly PlanPreflightDiagnostic[] {
  const current = currentById.get(change.priorClaimId);
  if (change.disposition === 'retained') {
    return !current || !current.critical
      ? [
          {
            field: `claimChanges[${change.priorClaimId}]`,
            detail: 'retained requires the same claim identity to remain critical',
          },
        ]
      : [];
  }
  if (change.disposition === 'withdrawn') {
    return current
      ? [
          {
            field: `claimChanges[${change.priorClaimId}]`,
            detail:
              'withdrawn requires the prior claim identity to be absent from the new claim set',
          },
        ]
      : [];
  }
  if (current) {
    return [
      {
        field: `claimChanges[${change.priorClaimId}]`,
        detail: 'replaced requires the prior claim identity to be absent from the new claim set',
      },
    ];
  }
  return change.replacementClaims.flatMap((replacement) => {
    const id = replacementId(replacement);
    const claim = currentById.get(id);
    return claim?.critical
      ? []
      : [
          {
            field: `claimChanges[${change.priorClaimId}].replacementClaims[${claimKey(replacement.authoritySectionId, replacement.statement)}]`,
            detail: 'replacement must resolve to an accepted critical claim',
          },
        ];
  });
}

function coverageDiagnostics(
  priorCritical: readonly PlanClaimDeclaration[],
  ledger: ClaimLedger,
  currentById: ReadonlyMap<string, PlanClaimDeclaration>,
): readonly PlanPreflightDiagnostic[] {
  const diagnostics: PlanPreflightDiagnostic[] = [];
  for (const prior of priorCritical) {
    if (currentById.has(prior.claimId)) continue;
    const change = ledger.claimChanges.find((item) => item.priorClaimId === prior.claimId);
    if (!change) {
      diagnostics.push({
        field: `claimChanges[${prior.claimId}]`,
        detail: 'missing retained/replaced/withdrawn declaration for this prior critical claim',
      });
    } else if (change.disposition === 'retained') {
      diagnostics.push({
        field: `claimChanges[${prior.claimId}]`,
        detail: 'retained declared but the prior claim identity is absent',
      });
    }
  }
  return diagnostics;
}

/** Validate claim lineage and criticality preservation for a new plan version. */
export function validateClaimChanges(input: {
  readonly planText: string;
  readonly priorClaims: readonly PlanClaimDeclaration[];
  readonly currentClaims: readonly PlanClaimDeclaration[];
}): ClosureValidation {
  const priorCritical = input.priorClaims.filter((claim) => claim.critical);
  if (priorCritical.length === 0) return { kind: 'ok' };
  const currentById = new Map(input.currentClaims.map((claim) => [claim.claimId, claim]));
  const downgrade = downgradeCheck(priorCritical, currentById);
  if (downgrade !== null) return downgrade;

  const parsed = parseLedger<ClaimLedger>(
    input.planText,
    CLAIM_CHANGES_LANGUAGE,
    ClaimChanges,
    'PLAN_CLAIM_LINEAGE_INVALID',
  );
  if (parsed.kind === 'missing') {
    const changed = priorCritical.filter((claim) => !currentById.has(claim.claimId));
    return changed.length === 0
      ? { kind: 'ok' }
      : blocked(
          'PLAN_CLAIM_LINEAGE_REQUIRED',
          `The revision changes ${changed.length} prior critical claim(s) without a ${CLAIM_CHANGES_LANGUAGE} block.`,
          changed.map((claim) => ({
            field: `claimChanges[${claim.claimId}]`,
            detail: 'missing retained/replaced/withdrawn declaration for this prior critical claim',
          })),
        );
  }
  if (parsed.kind === 'blocked') return parsed.result;
  const priorById = new Map(input.priorClaims.map((claim) => [claim.claimId, claim]));
  const diagnostics = [
    ...changeEntryDiagnostics(parsed.value, priorById, currentById),
    ...coverageDiagnostics(priorCritical, parsed.value, currentById),
  ];
  return diagnostics.length === 0
    ? { kind: 'ok' }
    : blocked(
        'PLAN_CLAIM_LINEAGE_INVALID',
        'The claim-change set does not cover the prior critical claims.',
        diagnostics,
      );
}
