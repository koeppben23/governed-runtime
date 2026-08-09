/**
 * @module integration/tools/presentation-telemetry
 * @description Presentation telemetry emission for mutating-tool boundaries.
 *
 * Observes PresentationDocument emission and conclusion actions
 * without affecting the canonical FlowGuard result.
 *
 * @version v1
 */

import type { PresentationDocument } from '../../presentation/index.js';
import { emitTelemetryEvent } from '../../telemetry/human-projection/emitter.js';

export function emitPresentationTelemetry(
  document: PresentationDocument,
  phase: string,
  sessionId: string,
): void {
  emitRendered(document, sessionId, phase);
  emitConclusionActions(document, sessionId, phase);
}

function emitRendered(document: PresentationDocument, sessionId: string, phase: string): void {
  const payload: Record<string, unknown> = {
    event: 'presentation_rendered',
    documentKind: document.kind,
  };
  if ('form' in document && document.form) payload.form = document.form;
  if ('conclusion' in document && document.conclusion) {
    payload.conclusionKind = document.conclusion.kind;
  }
  emitTelemetryEvent(payload, sessionId, phase);
}

function emitConclusionActions(
  document: PresentationDocument,
  sessionId: string,
  phase: string,
): void {
  if (!('conclusion' in document) || !document.conclusion) return;
  const c = document.conclusion;
  if (c.kind === 'next_action' && c.action) {
    emitTelemetryEvent(
      {
        event: 'action_presented',
        intent: (c.action as unknown as Record<string, unknown>).intent,
        visibility: c.action.visibility,
        conclusionKind: 'next_action',
      },
      sessionId,
      phase,
    );
  } else if (c.kind === 'decision_required' && c.actions) {
    for (const action of c.actions) {
      emitTelemetryEvent(
        {
          event: 'action_presented',
          intent: (action as unknown as Record<string, unknown>).intent,
          visibility: action.visibility,
          conclusionKind: 'decision_required',
        },
        sessionId,
        phase,
      );
    }
  }
}
