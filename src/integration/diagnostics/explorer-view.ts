/**
 * @module integration/diagnostics/explorer-view
 * @description Read-only session lineage projection for the Session Explorer.
 *
 * The explorer resolves only positively linked children. An ambiguous or
 * unlinked candidate stays visible with `lineage: not_verified` and is never
 * read. No state, audit or host transcript is written.
 */

import { DEFAULT_DIAGNOSTIC_LIMITS } from '../../adapters/diagnostics/export-schema.js';
import { discoverReviewSessions } from '../../adapters/diagnostics/session-discovery.js';
import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { warning, type SessionDiscovery } from '../../adapters/diagnostics/types.js';
import { resolveSessionAuthority } from '../../adapters/session-authority.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import type { SessionAuthorityResolution } from '../../adapters/session-authority.js';
import type { SessionState } from '../../state/schema.js';
import type { ExplorerSessionNode, ExplorerView } from './types.js';
import { projectReviewLinks } from './review-links.js';

export interface ExplorerViewRequest {
  readonly root: string;
  readonly sessionId: string;
  readonly maxSessions?: number;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
}

function sanitizedWarning(
  code: string,
  message: string,
  sessionId: string | null,
  source: DiagnosticWarning['source'],
): DiagnosticWarning {
  return warning(code, sanitizeDiagnosticString(message), sessionId, source);
}

function bindingStatus(resolution: SessionAuthorityResolution): ExplorerSessionNode['binding'] {
  if (resolution.status === 'resolved') return 'verified';
  if (
    resolution.status === 'unavailable' &&
    /BINDING|WORKTREE|FINGERPRINT|WORKSPACE_MISMATCH/.test(resolution.code)
  ) {
    return 'mismatch';
  }
  return 'unknown';
}

function sessionState(resolution: SessionAuthorityResolution): ExplorerSessionNode['state'] {
  return resolution.status === 'resolved'
    ? 'captured'
    : resolution.status === 'absent'
      ? 'absent'
      : 'unavailable';
}

function appendResolutionWarning(
  warnings: DiagnosticWarning[],
  resolution: SessionAuthorityResolution,
  sessionId: string,
): void {
  if (resolution.status === 'resolved') return;
  if (resolution.status === 'absent') {
    warnings.push(
      sanitizedWarning(
        'SESSION_STATE_ABSENT',
        'No FlowGuard state exists for this known session.',
        sessionId,
        'state',
      ),
    );
    return;
  }
  warnings.push(
    sanitizedWarning(
      `SESSION_${resolution.code}`,
      `Known session could not be resolved: ${resolution.reason}`,
      sessionId,
      'state',
    ),
  );
}

function unresolvedRootNode(
  sessionId: string,
  resolution: SessionAuthorityResolution,
  warnings: readonly DiagnosticWarning[],
): ExplorerSessionNode {
  return {
    sessionId,
    parentSessionId: null,
    role: 'root',
    discoveredBy: ['root'],
    state: sessionState(resolution),
    lineage: 'verified',
    phase: null,
    binding: bindingStatus(resolution),
    warningCodes: warnings
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.code),
  };
}

/**
 * Build the explorer projection for the requested root session.
 *
 * Completeness uses the same denominator-preserving semantics as the debug
 * export: a known but unverified child stays visible and prevents `COMPLETE`.
 */
function unresolvedExplorerView(
  request: ExplorerViewRequest,
  resolution: SessionAuthorityResolution,
  warnings: DiagnosticWarning[],
  generatedAt: string,
): ExplorerView {
  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'explorer',
    rootSessionId: request.sessionId,
    generatedAt,
    status: 'NOT_VERIFIED',
    completeness: { lineage: 'not_verified', canonicalState: 'not_verified' },
    sessions: [unresolvedRootNode(request.sessionId, resolution, warnings)],
    reviewLinks: null,
    warnings,
  };
}

function unverifiedChildNode(
  sessionId: string,
  discovery: SessionDiscovery,
  warnings: DiagnosticWarning[],
): ExplorerSessionNode {
  warnings.push(
    sanitizedWarning(
      'SESSION_LINEAGE_NOT_VERIFIED',
      'Known session was retained in the graph but not read because its lineage to the requested root is not positively established.',
      sessionId,
      'review',
    ),
  );
  return {
    sessionId,
    parentSessionId: discovery.parentSessionId,
    role: 'reviewer',
    discoveredBy: [...discovery.sources],
    state: 'unavailable',
    lineage: 'not_verified',
    phase: null,
    binding: 'unknown',
    warningCodes: ['SESSION_LINEAGE_NOT_VERIFIED'],
  };
}

async function verifiedChildNode(
  root: string,
  sessionId: string,
  discovery: SessionDiscovery,
  warnings: DiagnosticWarning[],
): Promise<ExplorerSessionNode> {
  const resolution = await resolveSessionAuthority({ root, sessionId });
  appendResolutionWarning(warnings, resolution, sessionId);
  return {
    sessionId,
    parentSessionId: discovery.parentSessionId,
    role: 'reviewer',
    discoveredBy: [...discovery.sources],
    state: sessionState(resolution),
    lineage: 'verified',
    phase: resolution.status === 'resolved' ? resolution.state.phase : null,
    binding: bindingStatus(resolution),
    warningCodes: warnings
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.code),
  };
}

async function collectChildren(
  request: ExplorerViewRequest,
  rootState: SessionState,
  sessions: ExplorerSessionNode[],
  warnings: DiagnosticWarning[],
  maxSessions: number,
): Promise<boolean> {
  let truncated = false;
  for (const [sessionId, discovery] of discoverReviewSessions(rootState, request.sessionId)) {
    if (sessionId === request.sessionId) continue;
    if (sessions.length >= maxSessions) {
      truncated = true;
      warnings.push(
        sanitizedWarning(
          'SESSION_LIMIT_TRUNCATED',
          `Known session ${sessionId} was not projected because the ${maxSessions}-session view limit was reached.`,
          sessionId,
          'capture',
        ),
      );
      continue;
    }
    sessions.push(
      discovery.lineage !== 'verified'
        ? unverifiedChildNode(sessionId, discovery, warnings)
        : await verifiedChildNode(request.root, sessionId, discovery, warnings),
    );
  }
  return truncated;
}

function completenessFor(
  sessions: readonly ExplorerSessionNode[],
  truncated: boolean,
  warnings: readonly DiagnosticWarning[],
): Pick<ExplorerView, 'completeness' | 'status'> {
  const lineage =
    truncated || sessions.some((session) => session.lineage === 'not_verified')
      ? 'partial'
      : 'complete';
  const canonicalState =
    truncated ||
    sessions.some(
      (session) =>
        session.lineage === 'verified' &&
        (session.state === 'absent' || session.state === 'unavailable'),
    )
      ? 'partial'
      : 'complete';
  return {
    completeness: { lineage, canonicalState },
    status:
      truncated || lineage !== 'complete' || canonicalState !== 'complete' || warnings.length > 0
        ? 'PARTIAL'
        : 'COMPLETE',
  };
}

/**
 * Build the explorer projection for the requested root session.
 *
 * Completeness uses the same denominator-preserving semantics as the debug
 * export: a known but unverified child stays visible and prevents `COMPLETE`.
 */
export async function buildExplorerView(request: ExplorerViewRequest): Promise<ExplorerView> {
  const generatedAt = (request.now ?? (() => new Date()))().toISOString();
  const maxSessions = request.maxSessions ?? DEFAULT_DIAGNOSTIC_LIMITS.maxSessions;
  const warnings: DiagnosticWarning[] = [];
  const sessions: ExplorerSessionNode[] = [];

  const rootResolution = await resolveSessionAuthority({
    root: request.root,
    sessionId: request.sessionId,
  });
  appendResolutionWarning(warnings, rootResolution, request.sessionId);
  if (rootResolution.status !== 'resolved') {
    return unresolvedExplorerView(request, rootResolution, warnings, generatedAt);
  }

  const rootState = rootResolution.state;
  sessions.push({
    sessionId: request.sessionId,
    parentSessionId: null,
    role: 'root',
    discoveredBy: ['root'],
    state: 'captured',
    lineage: 'verified',
    phase: rootState.phase,
    binding: 'verified',
    warningCodes: [],
  });
  const truncated = await collectChildren(request, rootState, sessions, warnings, maxSessions);
  const reviewLinks = projectReviewLinks(rootState, warnings);
  const { completeness, status } = completenessFor(sessions, truncated, warnings);

  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'explorer',
    rootSessionId: request.sessionId,
    generatedAt,
    status,
    completeness,
    sessions,
    reviewLinks,
    warnings,
  };
}
