/**
 * @module templates-hash.test
 * @description Hash-based stability test for template exports.
 *
 * Verifies that templates remain byte-for-byte identical after refactoring.
 * Uses SHA-256 hashes computed from the compiled template output.
 *
 * @test-policy STABILITY — hash verification
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  REVIEWER_AGENT,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from './templates.js';
import {
  TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
} from '../integration/tool-names.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('TEMPLATE_HASH_STABILITY', () => {
  it('TOOL_WRAPPER matches compiled output hash', () => {
    expect(sha256(TOOL_WRAPPER)).toBe(
      '2832703d740a9a77afeb0f81fa145ae48d9a8e4e55d6edaf31dc176d18dc5e29',
    );
  });

  it('TOOL_WRAPPER exports run_check instead of removed validate tool', () => {
    expect(TOOL_WRAPPER).toContain('run_check');
    expect(TOOL_WRAPPER).not.toContain('  validate,');
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '7810a13de154b7b4c9c3f33fd4a2932d35f73db576705959f6c2d9bdda9b1313',
    );
  });

  it('FLOWGUARD_MANDATES_BODY matches compiled output hash', () => {
    // Refreshed for #471: decoupled host-specific output rules (Next action: line)
    // from universal governance rules — scoped as OpenCode host/profile convention.
    // Refreshed for review-verdict disambiguation: the reviewer verdict token was
    // renamed 'approve' -> 'accept' (LoopVerdict), so the build-agent mandate's
    // review-verdict line changed.
    // Refreshed for agent-role + Extended Guidance: prepended a senior-engineer
    // role/identity sentence and enriched ## 12. Extended Guidance to name the
    // owning authorities (commands/profiles/reviewer) without duplicating them.
    expect(sha256(FLOWGUARD_MANDATES_BODY)).toBe(
      'de261e4dcad912540982ce2911a6c9dbfd4f33b7544e3c43c0a12df8c37273bb',
    );
  });

  it('REVIEWER_AGENT matches compiled output hash', () => {
    // Refreshed for #245: multi-platform review orchestration added native
    // Claude/Codex reviewer renderers without changing the OpenCode reviewer
    // prompt structure. The JSON Output Format schema block remains closed.
    // Refreshed for review-verdict disambiguation: the reviewer output verdict
    // token was renamed 'approve' -> 'accept' (overallVerdict) to separate the
    // reviewer's acceptance from the user-gate approval.
    // Refreshed for reviewer-criteria enrichment (criteriaVersion p35->p36):
    // plan/implementation/adr/content REVIEWER_CRITERIA gained test-integrity,
    // conviction, ADR-justification, deletion-test, and changed-scope/signal
    // guidance. This changes the REVIEWER_AGENT body and therefore the runtime
    // REVIEW_MANDATE_DIGEST. Existing sessions with obligations bound to the
    // previous digest must be re-hydrated or re-created.
    // Refreshed again for p36->p37: added a Security-as-risk vulnerability bullet
    // (content + implementation) and a root-cause bullet (plan + implementation),
    // which changes the REVIEWER_AGENT body and REVIEW_MANDATE_DIGEST.
    // p40 -> p41: material findings require structured subject and evidence relations.
    // p41 -> p42: mandate semantics fixed (removed 'info' severity, corrected type names,
    //   evidenceLocations may be empty). Refreshed for reviewer-owned input DTO:
    // reviewer provenance is host-stamped after strict input validation.
    expect(sha256(REVIEWER_AGENT)).toBe(
      '5f0f74912c51e1fab914de853e705ab62fdd93c1370010c419dc274d5a3cc93a',
    );
  });

  it('OPENCODE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = OPENCODE_JSON_TEMPLATE('flowguard-mandates.md');
    expect(sha256(template)).toBe(
      '1fc84e2ee553df018b6ee1af2c2beeaf9b11f86f82f43ee0019e09afa5afd45b',
    );
  });

  it('PACKAGE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = PACKAGE_JSON_TEMPLATE('1.2.3');
    expect(sha256(template)).toBe(
      '9a09254c6abceacb655020b9c03b4a25bf7f5fa60b7e336fb36aa31e093ffc09',
    );
  });

  it('COMMANDS matches compiled output hash', () => {
    // Refreshed for #262: GOVERNANCE_RULES is now a projection from the
    // mandates Governance rules section, affecting all command templates.
    // Refreshed for #401: /review template now requires Discovery context
    // (health/drift) and NOT_VERIFIED correlation for PR/content review.
    // Refreshed for Item 2: plan/implement/architecture review templates now
    // capture Discovery context, pass it to the reviewer subagent, and require
    // NOT_VERIFIED correlation (parity with /review). Changes the COMMANDS hash.
    // Refreshed for #471: COMPACT_COMMAND_EXECUTION / CONCISE_COMMAND_EXECUTION
    // updated with host/profile output convention scope.
    // Refreshed for #507: /plan documents strict payload sequencing and
    // reviewerUnavailable fail-closed recovery semantics.
    // Refreshed for gate-notice: /start now surfaces policyResolution.effectiveMode
    // and displays the hydrate `gateNotice` verbatim so auto-approve modes are visible.
    // Refreshed for review-verdict disambiguation: plan/architecture/implement +
    // shared-review-loop now state reviewVerdict is the independent reviewer's result
    // (NOT user approval), require verdict-only in host-task mode, and remove the
    // self-review fallback wording.
    // Refreshed for review-verdict accept-token: command templates now use
    // overallVerdict/reviewVerdict "accept" (reviewer) instead of "approve".
    // Refreshed for host-confirmed user decisions: plan/decision commands now
    // require explicit user slash-command origin at human review gates.
    // Refreshed for conditional Done-when: plan/implement Done-when now scope the
    // /review-decision next action to the converged path and require a blocked path
    // to surface the FlowGuard blocker instead of a premature review-decision prompt.
    // Refreshed for standalone /review host-task flow: /review now treats
    // HOST_SUBAGENT_TASK_REQUIRED as an intermediate state and documents local
    // branch diff fallback when no remote/PR is available.
    // Refreshed for #565: /implement template + shared-review-loop now submit the
    // implementation review verdict via the separate flowguard_review_implementation
    // tool (record evidence vs. submit verdict are distinct single-purpose tools).
    // Refreshed for VALIDATION check-field contract: /check + /validate now read
    // checks from an UNFOCUSED flowguard_status (focused projections must not be
    // used to gate checks) and reference both activeChecks and remainingChecks.
    // Refreshed for status-contract sweep: /why reads whyBlocked.* (not a
    // non-existent top-level `blocker`); /plan + /implement no longer claim the
    // ticket/plan BODY comes from the status response (status only confirms
    // hasTicket/hasPlan/planVersion + phase).
    // Refreshed for /review first-call contract: step 3 now forbids reviewVerdict
    // (and reviewFindings) on the first content-aware flowguard_review call — the
    // verdict is submitted only after the reviewer runs, so a verdict-bearing
    // first call no longer wedges the host-task bind.
    // Refreshed for discovery-capture + payload-contract hardening: the shared
    // Discovery capture (plan/implement/architecture) and /review step 1 now
    // require an UNFOCUSED flowguard_status (focused projections omit
    // discoveryHealth/discoveryDrift/detectedStack), so repo-dependent claims are
    // no longer spuriously NOT_VERIFIED. The shared host_task_required verdict
    // branch now states reviewFindings submitted alongside the verdict are ignored
    // and the verdict is validated against captured evidence; /plan + /review
    // first-call lines forbid a prefilled verdict imperatively.
    // Refreshed for host-task verdict-only parity: the shared verdict branch,
    // /review step 5, /plan payload contract, and /architecture review step now
    // forbid reviewFindings "not even an empty placeholder object" in
    // host_task_required mode — matching the runtime, which resolves findings from
    // captured evidence and validates the verdict against it.
    // Refreshed for reviewer-criteria enrichment: /plan gained tracer-bullet /
    // deep-module step guidance plus a "Planning discipline" section, and
    // /validate gained an advisory "Test quality" section. These change the
    // /plan and /validate command bodies and therefore the COMMANDS hash.
    // Refreshed for #520: added the read-only /finish command (finish.md), a
    // status aggregator that renders the Finish Card via flowguard_status
    // { finish: true }. New command body changes the COMMANDS hash.
    // Refreshed for #520 review: /finish template now renders the canonical
    // blocker field verbatim (buildBlockedProjection) instead of unspecified
    // "blockers and warnings", changing the /finish body and COMMANDS hash.
    // Refreshed for F10: the /review, /check, and shared review-loop templates
    // now instruct the agent to invoke the reviewer Task without a prompt so
    // FlowGuard injects the canonical bytes at the host boundary to eliminate the
    // first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT block. New command bodies
    // change the COMMANDS hash.
    // Refreshed for #686: /implement template now documents the IMPL_VALIDATION
    // gate with auto-chain (flowguard_run_check) between recording evidence and
    // entering the review loop, closing the gap between README and template.
    // Refreshed for #689: /help and /commands templates now instruct the agent
    // to render Markdown guidance verbatim instead of raw JSON. /implement and
    // /plan include resume hints to retrieve artifact content via
    // flowguard_help({ includeArtifactContent: true }).
    // Refreshed for presentation-unification: /status, /why, and /finish
    // Done-when now defer to the rendered presentation.markdown conclusion (the
    // trailing →/• command line or ## Decision required block) as the canonical
    // next-action guidance and forbid appending a duplicate `Next action:` line
    // when presentation.markdown is present. The `Next action:` requirement now
    // scopes to the fallback projection only. Changes the /status, /why, and
    // /finish bodies and therefore the COMMANDS hash.
    // Refreshed for rendering-consistency: (1) /plan template clarifies the
    // `# Implementation Plan` body heading is demoted when embedded in the Plan
    // Review Card (no longer claims "the only # heading in the document"), and
    // (2) /plan and /architecture Done-when now defer to the review card's
    // rendered conclusion (## Decision required) instead of demanding a separate
    // `Next action:` line — the plan and architecture review cards carry a
    // PresentationConclusion, so a textual line would duplicate it. /implement
    // and /review keep their `Next action:` line: the review-report card is
    // intentionally conclusion-less, so that line is the sole (non-duplicated)
    // next-action source. Changes the /plan and /architecture bodies.
    // Refreshed for rail next-action rendering: the /approve, /request-changes,
    // /reject, and /review-decision commands run through flowguard_decision,
    // whose success response now carries presentation.markdown (a rendered
    // next-action conclusion). Their Done-when now defers to that rendered
    // conclusion and scopes the `Next action:` line to the fallback projection
    // only, matching /status, /why, and /finish. Changes those four bodies and
    // therefore the COMMANDS hash.
    // Refreshed for /implement quality rules: added Anti-Over-Engineering
    // (AP-B11), Test-Fitting (AP-B12), and no-workaround/cleanup rules to the
    // /implement ## Rules section. Changes the /implement body and therefore the
    // COMMANDS hash.
    // Refreshed for default redacted sharing exports: ARCHIVE_COMMAND now calls
    // flowguard_archive without arguments unless a non-default export is requested.
    // Refreshed for #762 ProofGraph claim declarations: /plan now submits
    // flowguard_plan({ planText, claims }) and /architecture submits
    // flowguard_architecture({ title, adrText, claims }). The previous bodies
    // instructed claim-free call forms, which made the claim surface unreachable
    // through the installed product path. Changes both bodies and therefore the
    // COMMANDS hash.
    // Refreshed again for the unconditional ProofGraph gate: /plan now documents
    // counterexampleCheckId as REQUIRED for critical claims and states that a
    // critical claim blocks the final evidence approval while its evidence is
    // missing, stale, or contradicted.
    // Refreshed for structured assertion identity model: assertionId string
    // replaced by assertion: { providerId, localId } in plan template examples.
    // Refreshed for same-check closure: replaced "MUST differ from expectedCheckId"
    // with bindability-oriented guidance and "structurally bindable counterexample check".
    // Refreshed for English-only command copy: the /why and /finish verbatim-render
    // steps were localized to English-only (no non-English phrasing) to match the
    // single-language product surface. Changes both bodies and therefore the
    // COMMANDS hash.
    // Refreshed for architecture acceptance integrity: every completed ADR
    // reviewer cycle now stops at ARCH_REVIEW and requires a human decision.
    // Refreshed for the canonical reviewer-prompt contract: the /review command
    // no longer permits free-composed reviewer prompts — a repository review
    // without a canonical reviewerTaskPrompt is blocked with
    // REVIEWER_CONTEXT_UNAVAILABLE.
    // Refreshed for /architecture re-invocation routing: the reviewer Task
    // instruction no longer asks the agent to supply ADR/ticket text (the host
    // injects the canonical prompt); re-runs route to output repair or review
    // orchestration restart.
    // Refreshed for auto-continuation review loops: shared-review-loop now
    // instructs agents to CONTINUE AUTOMATICALLY between iterations instead of
    // "Repeat from step X" and records the implement reviewer's negative verdict
    // FIRST (changesRequestedVerdictFirst) before any edits. /implement documents
    // that changes_requested is an INTERNAL continuation with no intermediate
    // presentation card. /check branches the IMPL_REVIEW outcome (accept /
    // changes_requested / blocked) and no longer treats a negative verdict as
    // completion. Changes the command bodies and therefore the COMMANDS hash.
    // Refreshed for the /check rework continuation: an active non-exhausted
    // implementationRework marker now continues the repair → flowguard_implement
    // → status → flowguard_run_check → challenge resolution loop until a terminal
    // verdict, scoped to the verified rework case by the /check command scope
    // (flowguard_resolve_implementation_challenge is referenced from /check).
    // Refreshed again for the full loop: read/glob/grep are part of the repair
    // surface, and the continuation is keyed to "this /check already recorded a
    // changes_requested verdict" so a failing FRESH check after re-record still
    // continues the loop instead of stopping for a manual /implement hand-off.
    // Changes the /check body and therefore the COMMANDS hash.
    // Refreshed for the same-digest invariant: the rework marker is RETAINED
    // across re-records and only closed when the fresh revalidation fully passes
    // into IMPL_REVIEW, so restoring an earlier rejected revision after a failing
    // revalidation is blocked again. Changes the /check body and therefore the
    // COMMANDS hash.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '0fa4f2d5fddd92da6530d06e572013154b74a1bb3b86fafedc70168e2dfd226f',
    );
  });

  it('all 26 commands present', () => {
    const expected = [
      'abort.md',
      'approve.md',
      'architecture.md',
      'archive.md',
      'check.md',
      'commands.md',
      'continue.md',
      'export.md',
      'extend-implementation-review.md',
      'finish.md',
      'help.md',
      'hydrate.md',
      'implement.md',
      'plan.md',
      'reconcile-mutation-episode.md',
      'reject.md',
      'request-changes.md',
      'resolve-implementation-challenge.md',
      'review-decision.md',
      'review.md',
      'start.md',
      'status.md',
      'task.md',
      'ticket.md',
      'validate.md',
      'why.md',
    ];
    expect(Object.keys(COMMANDS).sort()).toEqual(expected);
  });

  // Drift guard (issue #565 regression): the OpenCode tool surface is built
  // verbatim from TOOL_WRAPPER. OpenCode derives the callable tool name as
  // `flowguard_<exportname>`, so TOOL_WRAPPER MUST re-export every canonical
  // FlowGuard tool. The #565 split added flowguard_review_implementation to the
  // barrel and the MCP registry but NOT to TOOL_WRAPPER, making the verdict tool
  // uncallable on OpenCode. This test cross-checks TOOL_WRAPPER against the
  // canonical tool-name SSOT so that omission can never silently recur.
  it('TOOL_WRAPPER re-exports every canonical FlowGuard tool (OpenCode surface completeness)', () => {
    const canonicalToolNames = [
      TOOL_FLOWGUARD_STATUS,
      TOOL_FLOWGUARD_HYDRATE,
      TOOL_FLOWGUARD_TICKET,
      TOOL_FLOWGUARD_PLAN,
      TOOL_FLOWGUARD_DECISION,
      TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
      TOOL_FLOWGUARD_IMPLEMENT,
      TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
      TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
      TOOL_FLOWGUARD_RUN_CHECK,
      TOOL_FLOWGUARD_REVIEW,
      TOOL_FLOWGUARD_CONTINUE,
      TOOL_FLOWGUARD_ABORT,
      TOOL_FLOWGUARD_ARCHIVE,
      TOOL_FLOWGUARD_ARCHITECTURE,
      TOOL_FLOWGUARD_HELP,
      TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
      TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
    ];

    // Parse the actual export identifiers from TOOL_WRAPPER's export block.
    const exportBlock = TOOL_WRAPPER.match(/export\s*\{([^}]*)\}/);
    expect(exportBlock, 'TOOL_WRAPPER must contain an export block').not.toBeNull();
    const exportedIdentifiers = new Set(
      exportBlock![1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

    // OpenCode tool name `flowguard_<exportname>` -> the export identifier is the
    // canonical name with the `flowguard_` prefix stripped. abort_session maps to
    // the `abort_session` export even though its tool name is flowguard_abort_session.
    const missing = canonicalToolNames
      .map((toolName) => toolName.replace(/^flowguard_/, ''))
      .filter((exportName) => !exportedIdentifiers.has(exportName));

    expect(
      missing,
      `TOOL_WRAPPER is missing re-exports for: ${missing.join(', ')}. ` +
        `Add them to src/templates/wrappers/index.ts or OpenCode cannot call these tools.`,
    ).toEqual([]);

    // Symmetry: no stray exports beyond the canonical tool set.
    const canonicalExportNames = new Set(
      canonicalToolNames.map((t) => t.replace(/^flowguard_/, '')),
    );
    const stray = [...exportedIdentifiers].filter((id) => !canonicalExportNames.has(id));
    expect(
      stray,
      `TOOL_WRAPPER exports unexpected identifiers (not canonical tools): ${stray.join(', ')}`,
    ).toEqual([]);
  });

  // Drift guard for the installed-package surface: the wrapper's import
  // (`export { ... } from "@flowguard/core/integration"`) resolves against the
  // integration barrel at install time. A wrapper export that is missing from
  // src/integration/index.ts breaks the OpenCode tool scan with an import
  // error (HTTP 500 on the tool-ids endpoint) — this must never regress.
  it('every TOOL_WRAPPER export exists in the integration barrel (installed package surface)', async () => {
    const exportBlock = TOOL_WRAPPER.match(/export\s*\{([^}]*)\}/);
    expect(exportBlock, 'TOOL_WRAPPER must contain an export block').not.toBeNull();
    const wrapperExports = exportBlock![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const barrel = await fs.readFile(
      path.join(process.cwd(), 'src', 'integration', 'index.ts'),
      'utf-8',
    );
    const barrelExportBlock = barrel.match(/export\s*\{([\s\S]*?)\}\s*from '\.\/tools\/index\.js'/);
    expect(barrelExportBlock, 'integration barrel must re-export the tools').not.toBeNull();
    const barrelExports = new Set(
      barrelExportBlock![1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

    const missing = wrapperExports.filter((id) => !barrelExports.has(id));
    expect(
      missing,
      `@flowguard/core/integration is missing exports referenced by TOOL_WRAPPER: ${missing.join(', ')}. ` +
        `Add them to src/integration/index.ts or the OpenCode tool scan fails.`,
    ).toEqual([]);
  });
});
