/**
 * @module integration/plugin-orchestrator
 * @description Deterministic review subagent orchestration — extracted from plugin.ts.
 *
 * Invokes the flowguard-reviewer subagent via the OpenCode SDK client when a
 * FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED. Handles:
 * - Review obligation creation + audit
 * - Prompt building (plan, architecture, or impl)
 * - Subagent invocation
 * - Structured findings validation (P35 strict / non-strict)
 * - Evidence recording with reuse detection
 * - Output mutation (strict blocked or success)
 *
 * @version v1
 */

import { readState } from '../adapters/persistence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../state/evidence.js';
import type { CapturedFindings, SessionEnforcementState } from './review-enforcement.js';
import { recordPluginReview } from './review-enforcement.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  ensureReviewAssurance,
  hasEvidenceReuse,
  hashFindings,
  hashText,
} from './review-assurance.js';
import {
  isReviewRequired,
  extractReviewContext,
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  invokeReviewer,
  buildMutatedOutput,
  buildReviewContentPrompt,
  type OrchestratorClient,
} from './review-orchestrator.js';
import {
  getToolOutput,
  getToolArgs,
  parseToolResult,
  strictBlockedOutput,
} from './plugin-helpers.js';
import { loadExternalContent } from '../rails/review.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { updateObligation } from './plugin-review-state.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
} from './tool-names.js';
import { obligationTypeForTool } from './review-obligation-tools.js';
import { REVIEWER_SUBAGENT_TYPE } from './review-enforcement.js';
import type { ReviewSessionContext } from './plugin-workspace.js';
import type { SessionState } from '../state/schema.js';

/**
 * Dependency interface for closure-captured values in plugin.ts.
 */
export interface OrchestratorDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  client: unknown; // OpenCode SDK client
}

/**
 * Tool invocation captured by the plugin hook.
 *
 * Bundles the input and output from tool.execute.after
 * into a single object for cleaner function signatures.
 */
export interface ToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: { output: string };
  readonly sessionId: string;
  readonly now: string;
}

/**
 * Run the review orchestrator for a single tool invocation.
 */
export async function runReviewOrchestration(
  deps: OrchestratorDeps,
  event: ToolCallEvent,
): Promise<void> {
  const { toolName, input, output, sessionId, now } = event;

  const rawOutput = getToolOutput(output);
  let strictEnforcement: boolean | null = null;
  const inReviewPath = isReviewRequired(rawOutput, toolName);
  if (!inReviewPath) return;

  try {
    await deps.resolveFingerprint();
    const sessDir = deps.getSessionDir(sessionId);

    if (!sessDir) {
      output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        reason: 'session directory unavailable for strict review orchestration',
      });
      return;
    }
    const sessionState = await readState(sessDir);
    if (!sessionState) {
      output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        reason: 'session state unavailable for strict review orchestration',
      });
      return;
    }

    const parsedOutput = JSON.parse(rawOutput) as Record<string, unknown>;
    const reviewCtx = extractReviewContext(toolName, parsedOutput);
    if (!reviewCtx) {
      strictEnforcement = sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
      if (strictEnforcement) {
        output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
          reason: 'review context missing for strict orchestration',
        });
      }
      return;
    }

    // Host-orchestrated /review content analysis.
    // When flowguard_review blocks with CONTENT_ANALYSIS_REQUIRED, the
    // orchestrator loads external content, invokes the subagent, and injects
    // pluginReviewFindings so the agent can resubmit. If any step fails the
    // output is unchanged — the agent invokes the subagent manually.
    if (toolName === TOOL_FLOWGUARD_REVIEW) {
      strictEnforcement = sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
      const rawInput = input as Record<string, unknown>;
      const refInput = {
        text: typeof rawInput.text === 'string' ? rawInput.text : undefined,
        prNumber: typeof rawInput.prNumber === 'number' ? rawInput.prNumber : undefined,
        branch: typeof rawInput.branch === 'string' ? rawInput.branch : undefined,
        url: typeof rawInput.url === 'string' ? rawInput.url : undefined,
      };
      const contentResult = await loadExternalContent(refInput);
      const content = (contentResult as Record<string, unknown>).content;
      if (typeof content !== 'string') return;

      const prompt = buildReviewContentPrompt({
        content,
        ticketText: sessionState.ticket?.text ?? '',
        obligationId: reviewCtx.obligationId,
        mandateDigest: reviewCtx.mandateDigest,
        criteriaVersion: reviewCtx.criteriaVersion,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
      });

      const reviewerResult = await invokeReviewer(
        deps.client as OrchestratorClient,
        prompt,
        sessionId,
      );
      if (!reviewerResult?.findings) return;

      const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
      if (!parsedFindings.success) return;

      if (strictEnforcement) {
        const att = parsedFindings.data.attestation;
        if (!att) return;
        if (
          att.toolObligationId !== reviewCtx.obligationId ||
          att.mandateDigest !== reviewCtx.mandateDigest ||
          att.criteriaVersion !== reviewCtx.criteriaVersion ||
          att.reviewedBy !== REVIEWER_SUBAGENT_TYPE
        )
          return;

        const promptHash = hashText(prompt);
        const findingsHash = hashFindings(reviewerResult.findings);
        await deps.updateReviewAssurance(sessDir, (s) => {
          const assurance = ensureReviewAssurance(s.reviewAssurance);
          if (hasEvidenceReuse(assurance.invocations, reviewerResult.sessionId, findingsHash)) {
            return updateObligation(s, reviewCtx.obligationId, (item) => ({
              ...item,
              status: 'blocked',
              blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
            }));
          }
          const invocation = buildInvocationEvidence({
            obligationId: reviewCtx.obligationId,
            obligationType: 'review',
            parentSessionId: sessionId,
            childSessionId: reviewerResult.sessionId,
            promptHash,
            findingsHash,
            invokedAt: now,
            fulfilledAt: now,
            source: 'host-orchestrated',
          });
          assurance.invocations.push(invocation);
          return updateObligation(s, reviewCtx.obligationId, (item) => ({
            ...item,
            status: 'fulfilled',
            invocationId: invocation.invocationId,
            fulfilledAt: now,
          }));
        });
      }

      const mutated = buildMutatedOutput(rawOutput, reviewerResult);
      if (mutated) output.output = mutated;
      return;
    }

    const obligationType = obligationTypeForTool(toolName);
    if (!obligationType) {
      output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        reason: `unsupported reviewable tool for review orchestration: ${toolName}`,
      });
      deps.log.warn('orchestrator', 'unsupported reviewable tool — blocked', { tool: toolName });
      return;
    }

    strictEnforcement = sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;

    await deps.updateReviewAssurance(sessDir, (s, now2) =>
      updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        pluginHandshakeAt: now2,
      })),
    );
    await appendReviewAuditEvent(
      sessDir,
      sessionId,
      String(parsedOutput.phase ?? sessionState.phase),
      'review:obligation_created',
      {
        obligationId: reviewCtx.obligationId,
        obligationType,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
        criteriaVersion: reviewCtx.criteriaVersion,
        mandateDigest: reviewCtx.mandateDigest,
      },
    );

    const ticketText = sessionState.ticket?.text ?? '';
    const planText = sessionState.plan?.current?.body ?? '';
    const toolArgs = getToolArgs(input);

    // F13 slice 6: 3-way prompt selection by reviewable tool.
    // The previous 2-way ternary defaulted any non-PLAN tool to the
    // implementation prompt, which would have produced incorrect prompts
    // for the architecture tool once it routes through this orchestrator
    // (slice 7). The exhaustive switch surfaces unsupported tools as a
    // typed error at the bottom rather than silently picking impl.
    let prompt: string;
    if (toolName === TOOL_FLOWGUARD_PLAN) {
      prompt = buildPlanReviewPrompt({
        planText: typeof toolArgs.planText === 'string' ? toolArgs.planText : planText,
        ticketText,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
        obligationId: reviewCtx.obligationId,
        criteriaVersion: reviewCtx.criteriaVersion,
        mandateDigest: reviewCtx.mandateDigest,
      });
    } else if (toolName === TOOL_FLOWGUARD_IMPLEMENT) {
      prompt = buildImplReviewPrompt({
        changedFiles: Array.isArray(parsedOutput.changedFiles)
          ? (parsedOutput.changedFiles as string[])
          : (sessionState.implementation?.changedFiles ?? []),
        planText,
        ticketText,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
        obligationId: reviewCtx.obligationId,
        criteriaVersion: reviewCtx.criteriaVersion,
        mandateDigest: reviewCtx.mandateDigest,
      });
    } else if (toolName === TOOL_FLOWGUARD_ARCHITECTURE) {
      const adrText =
        typeof toolArgs.adrText === 'string'
          ? toolArgs.adrText
          : (sessionState.architecture?.adrText ?? '');
      const adrTitle =
        typeof toolArgs.title === 'string'
          ? toolArgs.title
          : (sessionState.architecture?.title ?? '');
      prompt = buildArchitectureReviewPrompt({
        adrText,
        adrTitle,
        ticketText,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
        obligationId: reviewCtx.obligationId,
        criteriaVersion: reviewCtx.criteriaVersion,
        mandateDigest: reviewCtx.mandateDigest,
      });
    } else {
      // Unreachable: orchestrator is only entered when isReviewRequired()
      // classified the tool as reviewable. Defensive fail-closed.
      deps.log.warn('orchestrator', 'unsupported reviewable tool — skipping', {
        tool: toolName,
      });
      return;
    }

    deps.log.info('orchestrator', 'invoking reviewer subagent', {
      tool: toolName,
      sessionId,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
    });

    const reviewerResult = await invokeReviewer(
      deps.client as OrchestratorClient,
      prompt,
      sessionId,
    );

    if (reviewerResult) {
      if (!reviewerResult.findings) {
        deps.log.warn(
          'orchestrator',
          'reviewer returned unparseable response — fallback to LLM-driven path',
          {
            tool: toolName,
            sessionId,
            childSessionId: reviewerResult.sessionId,
            rawResponseLength: reviewerResult.rawResponse.length,
          },
        );
        if (strictEnforcement) {
          await deps.blockReviewOutcome(
            { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
            reviewCtx.obligationId,
            'STRICT_REVIEW_ORCHESTRATION_FAILED',
            { reason: 'reviewer response was not parseable as ReviewFindings' },
            output,
          );
        }
      } else {
        const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
        if (!parsedFindings.success && strictEnforcement) {
          await deps.blockReviewOutcome(
            { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
            reviewCtx.obligationId,
            'STRICT_REVIEW_ORCHESTRATION_FAILED',
            { reason: 'reviewer response did not match ReviewFindings schema' },
            output,
          );
        }

        if (strictEnforcement && parsedFindings.success) {
          const att = parsedFindings.data.attestation;
          if (!att) {
            await deps.blockReviewOutcome(
              { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
              reviewCtx.obligationId,
              'SUBAGENT_MANDATE_MISSING',
              { obligationId: reviewCtx.obligationId },
              output,
            );
          } else if (
            parsedFindings.data.reviewMode !== 'subagent' ||
            att.toolObligationId !== reviewCtx.obligationId ||
            att.iteration !== reviewCtx.iteration ||
            att.planVersion !== reviewCtx.planVersion ||
            att.criteriaVersion !== REVIEW_CRITERIA_VERSION ||
            att.mandateDigest !== REVIEW_MANDATE_DIGEST
          ) {
            await deps.blockReviewOutcome(
              { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
              reviewCtx.obligationId,
              'SUBAGENT_MANDATE_MISMATCH',
              { obligationId: reviewCtx.obligationId },
              output,
            );
          } else if (parsedFindings.data.overallVerdict === 'unable_to_review') {
            // P1.3 slice 4c: subagent declared the artifact unreviewable.
            // The reviewer mandate has been satisfied (validity-conditions
            // whitelist enforces preconditions in templates/reviewer-agent),
            // but no convergence is possible. Per Decision C, the
            // obligation IS consumed (no retry path) and the tool output
            // is BLOCKED so that downstream automation cannot fabricate a
            // converged artifact from an unreviewable verdict. SSOT reason
            // SUBAGENT_UNABLE_TO_REVIEW (registered in slice 2) carries
            // the operator-facing copy and recovery guidance.
            await deps.blockReviewOutcome(
              { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
              reviewCtx.obligationId,
              'SUBAGENT_UNABLE_TO_REVIEW',
              { obligationId: reviewCtx.obligationId },
              output,
            );
          }
        }

        const strictGateResult = parseToolResult(output.output);
        if (strictEnforcement && strictGateResult?.error === true) {
          return;
        }

        const mutated = buildMutatedOutput(rawOutput, reviewerResult);

        if (mutated) {
          if (strictEnforcement && parsedFindings.success) {
            const promptHash = hashText(prompt);
            const findingsHash = hashFindings(reviewerResult.findings);
            let reusedEvidence = false;
            await deps.updateReviewAssurance(sessDir, (s, now2) => {
              const assurance = ensureReviewAssurance(s.reviewAssurance);
              if (hasEvidenceReuse(assurance.invocations, reviewerResult.sessionId, findingsHash)) {
                reusedEvidence = true;
                return updateObligation(s, reviewCtx.obligationId, (item) => ({
                  ...item,
                  status: 'blocked',
                  blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
                }));
              }

              const invocation = buildInvocationEvidence({
                obligationId: reviewCtx.obligationId,
                obligationType,
                parentSessionId: sessionId,
                childSessionId: reviewerResult.sessionId,
                promptHash,
                findingsHash,
                invokedAt: now2,
                fulfilledAt: now2,
              });
              assurance.invocations.push(invocation);
              return updateObligation(s, reviewCtx.obligationId, (item) => ({
                ...item,
                status: 'fulfilled',
                invocationId: invocation.invocationId,
                fulfilledAt: now2,
              }));
            });
            await appendReviewAuditEvent(
              sessDir,
              sessionId,
              String(parsedOutput.phase ?? sessionState.phase),
              reusedEvidence ? 'review:obligation_blocked' : 'review:subagent_invoked',
              reusedEvidence
                ? {
                    obligationId: reviewCtx.obligationId,
                    code: 'SUBAGENT_EVIDENCE_REUSED',
                  }
                : {
                    obligationId: reviewCtx.obligationId,
                    obligationType,
                    parentSessionId: sessionId,
                    childSessionId: reviewerResult.sessionId,
                    agentType: REVIEWER_SUBAGENT_TYPE,
                    promptHash,
                    mandateDigest: REVIEW_MANDATE_DIGEST,
                    criteriaVersion: REVIEW_CRITERIA_VERSION,
                    findingsHash,
                  },
            );
            if (!reusedEvidence) {
              await appendReviewAuditEvent(
                sessDir,
                sessionId,
                String(parsedOutput.phase ?? sessionState.phase),
                'review:obligation_fulfilled',
                {
                  obligationId: reviewCtx.obligationId,
                  childSessionId: reviewerResult.sessionId,
                },
              );
            }
            if (reusedEvidence) {
              output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
                obligationId: reviewCtx.obligationId,
              });
              return;
            }
          }

          const eState = deps.getEnforcementState(sessionId);
          const captured: CapturedFindings = {
            overallVerdict:
              typeof reviewerResult.findings.overallVerdict === 'string'
                ? reviewerResult.findings.overallVerdict
                : 'unknown',
            blockingIssuesCount: Array.isArray(reviewerResult.findings.blockingIssues)
              ? reviewerResult.findings.blockingIssues.length
              : 0,
            sessionId: reviewerResult.sessionId,
          };

          recordPluginReview(eState, toolName, reviewerResult.sessionId, captured, now);

          output.output = mutated;

          deps.log.info('orchestrator', 'reviewer invocation succeeded', {
            tool: toolName,
            sessionId,
            childSessionId: reviewerResult.sessionId,
            verdict: reviewerResult.findings.overallVerdict,
          });
        } else {
          deps.log.warn('orchestrator', 'output mutation failed (fallback to LLM-driven)', {
            tool: toolName,
            sessionId,
          });
          if (strictEnforcement) {
            output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
              reason: 'output mutation failed',
            });
          }
        }
      }
    } else {
      deps.log.warn('orchestrator', 'reviewer invocation failed (fallback to LLM-driven)', {
        tool: toolName,
        sessionId,
      });
      if (strictEnforcement) {
        await deps.blockReviewOutcome(
          { sessDir, sessionId, phase: String(parsedOutput.phase ?? sessionState.phase) },
          reviewCtx.obligationId,
          'STRICT_REVIEW_ORCHESTRATION_FAILED',
          { reason: 'reviewer invocation failed' },
          output,
        );
      }
    }
  } catch (err) {
    if (inReviewPath && strictEnforcement !== false) {
      output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
        reason: 'reviewer orchestration threw an exception',
      });
      deps.log.warn('audit', 'review orchestration failed (strict mode blocked)', {
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      deps.log.warn('audit', 'review orchestration failed (fallback to LLM-driven)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
