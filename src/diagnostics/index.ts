/**
 * @module diagnostics
 * @description Runtime diagnostics presentation barrel.
 */

export type { DiagnosticSeverity, RuntimeDiagnostics } from './types.js';
export { buildBlockedDiagnostics } from './builders.js';
export { formatDiagnosticCard } from './format-card.js';
