/**
 * @module integration/diagnostics/render
 * @description Portable Markdown rendering for the diagnostic views.
 *
 * Every renderer starts from the read-only projection and keeps the diagnostic
 * boundary visible. Rendering never mutates state, writes evidence or enables a
 * decision control.
 */

import type {
  ExplorerReviewLinks,
  ExplorerView,
  LogView,
  NotificationView,
  ReviewSubjectView,
  ReviewView,
} from './types.js';

const READ_ONLY_NOTICE =
  'Read-only diagnostic projection. This view is not evidence, approval or authorization.';

function codeSpan(value: string): string {
  const runs = [...value.matchAll(/`+/g)].map((match) => match[0].length);
  const ticks = '`'.repeat(Math.max(1, ...runs) + 1);
  return `${ticks}${value}${ticks}`;
}

function fenced(value: string): string {
  const runs = [...value.matchAll(/`{3,}/g)].map((match) => match[0].length);
  const ticks = '`'.repeat(Math.max(3, ...runs, 0) + 1);
  return `${ticks}markdown\n${value}\n${ticks}`;
}

function cell(value: string | null, max = 120): string {
  const text = (value ?? '—').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function listOrNone(items: readonly string[], none: string): string {
  return items.length === 0 ? none : items.map((item) => `- ${item}`).join('\n');
}

function warningsSection(
  warnings: readonly { code: string; message: string; sessionId: string | null }[],
): string {
  if (warnings.length === 0) return '## Warnings\n\nNo view warnings.';
  return [
    '## Warnings',
    '',
    ...warnings.map(
      (entry) =>
        `- ${codeSpan(entry.code)}${entry.sessionId ? ` (${codeSpan(entry.sessionId)})` : ''}: ${cell(entry.message, 400)}`,
    ),
  ].join('\n');
}

function renderReviewLinks(links: ExplorerReviewLinks | null): string {
  if (links === null) {
    return '## Review links\n\nNo review assurance is recorded for this session.';
  }
  const lines = [
    '## Review links',
    '',
    `- Obligations: ${links.obligations.length}`,
    `- Attempts: ${links.attempts.length}`,
    `- Dispatches: ${links.dispatches.length}`,
    `- Invocations: ${links.invocations.length}`,
  ];
  if (links.truncated) {
    lines.push('- Explicit truncation: only the newest 200 entries per link type are shown.');
  }
  if (links.obligations.length > 0) {
    lines.push(
      '',
      '### Obligations',
      '',
      '| Obligation | Type | Status | Iteration | Subject digest |',
      '| --- | --- | --- | --- | --- |',
      ...links.obligations.map(
        (item) =>
          `| ${codeSpan(item.obligationId)} | ${cell(item.obligationType)} | ${cell(item.status)} | ${item.iteration} | ${codeSpan(item.subjectDigest)} |`,
      ),
    );
  }
  if (links.attempts.length > 0) {
    lines.push(
      '',
      '### Attempts',
      '',
      '| Attempt | Obligation | Status | Child session |',
      '| --- | --- | --- | --- |',
      ...links.attempts.map(
        (item) =>
          `| ${codeSpan(item.attemptId)} | ${codeSpan(item.obligationId)} | ${cell(item.status)} | ${item.childSessionId ? codeSpan(item.childSessionId) : '—'} |`,
      ),
    );
  }
  if (links.dispatches.length > 0) {
    lines.push(
      '',
      '### Dispatches',
      '',
      '| Dispatch | Attempt | Status | Host call |',
      '| --- | --- | --- | --- |',
      ...links.dispatches.map(
        (item) =>
          `| ${codeSpan(item.dispatchId)} | ${codeSpan(item.attemptId)} | ${cell(item.dispatchStatus)} | ${codeSpan(item.hostCallId)} |`,
      ),
    );
  }
  if (links.invocations.length > 0) {
    lines.push(
      '',
      '### Invocations',
      '',
      '| Invocation | Obligation | Parent | Child | Captured verdict |',
      '| --- | --- | --- | --- | --- |',
      ...links.invocations.map(
        (item) =>
          `| ${codeSpan(item.invocationId)} | ${codeSpan(item.obligationId)} | ${codeSpan(item.parentSessionId)} | ${codeSpan(item.childSessionId)} | ${cell(item.capturedVerdict)} |`,
      ),
    );
  }
  return lines.join('\n');
}

/** Render the Session Explorer view. */
export function renderExplorerView(view: ExplorerView): string {
  const rows = view.sessions.map(
    (session) =>
      `| ${codeSpan(session.sessionId)} | ${cell(session.role)} | ${session.parentSessionId ? codeSpan(session.parentSessionId) : '—'} | ${cell(session.lineage)} | ${cell(session.state)} | ${cell(session.binding)} | ${cell(session.phase)} | ${cell(session.discoveredBy.join(', '))} |`,
  );
  return [
    '# FlowGuard Session Explorer',
    '',
    `> ${READ_ONLY_NOTICE}`,
    '',
    `**Status:** ${view.status}`,
    `**Root session:** ${codeSpan(view.rootSessionId)}`,
    `**Generated:** ${view.generatedAt}`,
    `**Lineage completeness:** ${view.completeness.lineage}`,
    `**Canonical-state completeness:** ${view.completeness.canonicalState}`,
    '',
    'Known lineage gaps are shown as `not_verified`; no speculative parent or reviewer link is created.',
    '',
    '## Sessions',
    '',
    '| Session | Role | Parent | Lineage | State | Binding | Phase | Discovered by |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| — | — | — | — | — | — | — | — |']),
    '',
    renderReviewLinks(view.reviewLinks),
    '',
    warningsSection(view.warnings),
    '',
    '## Read-only boundary',
    '',
    'This explorer does not start, hydrate, reconcile, approve or repair governance. Unreadable or ambiguous sessions remain visible in the denominator.',
  ].join('\n');
}

function reviewSubjectSection(subject: ReviewSubjectView): string {
  const metadata = [
    `- Kind: ${cell(subject.kind)}`,
    `- Label: ${cell(subject.label, 200)}`,
    `- Revision: ${subject.revision ? codeSpan(subject.revision) : '—'}`,
    `- Subject digest: ${subject.digest ? codeSpan(subject.digest) : '—'}`,
    `- Frozen material digest: ${subject.materialDigest ? codeSpan(subject.materialDigest) : '—'}`,
    `- Subject binding: ${cell(subject.subjectBinding)}`,
    `- Content verification: ${cell(subject.contentVerified)}`,
    `- Review completion: ${cell(subject.reviewCompletion)}`,
    `- Content bytes: ${subject.contentBytes}`,
  ];
  if (subject.paths.length > 0) {
    metadata.push(`- Changed paths: ${subject.paths.map(codeSpan).join(', ')}`);
  }
  return ['## Displayed subject', '', ...metadata].join('\n');
}

function reviewContentSection(subject: ReviewSubjectView): string {
  if (subject.content === null) {
    return '## Subject content\n\nNo verbatim subject content is available; see warnings for the explicit gap.';
  }
  if (subject.contentTruncated) {
    return [
      '## Subject content',
      '',
      `The content exceeds the view budget; the first ${subject.contentBytes} bytes are shown verbatim and the rest is explicitly truncated.`,
      '',
      fenced(subject.content),
    ].join('\n');
  }
  return ['## Subject content', '', fenced(subject.content)].join('\n');
}

function reviewFindingsSection(subject: ReviewSubjectView): string {
  const lines = [
    '## Reviewer',
    '',
    `- Verdict: ${cell(subject.reviewerVerdict)}`,
    `- Reviewed at: ${cell(subject.reviewedAt)}`,
    `- Reviewed obligation: ${subject.reviewedObligationId ? codeSpan(subject.reviewedObligationId) : '—'}`,
    `- Reviewed subject digest: ${subject.reviewedSubjectDigest ? codeSpan(subject.reviewedSubjectDigest) : '—'}`,
    `- Findings version: ${cell(subject.findingsVersion)}`,
  ];
  if (subject.findings.length === 0) {
    lines.push('', 'No blocking or major findings are recorded in the displayed revision.');
  } else {
    lines.push(
      '',
      '### Findings',
      '',
      ...subject.findings.map(
        (finding) =>
          `- **${cell(finding.severity)} / ${cell(finding.category)}** ${cell(finding.message, 500)}${finding.findingId ? ` (${codeSpan(finding.findingId)})` : ''}`,
      ),
    );
  }
  if (subject.findingsTruncated) {
    lines.push('', 'Findings are explicitly truncated to the first 100 entries.');
  }
  if (subject.missingVerification.length > 0) {
    lines.push('', '### Missing verification', '', listOrNone(subject.missingVerification, '—'));
  }
  if (subject.scopeCreep.length > 0) {
    lines.push('', '### Scope creep', '', listOrNone(subject.scopeCreep, '—'));
  }
  if (subject.unknowns.length > 0) {
    lines.push('', '### Unknowns', '', listOrNone(subject.unknowns, '—'));
  }
  return lines.join('\n');
}

function unboundReviewSection(subject: ReviewSubjectView): string | null {
  const unbound = subject.unboundReview;
  if (unbound === null) return null;
  const lines = [
    '## Historical / unassigned reviewer output',
    '',
    'This reviewer output is not bound to the displayed revision and is not a verdict on it.',
    '',
    `- Reason: ${cell(unbound.reason)}`,
    `- Verdict: ${cell(unbound.verdict)}`,
    `- Reviewed at: ${cell(unbound.reviewedAt)}`,
    `- Findings version: ${cell(unbound.findingsVersion)}`,
  ];
  if (unbound.findings.length > 0) {
    lines.push(
      '',
      '### Findings',
      '',
      ...unbound.findings.map(
        (finding) =>
          `- **${cell(finding.severity)} / ${cell(finding.category)}** ${cell(finding.message, 500)}`,
      ),
    );
  }
  if (unbound.findingsTruncated) {
    lines.push('', 'Historical findings are explicitly truncated to the first 100 entries.');
  }
  if (unbound.missingVerification.length > 0) {
    lines.push('', '### Missing verification', '', listOrNone(unbound.missingVerification, '—'));
  }
  if (unbound.scopeCreep.length > 0) {
    lines.push('', '### Scope creep', '', listOrNone(unbound.scopeCreep, '—'));
  }
  if (unbound.unknowns.length > 0) {
    lines.push('', '### Unknowns', '', listOrNone(unbound.unknowns, '—'));
  }
  return lines.join('\n');
}

function historicalImplReviewSection(subject: ReviewSubjectView): string | null {
  const loop = subject.historicalImplReview;
  if (loop === null) return null;
  return [
    '## Historical implementation-review loop',
    '',
    'This loop result is bound to a different implementation digest. It is not the current review verdict.',
    '',
    `- Verdict: ${cell(loop.verdict)}`,
    `- Iteration: ${loop.iteration}`,
    `- Executed at: ${cell(loop.executedAt)}`,
    `- Loop digest: ${codeSpan(loop.currDigest)}`,
    `- Displayed implementation digest: ${codeSpan(loop.expectedDigest)}`,
    `- Reason: ${cell(loop.reason)}`,
  ].join('\n');
}

function proofSection(view: ReviewView): string {
  const proof = view.proof;
  if (proof === null) {
    return '## ProofGraph\n\nNo ProofGraph projection is available.';
  }
  const lines = ['## ProofGraph', ''];
  if (proof.claims.length === 0 && proof.certificates.length === 0) {
    lines.push('No ProofGraph declarations or approval certificates are recorded.');
  }
  if (proof.claims.length > 0) {
    lines.push(
      '### Declarations versus evaluation',
      '',
      '| Claim | Critical | Verification state | Evidence refs | Counterexample refs | Certificate |',
      '| --- | --- | --- | --- | --- | --- |',
      ...proof.claims.map(
        (claim) =>
          `| ${codeSpan(claim.claimId)} ${cell(claim.statement, 100)} | ${claim.critical ? 'yes' : 'no'} | ${cell(claim.verificationState ?? 'not evaluated')} | ${claim.evidenceRefCount} | ${claim.counterexampleRefCount} | ${claim.certificateId ? codeSpan(claim.certificateId) : '—'} |`,
      ),
    );
  }
  if (proof.certificates.length > 0) {
    lines.push(
      '',
      '### Approval certificates',
      '',
      '| Flow | Certificate | Binding | Approved by | Approved at |',
      '| --- | --- | --- | --- | --- |',
      ...proof.certificates.map(
        (certificate) =>
          `| ${cell(certificate.flow)} | ${codeSpan(certificate.certificateId)} | ${cell(certificate.binding)} | ${cell(certificate.approvedBy)} | ${cell(certificate.approvedAt)} |`,
      ),
    );
  }
  if (proof.coverageGaps.length > 0) {
    lines.push(
      '',
      '### Coverage gaps',
      '',
      ...proof.coverageGaps.map(
        (gap) => `- ${cell(gap.cause)}${gap.claimId ? ` (${codeSpan(gap.claimId)})` : ''}`,
      ),
    );
  }
  return lines.join('\n');
}

/** Render the review-view content shell. */
export function renderReviewView(view: ReviewView): string {
  const unbound = unboundReviewSection(view.subject);
  const historicalLoop = historicalImplReviewSection(view.subject);
  return [
    '# FlowGuard Diagnostic Review View',
    '',
    `> ${READ_ONLY_NOTICE}`,
    '',
    `**Status:** ${view.status}`,
    `**Phase:** ${cell(view.phase)}`,
    `**Root session:** ${codeSpan(view.rootSessionId)}`,
    `**Generated:** ${view.generatedAt}`,
    `**Decision authority:** ${view.decisionAuthority === 'not_granted' ? 'NOT GRANTED — this view is read-only' : view.decisionAuthority}`,
    '',
    'Decision controls remain owned by the revision-bound interaction contract in #1196/ADR-011. This view cannot approve, reject, override or mutate governance.',
    '',
    reviewSubjectSection(view.subject),
    '',
    reviewContentSection(view.subject),
    '',
    reviewFindingsSection(view.subject),
    '',
    ...(unbound !== null ? [unbound, ''] : []),
    ...(historicalLoop !== null ? [historicalLoop, ''] : []),
    proofSection(view),
    '',
    renderReviewLinks(view.reviewLinks),
    '',
    warningsSection(view.warnings),
    '',
    '## Read-only boundary',
    '',
    'A reviewer verdict is displayed verbatim. It is not an approval and does not satisfy a human gate. A stale or mismatched subject binding is reported explicitly and must be reopened before any canonical decision.',
  ].join('\n');
}

function filterSummary(view: LogView): string {
  const parts: string[] = [];
  parts.push(
    view.filter.levels.length > 0 ? `levels=${view.filter.levels.join(',')}` : 'levels=all',
  );
  if (view.filter.sessionId) parts.push(`session=${view.filter.sessionId}`);
  if (view.filter.traceId) parts.push(`trace=${view.filter.traceId}`);
  if (view.filter.since) parts.push(`since=${view.filter.since}`);
  if (view.filter.until) parts.push(`until=${view.filter.until}`);
  return parts.join('; ');
}

function logMessage(entry: LogView['entries'][number]): string {
  const fields =
    entry.fields && Object.keys(entry.fields).length > 0
      ? ` ${codeSpan(JSON.stringify(entry.fields))}`
      : '';
  return `${entry.message}${fields}`;
}

/** Render the bounded file-backed log view. */
export function renderLogView(view: LogView): string {
  const rows = view.entries.map(
    (entry) =>
      `| ${cell(entry.ts)} | ${cell(entry.level)} | ${cell(entry.service)} | ${entry.sessionId ? codeSpan(entry.sessionId) : '—'} | ${entry.traceId ? codeSpan(entry.traceId) : '—'} | ${cell(logMessage(entry), 500)} |`,
  );
  const fileLines = view.files.map(
    (file) =>
      `- ${codeSpan(file.file)}: ${file.bytesRead}/${file.fileBytes} bytes read${file.tailOnly ? ' (tail only)' : ''}; modified ${file.modifiedAt}`,
  );
  return [
    '# FlowGuard Diagnostic Log View',
    '',
    `> ${READ_ONLY_NOTICE}`,
    '',
    `**Status:** ${view.status}`,
    `**Directory:** ${view.directory ? codeSpan(view.directory) : 'unavailable'}`,
    `**Generated:** ${view.generatedAt}`,
    `**Filters:** ${filterSummary(view)}`,
    `**Budget:** ${view.bytesRead}/${view.maxBytes} bytes; ${view.entries.length}/${view.maxLines} lines; ${view.files.length} file(s)`,
    '',
    '## Files inspected',
    '',
    view.files.length === 0 ? 'No log files were inspected.' : fileLines.join('\n'),
    '',
    view.filesSkipped > 0
      ? `Explicit file truncation: ${view.filesSkipped} older log file(s) were outside the file budget.`
      : 'No files were skipped by the file budget.',
    '',
    '## Truncation and correlation',
    '',
    view.truncated
      ? `Truncation is active:\n\n${listOrNone(view.truncationReasons, '—')}`
      : 'No truncation was detected in the inspected tail.',
    '',
    `- Entries with session correlation: ${view.correlation.withSessionId}`,
    `- Entries without session correlation: ${view.correlation.withoutSessionId}`,
    `- Entries with trace correlation: ${view.correlation.withTraceId}`,
    `- Entries without trace correlation: ${view.correlation.withoutTraceId}`,
    `- Missing session correlation under the active session filter: ${view.correlation.missingFilteredSessionId}`,
    `- Missing trace correlation under the active trace filter: ${view.correlation.missingFilteredTraceId}`,
    `- Malformed JSONL entries: ${view.parseErrors}`,
    '',
    '## Entries',
    '',
    '| Timestamp | Level | Service | Session | Trace | Message |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0
      ? rows
      : ['| — | — | — | — | — | No matching entries in the inspected tail. |']),
    '',
    '## Read-only boundary',
    '',
    view.note,
    '',
    'No logger, log file or persistent view state was created by this view.',
  ].join('\n');
}

/** Render the explicit notification-delivery capability report. */
export function renderNotificationView(view: NotificationView): string {
  return [
    '# FlowGuard Diagnostic Notifications',
    '',
    `> ${READ_ONLY_NOTICE}`,
    '',
    `**Status:** ${view.status}`,
    `**Delivery:** ${view.delivery}`,
    `**Generated:** ${view.generatedAt}`,
    '',
    '## Reason',
    '',
    view.reason,
    '',
    '## Fallback',
    '',
    `- Kind: ${view.fallback.kind}`,
    `- Directory: ${view.fallback.directory ? codeSpan(view.fallback.directory) : 'unavailable'}`,
    `- ${view.fallback.note}`,
    '',
    '## Constraints',
    '',
    listOrNone(view.constraints, '—'),
    '',
    '## Read-only boundary',
    '',
    'No toast, panel, notification or governance action was attempted. Installed Desktop/TUI delivery remains unsupported until an installed pinned-host proof exists.',
  ].join('\n');
}

/** Render the `/diagnostics` usage index. */
export function renderDiagnosticsHelp(): string {
  return [
    '# FlowGuard Diagnostics',
    '',
    `> ${READ_ONLY_NOTICE}`,
    '',
    'Use one of the read-only modes:',
    '',
    '- `/diagnostics explorer` — exact known lineage, gaps and review-assurance IDs.',
    '- `/diagnostics review` — displayed subject revision/digest, reviewer verdict, findings and ProofGraph declarations.',
    '- `/diagnostics logs` — bounded tail of the existing JSONL file logs.',
    '- `/diagnostics logs level=warn,error session=<id> trace=<id> since=<iso> until=<iso> limit=<n>` — filtered log tail.',
    '- `/diagnostics notifications` — explicit delivery capability and file-log fallback.',
    '',
    'All modes are projections over existing authorities. None is evidence, approval or authorization.',
  ].join('\n');
}
