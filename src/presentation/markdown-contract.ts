/**
 * @module presentation/markdown-contract
 * @description Semantic language contract for PresentationDocument documents.
 *
 * Validation runs before any Markdown is emitted: a document that violates the
 * form/conclusion contract throws instead of rendering a misleading card.
 *
 * @version v1
 */

import { PresentationContractError } from './model.js';
import type { PresentationAction, PresentationConclusion, PresentationDocument } from './model.js';

/** Enforce the semantic language contract before any Markdown is emitted. */
export function validateDocumentContract(document: PresentationDocument): void {
  validateTitleContract(document);
  if (!('form' in document) || document.form === undefined) return;
  if (!document.conclusion) {
    throw new PresentationContractError(
      `PresentationDocument: ${document.form} form requires exactly one conclusion`,
    );
  }

  const conclusion = document.conclusion;
  const hasBlocker = document.sections.some((section) => section.kind === 'blocker');
  switch (document.form) {
    case 'success':
      return validateSuccessForm(conclusion, hasBlocker);
    case 'blocked':
      return validateBlockedForm(conclusion, hasBlocker);
    case 'decision':
      return validateDecisionForm(conclusion);
    case 'review_pending':
      return validateReviewPendingForm(conclusion);
    case 'terminal':
      return validateTerminalForm(conclusion);
    case 'diagnostic':
      return validateDiagnosticForm(conclusion, hasBlocker);
  }
}

function validateTitleContract(document: PresentationDocument): void {
  const titles = document.sections.filter((section) => section.kind === 'title');
  if (titles.length > 1) {
    throw new PresentationContractError(
      'PresentationDocument: at most one TitleSection is allowed',
    );
  }
  if (titles.length === 1 && document.sections[0]?.kind !== 'title') {
    throw new PresentationContractError('PresentationDocument: TitleSection must be first');
  }
  if (document.kind === 'compact_card' && titles.length > 0) {
    throw new PresentationContractError('CompactCardDocument: TitleSection is not allowed');
  }
}

function validateSuccessForm(conclusion: PresentationConclusion, hasBlocker: boolean): void {
  if (hasBlocker || conclusion.kind !== 'next_action') {
    throw new PresentationContractError(
      'success form requires a next_action conclusion and no blocker',
    );
  }
  validateRecommendedAction(conclusion.action);
}

function validateBlockedForm(conclusion: PresentationConclusion, hasBlocker: boolean): void {
  if (
    !hasBlocker ||
    (conclusion.kind !== 'next_action' &&
      conclusion.kind !== 'recovery' &&
      conclusion.kind !== 'terminal')
  ) {
    throw new PresentationContractError(
      'blocked form requires a blocker and a next_action, recovery, or terminal conclusion',
    );
  }
  if (conclusion.kind === 'next_action') validateRecommendedAction(conclusion.action);
  if (conclusion.kind === 'recovery') validateRecoveryConclusion(conclusion);
}

function validateDecisionForm(conclusion: PresentationConclusion): void {
  if (conclusion.kind !== 'decision_required' || conclusion.actions.length === 0) {
    throw new PresentationContractError(
      'decision form requires non-empty decision_required actions',
    );
  }
  for (const action of conclusion.actions) {
    if (action.visibility !== 'available') {
      throw new PresentationContractError(
        'decision_required actions must be available, not recommended',
      );
    }
  }
}

function validateReviewPendingForm(conclusion: PresentationConclusion): void {
  if (conclusion.kind !== 'review_pending') {
    throw new PresentationContractError('review_pending form requires a review_pending conclusion');
  }
}

function validateTerminalForm(conclusion: PresentationConclusion): void {
  if (conclusion.kind !== 'terminal') {
    throw new PresentationContractError('terminal form requires a terminal conclusion');
  }
}

function validateDiagnosticForm(conclusion: PresentationConclusion, hasBlocker: boolean): void {
  if (!hasBlocker || conclusion.kind !== 'recovery') {
    throw new PresentationContractError(
      'diagnostic form requires a blocker and recovery conclusion',
    );
  }
  validateRecoveryConclusion(conclusion);
}

function validateRecommendedAction(action: PresentationAction): void {
  if (action.visibility !== 'recommended') {
    throw new PresentationContractError('next_action conclusion must contain a recommended action');
  }
}

/** Validate a recovery conclusion before rendering it. */
export function validateRecoveryConclusion(
  conclusion: Extract<PresentationConclusion, { kind: 'recovery' }>,
): void {
  if (conclusion.message.trim().length === 0 || conclusion.steps.length === 0) {
    throw new PresentationContractError(
      'recovery conclusion requires a message and at least one step',
    );
  }
  if (conclusion.steps.some((step) => step.trim().length === 0)) {
    throw new PresentationContractError('recovery conclusion steps must not be empty');
  }
}
