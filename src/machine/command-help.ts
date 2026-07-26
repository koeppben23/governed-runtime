/**
 * @module command-help
 * @description Presentation-only help copy for machine lifecycle commands.
 */

import { Command } from './commands.js';

export interface CommandHelpEntry {
  readonly label: string;
  readonly description: string;
  readonly does: readonly [string, ...string[]];
  readonly doesNot: readonly [string, ...string[]];
  readonly examples: readonly [string, ...string[]];
  readonly presentationGroup: 'start' | 'work' | 'review' | 'verify' | 'recovery';
  readonly displayOrder: number;
}

export const COMMAND_HELP: Record<Command, CommandHelpEntry> = {
  [Command.HYDRATE]: {
    label: 'Start session',
    description: 'Prepare or restore a governed session.',
    does: ['Creates or refreshes the session context.'],
    doesNot: ['Select a workflow.'],
    examples: ['/hydrate'],
    presentationGroup: 'start',
    displayOrder: 10,
  },
  [Command.TICKET]: {
    label: 'Capture task',
    description: 'Record the task that the workflow will govern.',
    does: ['Captures task scope and context.'],
    doesNot: ['Approve an implementation plan.'],
    examples: ['/task Add audit logging'],
    presentationGroup: 'start',
    displayOrder: 20,
  },
  [Command.PLAN]: {
    label: 'Plan work',
    description: 'Create or revise the implementation plan.',
    does: ['Records a plan for independent review.'],
    doesNot: ['Modify implementation files.'],
    examples: ['/plan'],
    presentationGroup: 'work',
    displayOrder: 30,
  },
  [Command.CONTINUE]: {
    label: 'Continue workflow',
    description: 'Route to the next workflow step.',
    does: ['Returns phase-specific guidance.'],
    doesNot: ['Choose a review decision.'],
    examples: ['/continue'],
    presentationGroup: 'work',
    displayOrder: 40,
  },
  [Command.IMPLEMENT]: {
    label: 'Implement plan',
    description: 'Record implementation evidence for the approved plan.',
    does: ['Captures completed implementation evidence.'],
    doesNot: ['Approve the final review.'],
    examples: ['/implement'],
    presentationGroup: 'work',
    displayOrder: 50,
  },
  [Command.RESOLVE_IMPLEMENTATION_CHALLENGE]: {
    label: 'Record challenge resolution',
    description: 'Record advisory validation evidence for one implementation challenge.',
    does: ['Binds one prior implementation challenge to current validation attempts.'],
    doesNot: ['Approve the implementation or change review acceptance.'],
    examples: ['/resolve-implementation-challenge'],
    presentationGroup: 'review',
    displayOrder: 55,
  },
  [Command.REVIEW_DECISION]: {
    label: 'Decide review gate',
    description: 'Record the human decision at a review gate.',
    does: ['Accepts, requests changes, or rejects the reviewed work.'],
    doesNot: ['Perform the independent review.'],
    examples: ['/approve'],
    presentationGroup: 'review',
    displayOrder: 60,
  },
  [Command.VALIDATE]: {
    label: 'Run checks',
    description: 'Record required verification results.',
    does: ['Runs and records verification evidence.'],
    doesNot: ['Change the reviewed plan.'],
    examples: ['/check'],
    presentationGroup: 'verify',
    displayOrder: 70,
  },
  [Command.REVIEW]: {
    label: 'Review content',
    description: 'Start a standalone compliance review.',
    does: ['Creates a review report.'],
    doesNot: ['Create an audit package.'],
    examples: ['/review'],
    presentationGroup: 'review',
    displayOrder: 80,
  },
  [Command.ARCHITECTURE]: {
    label: 'Create ADR',
    description: 'Create or revise an architecture decision record.',
    does: ['Records an ADR for review.'],
    doesNot: ['Select the development workflow.'],
    examples: ['/architecture'],
    presentationGroup: 'review',
    displayOrder: 90,
  },
  [Command.ABORT]: {
    label: 'Abort session',
    description: 'End the current workflow without presenting it as completed.',
    does: ['Preserves the aborted audit trail.'],
    doesNot: ['Create an exportable audit package.'],
    examples: ['/abort'],
    presentationGroup: 'recovery',
    displayOrder: 100,
  },
};
