/**
 * @module integration/plugin
 * @description OpenCode Plugin that creates structured, hash-chained audit events
 * for all FlowGuard tool calls and state transitions.
 *
 * Policy-aware emission:
 * - Actor classification via policy.actorClassification (not hardcoded)
 * - Conditional tool_call emission via policy.audit.emitToolCalls
 * - Conditional transition emission via policy.audit.emitTransitions
 * - Conditional hash chaining via policy.audit.enableChainHash
 * - Lifecycle and error events are always emitted (structural, not operational)
 *
 * Workspace-aware:
 * - Resolves workspace fingerprint from worktree at plugin init
 * - Reads config from workspace directory (workspace registry)
 * - All audit files live under session directory in workspace registry
 *
 * Logging:
 * - Plugin is the ONLY OpenCode logger writer (via client.app.log)
 * - Logger is created at plugin init from config + client sink
 * - Tools and rails do NOT log — plugin logs around them
 *
 * On each FlowGuard tool execution:
 * 1. Reads session state to resolve the governing policy
 * 2. Parses the tool result JSON to extract phase, transitions, and status
 * 3. Creates a tool_call audit event if policy.audit.emitToolCalls
 * 4. Creates transition audit events for each state transition if policy.audit.emitTransitions
 * 5. Creates lifecycle events for session creation, completion, and abortion (always)
 * 6. Hash-chains events for tamper detection if policy.audit.enableChainHash
 * 7. Appends all emitted events to {sessionDir}/audit.jsonl
 *
 * Design:
 * - Fire-and-forget: audit failures are logged but never block the workflow.
 *   FlowGuard correctness does not depend on audit success.
 * - The plugin closure captures `worktree` and caches `lastHash` for chaining.
 * - Only FlowGuard tools (name starting with "flowguard_") are audited.
 * - Hash chain is initialized by reading the last event from the trail on first call.
 * - Policy is resolved from session state (read from persistence after tool executes).
 *   Falls back to config.policy.defaultMode > solo if state is unavailable (P32).
 *
 * Auto-archive:
 * - On session completion (COMPLETE phase transition), automatically archives the session
 *   as a tar.gz file. Fire-and-forget — archive failure never blocks.
 *
 * Installation:
 * This module lives inside @flowguard/core. The thin wrapper in
 * ~/.config/opencode/plugins/flowguard-audit.ts (or .opencode/plugins/)
 * re-exports FlowGuardAuditPlugin for OpenCode to discover.
 *
 * Plugin API (verified against OpenCode docs Apr 14, 2026):
 * - Plugin is an async function receiving { project, client, $, directory, worktree }
 * - Returns an object with event hook implementations
 * - Type: Plugin from "@opencode-ai/plugin"
 *
 * Deterministic review orchestration (v7):
 * When a FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED and
 * policy.selfReview.subagentEnabled is true, the plugin programmatically
 * invokes the flowguard-reviewer subagent via the SDK client:
 * 1. Detects INDEPENDENT_REVIEW_REQUIRED in tool.execute.after
 * 2. Reads session state for ticket/plan context
 * 3. Creates a child session via client.session.create()
 * 4. Sends structured prompt to flowguard-reviewer via client.session.prompt()
 * 5. Parses ReviewFindings from the response
 * 6. Mutates output.output to inject findings (INDEPENDENT_REVIEW_COMPLETED)
 * 7. Updates enforcement state to satisfy L1/L2/L4 checks
 *
 * On failure: graceful degradation — original output preserved, LLM follows
 * the probabilistic path via Task tool. Unparseable reviewer responses are
 * treated as failure (fail-closed) — only structured ReviewFindings trigger
 * the COMPLETED path.
 *
 * @version v7
 */

import type { Plugin } from '@opencode-ai/plugin';
import {
  readState,
  writeState,
  appendAuditEvent,
  readAuditTrail,
} from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
  archiveSession,
} from '../adapters/workspace/index.js';
import {
  createToolCallEvent,
  createTransitionEvent,
  createLifecycleEvent,
  createErrorEvent,
  createDecisionEvent,
  summarizeArgs,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from '../audit/types.js';
import { decisionReceipts } from '../audit/query.js';
import { getLastChainHash } from '../audit/integrity.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { createPluginLogger } from './plugin-logging.js';
import { parseToolResult, strictBlockedOutput, getToolOutput, getToolArgs } from './plugin-helpers.js';
import {
  trackFlowGuardEnforcement,
  trackTaskEnforcement,
} from './plugin-enforcement-tracking.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { Phase, Event } from '../state/schema.js';
import type { SessionState } from '../state/schema.js';
import { ReviewFindings as ReviewFindingsSchema } from '../state/evidence.js';

// Review enforcement — runtime gate for subagent invocation
import {
  createSessionState as createEnforcementState,
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  recordPluginReview,
  REVIEWER_SUBAGENT_TYPE,
  type SessionEnforcementState,
  type CapturedFindings,
} from './review-enforcement.js';

// Review orchestrator — deterministic subagent invocation via SDK
import {
  isReviewRequired,
  extractReviewContext,
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  invokeReviewer,
  buildMutatedOutput,
  type OrchestratorClient,
} from './review-orchestrator.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  ensureReviewAssurance,
  hashFindings,
  hashText,
  hasEvidenceReuse,
} from './review-assurance.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_ABORT,
} from './tool-names.js';

/** FlowGuard tool name prefix. Only tools with this prefix are audited. */
const FG_PREFIX = 'flowguard_';

/**
 * Map tool names to lifecycle actions.
 * Tools that produce lifecycle events beyond the regular tool_call event.
 */
const LIFECYCLE_TOOLS: Record<string, string> = {
  [TOOL_FLOWGUARD_HYDRATE]: 'session_created',
  [TOOL_FLOWGUARD_ABORT]: 'session_aborted',
};

/**
 * FlowGuard Audit Plugin.
 *
 * Captures worktree from plugin context at initialization time.
 * Maintains a hash chain cache for efficient chaining without re-reading the trail.
 * Hooks tool.execute.after to append structured audit events for FlowGuard tools.
 * Hooks tool.execute.before to enforce subagent invocation for independent review.
 *
 * Policy-aware: reads session state to resolve audit emission controls and
 * actor classification per tool invocation.
 */
export const FlowGuardAuditPlugin: Plugin = async ({ client, directory, worktree }) => {
  // Capture worktree from plugin context (project-level, stable)
  const auditWorktree = worktree || directory;

  // ── Workspace resolution ────────────────────────────────────────────────
  // Resolve fingerprint + workspace directory at plugin init (once, stable).
  // Session directory varies per tool call (uses sessionID from tool context).
  let cachedFingerprint: string | null = null;
  let cachedWsDir: string | null = null;

  async function resolveFingerprint(): Promise<string | null> {
    if (cachedFingerprint) return cachedFingerprint;
    if (!auditWorktree) return null;
    try {
      const result = await computeFingerprint(auditWorktree);
      cachedFingerprint = result.fingerprint;
      cachedWsDir = resolveWorkspaceDir(result.fingerprint);
      return cachedFingerprint;
    } catch {
      return null;
    }
  }

  function getSessionDir(sessionId: string): string | null {
    if (!cachedFingerprint) return null;
    try {
      return resolveSessionDir(cachedFingerprint, sessionId);
    } catch {
      return null;
    }
  }

  // ── Config + Logger initialization ──────────────────────────────────────
  // Resolved via plugin-logging.ts from workspace config. Falls back to defaults.
  // resolveFingerprint may fail — do not block plugin startup.
  try {
    await resolveFingerprint();
  } catch {
    // logging init fallback only; do not block plugin startup
  }
  const { log, config } = await createPluginLogger(client, cachedWsDir, auditWorktree, cachedFingerprint);

  // Hash chain state — cached in closure, initialized on first audit call.
  // Only updated when policy.audit.enableChainHash is true.
  let lastHash: string | null = null;
  let chainInitialized = false;
  const sessionQueues = new Map<string, Promise<void>>();
  const decisionSequenceCache = new Map<string, number>();

  // ── Review enforcement state (per session) ──────────────────────────────
  // Tracks INDEPENDENT_REVIEW_REQUIRED signals and Task calls to
  // flowguard-reviewer. Used by tool.execute.before to block verdicts
  // when no subagent call was made.
  const enforcementStates = new Map<string, SessionEnforcementState>();

  function getEnforcementState(sessionId: string): SessionEnforcementState {
    let state = enforcementStates.get(sessionId);
    if (!state) {
      state = createEnforcementState();
      enforcementStates.set(sessionId, state);
    }
    return state;
  }

  /**
   * Initialize the chain hash by reading the existing trail.
   * Called once on first audit event, then cached.
   */
  async function initChain(sessDir: string | null): Promise<string> {
    if (chainInitialized && lastHash !== null) return lastHash;

    try {
      if (!sessDir) {
        lastHash = GENESIS_HASH;
        chainInitialized = true;
        return lastHash;
      }

      const { events } = await readAuditTrail(sessDir);
      // readAuditTrail returns AuditEvent objects — cast to raw records for getLastChainHash
      lastHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
      chainInitialized = true;
      return lastHash;
    } catch {
      // Trail might not exist yet — start fresh
      lastHash = GENESIS_HASH;
      chainInitialized = true;
      return lastHash;
    }
  }

  /**
   * Append an event and optionally update the cached chain hash.
   *
   * @param event - The chained audit event to persist.
   * @param sessDir - Absolute path to the session directory.
   * @param trackChain - If true, update the cached lastHash for chain continuity.
   *   Pass false when policy.audit.enableChainHash is disabled — events still
   *   get persisted but the chain is not maintained (each event uses GENESIS_HASH).
   */
  async function appendAndTrack(
    event: ChainedAuditEvent,
    sessDir: string,
    trackChain: boolean,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event);
    if (trackChain) {
      lastHash = event.chainHash;
    }
  }

  /**
   * Log an audit error without blocking the workflow.
   */
  function logError(message: string, err: unknown): void {
    log.error('audit', message, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  async function updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void> {
    const current = await readState(sessDir);
    if (!current) return;
    const now = new Date().toISOString();
    const next = update(current, now);
    await writeState(sessDir, next);
  }

  async function nextDecisionSequence(sessDir: string, sessionId: string): Promise<number> {
    const cached = decisionSequenceCache.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      decisionSequenceCache.set(sessionId, next);
      return next;
    }

    const { events } = await readAuditTrail(sessDir);
    const receipts = decisionReceipts(events).filter((r) => r.sessionId === sessionId);
    const maxSequence = receipts.reduce((max, r) => Math.max(max, r.decisionSequence), 0);
    const next = maxSequence + 1;
    decisionSequenceCache.set(sessionId, next);
    return next;
  }

  async function runSerializedForSession(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (sessionQueues.get(sessionId) === current) {
          sessionQueues.delete(sessionId);
        }
      });
    sessionQueues.set(sessionId, current);
    await current;
  }

  /**
   * P32: Plugin policy resolver.
   * Delegates to resolvePluginSessionPolicy for testable P32 semantics.
   */
  async function resolveSessionPolicy(
    sessDir: string | null,
  ): Promise<{ policy: FlowGuardPolicy; state: SessionState | null }> {
    return resolvePluginSessionPolicy({
      sessDir,
      configDefaultMode: config.policy.defaultMode,
      log,
    });
  }

  return {
    // ── Review enforcement gate (blocks before tool execution) ─────────────
    // Level 1+2+4: Checks that the flowguard-reviewer subagent was actually
    // invoked and findings were not tampered before allowing a self-review
    // verdict when subagent mode is active.
    // Level 3: Validates prompt integrity before subagent calls.
    'tool.execute.before': async (input, _output) => {
      const toolName: string = input?.tool ?? '';
      const sessionId: string = input?.sessionID ?? 'unknown';
      const args = getToolArgs(input);

      // Level 3: Prompt integrity enforcement for Task calls to flowguard-reviewer
      if (toolName === 'task') {
        const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
        if (subagentType === REVIEWER_SUBAGENT_TYPE) {
          const eState = getEnforcementState(sessionId);
          const result = enforceBeforeSubagentCall(eState, args);

          if (!result.allowed) {
            log.warn('enforcement', 'blocked subagent call with invalid prompt', {
              tool: toolName,
              sessionId,
              code: result.code,
            });
            throw new Error(`[FlowGuard] ${result.code}: ${result.reason}`);
          }
        }
        return;
      }

      // Level 1+2+4: Enforcement for FlowGuard plan/implement verdict calls
      if (toolName !== TOOL_FLOWGUARD_PLAN && toolName !== TOOL_FLOWGUARD_IMPLEMENT) return;

      const eState = getEnforcementState(sessionId);
      const result = enforceBeforeVerdict(eState, toolName, args);

      if (!result.allowed) {
        log.warn('enforcement', 'blocked verdict submission', {
          tool: toolName,
          sessionId,
          code: result.code,
        });
        throw new Error(`[FlowGuard] ${result.code}: ${result.reason}`);
      }
    },

    'tool.execute.after': async (input, output) => {
      const toolName: string = input?.tool ?? '';
      const sessionId: string = input?.sessionID ?? 'unknown';
      const now = new Date().toISOString();

      // ── Review enforcement tracking (all tools) ─────────────────────────
      // Track FlowGuard tool responses for INDEPENDENT_REVIEW_REQUIRED signals
      // and Task calls to flowguard-reviewer subagent.
      if (toolName === TOOL_FLOWGUARD_PLAN || toolName === TOOL_FLOWGUARD_IMPLEMENT) {
        try {
          const eState = getEnforcementState(sessionId);
          trackFlowGuardEnforcement(eState, toolName, input, output, now);
        } catch (err) {
          logError('enforcement tracking failed (non-blocking)', err);
        }
      } else if (toolName === 'task') {
        try {
          const eState = getEnforcementState(sessionId);
          trackTaskEnforcement(eState, input, output, now);
        } catch (err) {
          logError('enforcement tracking failed (non-blocking)', err);
        }
      }

      // ── Deterministic review orchestration (plugin-initiated) ────────────
      // When a FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED,
      // the plugin programmatically invokes the reviewer subagent via the
      // SDK client. This is deterministic — no LLM decision involved.
      //
      // On success: output is mutated to INDEPENDENT_REVIEW_COMPLETED with
      // findings injected, and enforcement state is updated.
      // On non-strict failure: original output is preserved and the
      // LLM-driven Task path may continue. On strict failure: orchestration
      // blocks fail-closed with explicit error output.
      if (toolName === TOOL_FLOWGUARD_PLAN || toolName === TOOL_FLOWGUARD_IMPLEMENT) {
        const rawOutput = getToolOutput(output);
        let strictEnforcement: boolean | null = null;
        const inReviewPath = isReviewRequired(rawOutput);
        if (inReviewPath) {
          try {
            // Resolve workspace + session for state access
            await resolveFingerprint();
            const sessDir = getSessionDir(sessionId);

            if (sessDir) {
              const sessionState = await readState(sessDir);
              const parsedOutput = JSON.parse(rawOutput) as Record<string, unknown>;
              const reviewCtx = extractReviewContext(toolName, parsedOutput);
              strictEnforcement =
                sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;

              if (sessionState && reviewCtx) {
                await updateReviewAssurance(sessDir, (s, now) => {
                  const assurance = ensureReviewAssurance(s.reviewAssurance);
                  assurance.obligations = assurance.obligations.map((item) => {
                    if (item.obligationId !== reviewCtx.obligationId) return item;
                    return {
                      ...item,
                      pluginHandshakeAt: now,
                    };
                  });
                  return { ...s, reviewAssurance: assurance };
                });
                await appendReviewAuditEvent(
                  sessDir,
                  sessionId,
                  String(parsedOutput.phase ?? sessionState.phase),
                  'review:obligation_created',
                  {
                    obligationId: reviewCtx.obligationId,
                    obligationType: toolName === TOOL_FLOWGUARD_PLAN ? 'plan' : 'implement',
                    iteration: reviewCtx.iteration,
                    planVersion: reviewCtx.planVersion,
                    criteriaVersion: reviewCtx.criteriaVersion,
                    mandateDigest: reviewCtx.mandateDigest,
                  },
                );

                // Build the review prompt with session context
                const ticketText = sessionState.ticket?.text ?? '';
                const planText = sessionState.plan?.current?.body ?? '';
                const toolArgs = getToolArgs(input);

                const prompt =
                  toolName === TOOL_FLOWGUARD_PLAN
                    ? buildPlanReviewPrompt({
                        planText:
                          typeof toolArgs.planText === 'string' ? toolArgs.planText : planText,
                        ticketText,
                        iteration: reviewCtx.iteration,
                        planVersion: reviewCtx.planVersion,
                        obligationId: reviewCtx.obligationId,
                        criteriaVersion: reviewCtx.criteriaVersion,
                        mandateDigest: reviewCtx.mandateDigest,
                      })
                    : buildImplReviewPrompt({
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

                // Invoke the reviewer subagent via SDK client
                log.info('orchestrator', 'invoking reviewer subagent', {
                  tool: toolName,
                  sessionId,
                  iteration: reviewCtx.iteration,
                  planVersion: reviewCtx.planVersion,
                });

                const reviewerResult = await invokeReviewer(
                  client as unknown as OrchestratorClient,
                  prompt,
                  sessionId,
                );

                if (reviewerResult) {
                  // Fail-closed: only proceed to COMPLETED path when structured
                  // ReviewFindings were successfully parsed. Unparseable reviewer
                  // responses must NOT produce INDEPENDENT_REVIEW_COMPLETED —
                  // that would violate P34 contract (completed ≠ unparseable).
                  if (!reviewerResult.findings) {
                    log.warn(
                      'orchestrator',
                      'reviewer returned unparseable response — fallback to LLM-driven path',
                      {
                        tool: toolName,
                        sessionId,
                        childSessionId: reviewerResult.sessionId,
                        rawResponseLength: reviewerResult.rawResponse.length,
                      },
                    );
                    // Do NOT mutate output, do NOT call recordPluginReview.
                    // Original INDEPENDENT_REVIEW_REQUIRED is preserved.
                    // LLM follows fallback Path A2 (Task tool to reviewer).
                    if (strictEnforcement) {
                      await updateReviewAssurance(sessDir, (s) => {
                        const assurance = ensureReviewAssurance(s.reviewAssurance);
                        assurance.obligations = assurance.obligations.map((item) => {
                          if (item.obligationId !== reviewCtx.obligationId) return item;
                          return {
                            ...item,
                            status: 'blocked',
                            blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
                          };
                        });
                        return { ...s, reviewAssurance: assurance };
                      });
                      await appendReviewAuditEvent(
                        sessDir,
                        sessionId,
                        String(parsedOutput.phase ?? sessionState.phase),
                        'review:obligation_blocked',
                        {
                          obligationId: reviewCtx.obligationId,
                          code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
                        },
                      );
                      output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
                        reason: 'reviewer response was not parseable as ReviewFindings',
                      });
                    }
                  } else {
                    const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
                    if (!parsedFindings.success && strictEnforcement) {
                      output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
                        reason: 'reviewer response did not match ReviewFindings schema',
                      });
                    }

                    if (strictEnforcement && parsedFindings.success) {
                      const att = parsedFindings.data.attestation;
                      if (!att) {
                        await updateReviewAssurance(sessDir, (s) => {
                          const assurance = ensureReviewAssurance(s.reviewAssurance);
                          assurance.obligations = assurance.obligations.map((item) => {
                            if (item.obligationId !== reviewCtx.obligationId) return item;
                            return {
                              ...item,
                              status: 'blocked',
                              blockedCode: 'SUBAGENT_MANDATE_MISSING',
                            };
                          });
                          return { ...s, reviewAssurance: assurance };
                        });
                        await appendReviewAuditEvent(
                          sessDir,
                          sessionId,
                          String(parsedOutput.phase ?? sessionState.phase),
                          'review:obligation_blocked',
                          {
                            obligationId: reviewCtx.obligationId,
                            code: 'SUBAGENT_MANDATE_MISSING',
                          },
                        );
                        output.output = strictBlockedOutput('SUBAGENT_MANDATE_MISSING', {
                          obligationId: reviewCtx.obligationId,
                        });
                      } else if (
                        parsedFindings.data.reviewMode !== 'subagent' ||
                        att.toolObligationId !== reviewCtx.obligationId ||
                        att.iteration !== reviewCtx.iteration ||
                        att.planVersion !== reviewCtx.planVersion ||
                        att.criteriaVersion !== REVIEW_CRITERIA_VERSION ||
                        att.mandateDigest !== REVIEW_MANDATE_DIGEST
                      ) {
                        await updateReviewAssurance(sessDir, (s) => {
                          const assurance = ensureReviewAssurance(s.reviewAssurance);
                          assurance.obligations = assurance.obligations.map((item) => {
                            if (item.obligationId !== reviewCtx.obligationId) return item;
                            return {
                              ...item,
                              status: 'blocked',
                              blockedCode: 'SUBAGENT_MANDATE_MISMATCH',
                            };
                          });
                          return { ...s, reviewAssurance: assurance };
                        });
                        await appendReviewAuditEvent(
                          sessDir,
                          sessionId,
                          String(parsedOutput.phase ?? sessionState.phase),
                          'review:obligation_blocked',
                          {
                            obligationId: reviewCtx.obligationId,
                            code: 'SUBAGENT_MANDATE_MISMATCH',
                          },
                        );
                        output.output = strictBlockedOutput('SUBAGENT_MANDATE_MISMATCH', {
                          obligationId: reviewCtx.obligationId,
                        });
                      }
                    }

                    const strictGateResult = parseToolResult(output.output);
                    if (strictEnforcement && strictGateResult?.error === true) {
                      // Strict gate already produced a blocked output.
                      // Do not proceed with mutation or evidence recording.
                      return;
                    }

                    // Structured findings available — proceed with deterministic path
                    const mutated = buildMutatedOutput(rawOutput, reviewerResult);

                    if (mutated) {
                      if (strictEnforcement && parsedFindings.success) {
                        const promptHash = hashText(prompt);
                        const findingsHash = hashFindings(reviewerResult.findings);
                        let reusedEvidence = false;
                        await updateReviewAssurance(sessDir, (s, now) => {
                          const assurance = ensureReviewAssurance(s.reviewAssurance);
                          if (
                            hasEvidenceReuse(
                              assurance.invocations,
                              reviewerResult.sessionId,
                              findingsHash,
                            )
                          ) {
                            reusedEvidence = true;
                            assurance.obligations = assurance.obligations.map((item) => {
                              if (item.obligationId !== reviewCtx.obligationId) return item;
                              return {
                                ...item,
                                status: 'blocked',
                                blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
                              };
                            });
                            return { ...s, reviewAssurance: assurance };
                          }

                          const invocation = buildInvocationEvidence({
                            obligationId: reviewCtx.obligationId,
                            obligationType: toolName === TOOL_FLOWGUARD_PLAN ? 'plan' : 'implement',
                            parentSessionId: sessionId,
                            childSessionId: reviewerResult.sessionId,
                            promptHash,
                            findingsHash,
                            invokedAt: now,
                            fulfilledAt: now,
                          });
                          assurance.invocations.push(invocation);
                          assurance.obligations = assurance.obligations.map((item) => {
                            if (item.obligationId !== reviewCtx.obligationId) return item;
                            return {
                              ...item,
                              status: 'fulfilled',
                              invocationId: invocation.invocationId,
                              fulfilledAt: now,
                            };
                          });
                          return { ...s, reviewAssurance: assurance };
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
                                obligationType:
                                  toolName === TOOL_FLOWGUARD_PLAN ? 'plan' : 'implement',
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

                      // Update enforcement state to satisfy L1/L2/L4
                      const eState = getEnforcementState(sessionId);
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

                      // Mutate the output — the LLM will see the modified response.
                      // VERIFIED: output.output mutation in after-hook is effective
                      // (confirmed via OpenCode source: prompt.ts passes output by
                      // reference through plugin.trigger, same object returned to AI SDK)
                      output.output = mutated;

                      log.info('orchestrator', 'reviewer invocation succeeded', {
                        tool: toolName,
                        sessionId,
                        childSessionId: reviewerResult.sessionId,
                        verdict: reviewerResult.findings.overallVerdict,
                      });
                    } else {
                      log.warn('orchestrator', 'output mutation failed (fallback to LLM-driven)', {
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
                  log.warn('orchestrator', 'reviewer invocation failed (fallback to LLM-driven)', {
                    tool: toolName,
                    sessionId,
                  });
                  if (strictEnforcement) {
                    await updateReviewAssurance(sessDir, (s) => {
                      const assurance = ensureReviewAssurance(s.reviewAssurance);
                      assurance.obligations = assurance.obligations.map((item) => {
                        if (item.obligationId !== reviewCtx.obligationId) return item;
                        return {
                          ...item,
                          status: 'blocked',
                          blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
                        };
                      });
                      return { ...s, reviewAssurance: assurance };
                    });
                    await appendReviewAuditEvent(
                      sessDir,
                      sessionId,
                      String(parsedOutput.phase ?? sessionState.phase),
                      'review:obligation_blocked',
                      {
                        obligationId: reviewCtx.obligationId,
                        code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
                      },
                    );
                    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
                      reason: 'reviewer invocation failed',
                    });
                  }
                }
              } else if (strictEnforcement) {
                output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
                  reason: 'review context missing for strict orchestration',
                });
              }
            }
          } catch (err) {
            if (inReviewPath && strictEnforcement !== false) {
              output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
                reason: 'reviewer orchestration threw an exception',
              });
              logError('review orchestration failed (strict mode blocked)', err);
            } else {
              logError('review orchestration failed (fallback to LLM-driven)', err);
            }
          }
        }
      }

      // ── Audit event emission (only FlowGuard tools) ─────────────────────
      if (!toolName.startsWith(FG_PREFIX)) return;

      await runSerializedForSession(sessionId, async () => {
        try {
          // Resolve session directory from tool context
          await resolveFingerprint();
          const sessDir = getSessionDir(sessionId);
          if (!sessDir) return;

          // ── Resolve policy for emission controls + actor classification ──
          const { policy, state } = await resolveSessionPolicy(sessDir);
          const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;

          log.debug('audit', 'processing tool call', {
            tool: toolName,
            emitToolCalls,
            emitTransitions,
            enableChainHash,
          });

          // Actor classification from policy — not hardcoded.
          // E.g., REGULATED classifies flowguard_decision as "human",
          // SOLO classifies it as "system" (auto-approved, no human in loop).
          const actor = policy.actorClassification[toolName] ?? 'system';

          const now = new Date().toISOString();

          // Initialize prevHash: proper chain if enabled, genesis otherwise.
          // When chaining is disabled, each event gets an independent hash
          // (prevHash is always GENESIS_HASH, no chain continuity).
          //
          // P26: For regulated completions, the tool layer emits session_completed
          // directly to the audit trail. The plugin's cached lastHash is stale.
          // Force re-read the trail to avoid a chain fork (two events with the
          // same prevHash).
          let prevHash: string;
          if (enableChainHash) {
            if (state?.archiveStatus) {
              // Regulated completion: tool-layer wrote audit events directly.
              // Invalidate cache and re-read trail for correct prevHash.
              chainInitialized = false;
              lastHash = null;
            }
            prevHash = await initChain(sessDir);
          } else {
            prevHash = GENESIS_HASH;
          }

          // ── Parse tool result ───────────────────────────────────────────
          let phase = 'unknown';
          let transitions: Array<{
            from: Phase;
            to: Phase;
            event: Event;
            at: string;
          }> = [];
          let success = true;
          let errorMessage: string | undefined;
          const parsed = parseToolResult(output?.output);
          if (parsed) {
            phase = typeof parsed.phase === 'string' ? parsed.phase : 'unknown';
            success = parsed.error !== true;
            errorMessage =
              typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;

            const rawTransitions = (parsed._audit as { transitions?: unknown } | undefined)
              ?.transitions;
            if (Array.isArray(rawTransitions)) {
              transitions = rawTransitions as Array<{
                from: Phase;
                to: Phase;
                event: Event;
                at: string;
              }>;
            }
          }

          // ── 1. Emit tool_call event (conditional on policy) ─────────────
          if (emitToolCalls) {
            const argsSummary = summarizeArgs((input as Record<string, unknown>) ?? {});
            const toolCallEvt = createToolCallEvent(
              sessionId,
              phase,
              {
                tool: toolName,
                argsSummary,
                success,
                errorMessage,
                transitionCount: transitions.length,
              },
              now,
              actor,
              prevHash,
              state?.actorInfo,
            );
            await appendAndTrack(toolCallEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = toolCallEvt.chainHash;
            log.debug('audit', 'emitted tool_call event', { tool: toolName, phase });
          }

          // ── 2. Emit transition events (conditional on policy) ───────────
          if (emitTransitions && transitions.length > 0) {
            log.debug('audit', 'emitting transition events', { count: transitions.length });
            for (let i = 0; i < transitions.length; i++) {
              const t = transitions[i]!;
              const transEvt = createTransitionEvent(
                sessionId,
                t.to,
                {
                  from: t.from,
                  to: t.to,
                  event: t.event,
                  autoAdvanced: i > 0,
                  chainIndex: i,
                },
                t.at,
                prevHash,
              );
              await appendAndTrack(transEvt, sessDir, enableChainHash);
              if (enableChainHash) prevHash = transEvt.chainHash;
            }
          }

          // ── 3. Emit decision receipt (successful /review-decision only) ──
          if (toolName === TOOL_FLOWGUARD_DECISION && success && transitions.length > 0) {
            const firstTransition = transitions[0]!;
            const inferredVerdict =
              firstTransition.event === 'APPROVE'
                ? 'approve'
                : firstTransition.event === 'CHANGES_REQUESTED'
                  ? 'changes_requested'
                  : firstTransition.event === 'REJECT'
                    ? 'reject'
                    : null;

            if (inferredVerdict !== null) {
              const sequence = await nextDecisionSequence(sessDir, sessionId);
              const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
              const parsedDecision =
                typeof parsed?.reviewDecision === 'object' && parsed.reviewDecision !== null
                  ? (parsed.reviewDecision as Record<string, unknown>)
                  : null;
              const stateDecision = state?.reviewDecision;
              const rationale =
                (typeof parsedDecision?.rationale === 'string'
                  ? parsedDecision.rationale
                  : undefined) ??
                stateDecision?.rationale ??
                (typeof (input?.args as { rationale?: unknown } | undefined)?.rationale === 'string'
                  ? String((input?.args as { rationale?: unknown } | undefined)?.rationale)
                  : '');
              const decidedBy =
                (typeof parsedDecision?.decidedBy === 'string'
                  ? parsedDecision.decidedBy
                  : undefined) ??
                stateDecision?.decidedBy ??
                undefined;
              const decidedAt =
                (typeof parsedDecision?.decidedAt === 'string'
                  ? parsedDecision.decidedAt
                  : undefined) ??
                stateDecision?.decidedAt ??
                firstTransition.at;

              if (!decidedBy || !decidedBy.trim()) {
                log.warn('audit', 'skipping decision receipt: missing decidedBy', {
                  tool: toolName,
                  sessionId,
                });
                const missingActorEvt = createErrorEvent(
                  sessionId,
                  {
                    code: 'DECISION_RECEIPT_ACTOR_MISSING',
                    message: 'Decision receipt skipped because decidedBy is missing',
                    recoveryHint:
                      'Ensure /review-decision output includes reviewDecision.decidedBy',
                    errorPhase: firstTransition.from,
                  },
                  now,
                  prevHash,
                );
                await appendAndTrack(missingActorEvt, sessDir, enableChainHash);
                if (enableChainHash) prevHash = missingActorEvt.chainHash;
              } else {
                const decisionEvt = createDecisionEvent(
                  sessionId,
                  firstTransition.from,
                  {
                    decisionId,
                    decisionSequence: sequence,
                    verdict: inferredVerdict,
                    rationale,
                    decidedBy,
                    decidedAt,
                    fromPhase: firstTransition.from,
                    toPhase: firstTransition.to,
                    transitionEvent: firstTransition.event,
                    policyMode: state?.policySnapshot.mode ?? policy.mode,
                  },
                  now,
                  actor,
                  prevHash,
                  state?.actorInfo,
                );
                await appendAndTrack(decisionEvt, sessDir, enableChainHash);
                if (enableChainHash) prevHash = decisionEvt.chainHash;
              }
            }
          }

          // ── 4. Emit lifecycle events (always — structural) ──────────────
          // Lifecycle events (session_created, session_aborted) are always
          // emitted regardless of policy. They provide session-level
          // traceability that's needed even in solo/minimal-audit modes.
          const lifecycleAction = LIFECYCLE_TOOLS[toolName];
          if (lifecycleAction) {
            log.info('audit', 'lifecycle event', { action: lifecycleAction, tool: toolName });
            // Determine final phase from transitions or parsed result
            const finalPhase =
              transitions.length > 0 ? transitions[transitions.length - 1]!.to : (phase as Phase);

            const lifecycleReason =
              lifecycleAction === 'session_created'
                ? `${
                    typeof parsed?.policyResolution === 'object'
                      ? `requested_mode:${String((parsed.policyResolution as Record<string, unknown>).requestedMode ?? 'unknown')};effective_mode:${String((parsed.policyResolution as Record<string, unknown>).effectiveMode ?? state?.policySnapshot.mode ?? policy.mode)};source:${String((parsed.policyResolution as Record<string, unknown>).source ?? state?.policySnapshot.source ?? 'unknown')};effective_gate_behavior:${String((parsed.policyResolution as Record<string, unknown>).effectiveGateBehavior ?? state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'))};reason:${String((parsed.policyResolution as Record<string, unknown>).reason ?? state?.policySnapshot.degradedReason ?? 'none')};resolution_reason:${String((parsed.policyResolution as Record<string, unknown>).resolutionReason ?? state?.policySnapshot.resolutionReason ?? 'none')};central_minimum_mode:${String((parsed.policyResolution as Record<string, unknown>).centralMinimumMode ?? state?.policySnapshot.centralMinimumMode ?? 'none')};central_policy_digest:${String((parsed.policyResolution as Record<string, unknown>).centralPolicyDigest ?? state?.policySnapshot.policyDigest ?? 'none')}`
                      : `requested_mode:${state?.policySnapshot.requestedMode ?? policy.mode};effective_mode:${state?.policySnapshot.mode ?? policy.mode};source:${state?.policySnapshot.source ?? 'unknown'};effective_gate_behavior:${state?.policySnapshot.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve')};reason:${state?.policySnapshot.degradedReason ?? 'none'};resolution_reason:${state?.policySnapshot.resolutionReason ?? 'none'};central_minimum_mode:${state?.policySnapshot.centralMinimumMode ?? 'none'};central_policy_digest:${state?.policySnapshot.policyDigest ?? 'none'}`
                  }`
                : undefined;

            const lifecycleEvt = createLifecycleEvent(
              sessionId,
              {
                action: lifecycleAction as
                  | 'session_created'
                  | 'session_completed'
                  | 'session_aborted',
                finalPhase,
                ...(lifecycleReason ? { reason: lifecycleReason } : {}),
              },
              now,
              actor, // Actor from policy (e.g., REGULATED: abort is "human")
              prevHash,
              state?.actorInfo,
            );
            await appendAndTrack(lifecycleEvt, sessDir, enableChainHash);
            if (enableChainHash) prevHash = lifecycleEvt.chainHash;
          }

          // ── 5. Detect session completion (always — structural) ──────────
          // Session completion is a machine-driven event (topology transition
          // to COMPLETE). Always emitted, always attributed to "machine".
          //
          // P26: For regulated completions, the tool layer already emitted
          // session_completed before archiveSession(). Skip emission here
          // to avoid duplicating the lifecycle event.
          const completionTransition = transitions.find((t) => t.to === 'COMPLETE');
          if (completionTransition && !LIFECYCLE_TOOLS[toolName]) {
            // Check if tool layer already handled completion (regulated path)
            const freshState = cachedFingerprint ? await readState(sessDir) : null;
            const toolLayerHandled = !!freshState?.archiveStatus;

            if (!toolLayerHandled) {
              const completionEvt = createLifecycleEvent(
                sessionId,
                {
                  action: 'session_completed',
                  finalPhase: 'COMPLETE' as Phase,
                },
                now,
                'machine',
                prevHash,
                state?.actorInfo,
              );
              await appendAndTrack(completionEvt, sessDir, enableChainHash);
              if (enableChainHash) prevHash = completionEvt.chainHash;
            } else {
              log.debug('audit', 'session_completed handled by tool layer', {
                archiveStatus: freshState.archiveStatus,
              });
            }

            // Auto-archive completed session.
            // Regulated archive handling is owned by the tool layer (P26).
            // Non-regulated: existing auto-archive behavior.
            if (cachedFingerprint) {
              if (toolLayerHandled) {
                log.debug('audit', 'archive handled by tool layer', {
                  archiveStatus: freshState.archiveStatus,
                });
              } else {
                archiveSession(cachedFingerprint, sessionId).catch((err) => {
                  log.warn('audit', 'auto-archive failed', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              }
            }
          }

          // ── 6. Emit error event (always — structural) ───────────────────
          // Error events are always emitted. Suppressing errors from the
          // audit trail would be a compliance gap in any mode.
          if (!success && errorMessage) {
            log.warn('audit', 'tool reported error', { tool: toolName, errorMessage });
            const errorEvt = createErrorEvent(
              sessionId,
              {
                code: 'TOOL_ERROR',
                message: errorMessage,
                recoveryHint: 'Check tool output for details',
                errorPhase: phase as Phase,
              },
              now,
              prevHash,
            );
            await appendAndTrack(errorEvt, sessDir, enableChainHash);
          }
        } catch (err) {
          // Fire-and-forget: log but never block the workflow
          logError(`Failed to write audit events for ${toolName}`, err);
        }
      });
    },
  };
};
