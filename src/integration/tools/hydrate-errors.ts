/**
 * @module integration/tools/hydrate-errors
 * @description Shared error-throwing authority for hydrate sub-modules.
 *
 * @version v1
 */

export function throwHydrateError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
