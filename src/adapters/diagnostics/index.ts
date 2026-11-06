/** Read-only diagnostic export surface. Not governance evidence. */
export { DiagnosticExportError, writeDiagnosticExport } from './export.js';
export {
  DEFAULT_DIAGNOSTIC_LIMITS,
  type DiagnosticExportLimits,
  type DiagnosticManifest,
} from './export-schema.js';
export {
  DiagnosticHostError,
  normalizeHostTranscript,
  validateHostTranscript,
  type HostTranscript,
} from './host-transcript.js';
