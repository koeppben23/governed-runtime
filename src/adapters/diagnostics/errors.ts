/** Typed diagnostic-export boundary errors. */

export type DiagnosticExportErrorCode =
  'OUTPUT_EXISTS' | 'OUTPUT_INVALID' | 'WRITE_FAILED' | 'INVALID_SESSION_ID' | 'MANIFEST_TOO_LARGE';

export class DiagnosticExportError extends Error {
  readonly code: DiagnosticExportErrorCode;

  constructor(code: DiagnosticExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiagnosticExportError';
    this.code = code;
  }
}
