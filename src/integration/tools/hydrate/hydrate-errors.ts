/**
 * @module integration/tools/hydrate/hydrate-errors
 * @description Shared error-throwing authority for hydrate sub-modules.
 *
 * @version v1
 */

class HydrateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HydrateError';
    this.code = code;
  }
}

export function throwHydrateError(code: string, message: string): never {
  throw new HydrateError(code, message);
}
