/** Typed diagnostic-view boundary errors. */

export type DiagnosticViewErrorCode = 'INVALID_FILTER' | 'INVALID_LIMIT';

export class DiagnosticViewError extends Error {
  readonly code: DiagnosticViewErrorCode;

  constructor(code: DiagnosticViewErrorCode, message: string) {
    super(message);
    this.name = 'DiagnosticViewError';
    this.code = code;
  }
}
