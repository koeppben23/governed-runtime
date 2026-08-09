/**
 * @module integration/tools/presentation-telemetry
 * @description Presentation telemetry emission for mutating-tool boundaries.
 *
 * Observes PresentationDocument emission and conclusion actions
 * without affecting the canonical FlowGuard result.
 *
 * @version v2
 */

import type { PresentationDocument, PresentationAction } from '../../presentation/index.js';
import {
  emitTelemetryEvent,
  type TelemetryEventBody,
} from '../../telemetry/human-projection/emitter.js';

export function emitPresentationTelemetry(
  document: PresentationDocument,
  phase: string,
  sessionId: string,
): void {
  emitRendered(document, sessionId, phase);
  emitConclusionActions(document, sessionId, phase);
}

function emitRendered(document: PresentationDocument, sessionId: string, phase: string): void {
  const body: TelemetryEventBody = {
    event: 'presentation_rendered',
    documentKind: document.kind as 'compact_card' | 'review_card' | 'diagnostic_card',
    ...('form' in document && document.form ? { form: document.form } : {}),
    ...('conclusion' in document && document.conclusion
      ? { conclusionKind: document.conclusion.kind as string }
      : {}),
  };
  emitTelemetryEvent(body, sessionId, phase);
}

function emitConclusionActions(
  document: PresentationDocument,
  sessionId: string,
  phase: string,
): void {
  if (!('conclusion' in document) || !document.conclusion) return;
  const c = document.conclusion;
  if (c.kind === 'next_action' && c.action) {
    emitActionPresented(c.action, 'next_action', sessionId, phase);
  } else if (c.kind === 'decision_required' && c.actions) {
    for (const action of c.actions) {
      emitActionPresented(action, 'decision_required', sessionId, phase);
    }
  }
}

function emitActionPresented(
  action: PresentationAction,
  conclusionKind: 'next_action' | 'decision_required',
  sessionId: string,
  phase: string,
): void {
  const body: TelemetryEventBody = {
    event: 'action_presented',
    intent: action.intent,
    visibility: action.visibility,
    conclusionKind,
  };
  emitTelemetryEvent(body, sessionId, phase);
}
