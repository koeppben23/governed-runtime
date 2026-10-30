/** Strict, bounded JSON decoding. Never extracts, repairs, or normalizes model text. */
import { visit } from 'jsonc-parser';

export const JSON_OBJECT_BYTE_LIMIT = 1_048_576;
const MAX_DEPTH = 64;
const MAX_VALUES = 100_000;

class JsonBoundaryError extends Error {
  readonly code = 'STRICT_JSON_INVALID';
}

export type JsonObjectResult =
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'invalid'; readonly reason: string };

export function parseStrictJsonObject(text: string): JsonObjectResult {
  if (Buffer.byteLength(text, 'utf8') > JSON_OBJECT_BYTE_LIMIT) {
    return { kind: 'invalid', reason: 'JSON payload exceeds the 1 MiB byte limit.' };
  }
  const containers: Array<Set<string> | null> = [];
  let values = 0;
  const count = (): void => {
    if (++values > MAX_VALUES) throw new JsonBoundaryError('JSON value limit exceeded.');
  };
  const begin = (keys: Set<string> | null): void => {
    count();
    if (containers.length >= MAX_DEPTH) throw new JsonBoundaryError('JSON depth limit exceeded.');
    containers.push(keys);
  };
  try {
    visit(
      text,
      {
        onObjectBegin: () => begin(new Set()),
        onArrayBegin: () => begin(null),
        onObjectEnd: () => {
          containers.pop();
        },
        onArrayEnd: () => {
          containers.pop();
        },
        onObjectProperty: (key) => {
          const keys = containers.at(-1);
          if (!keys || keys.has(key)) throw new JsonBoundaryError('Duplicate JSON object key.');
          keys.add(key);
        },
        onLiteralValue: (value: unknown) => {
          count();
          if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new JsonBoundaryError('Non-finite JSON number.');
          }
        },
        onError: () => {
          throw new JsonBoundaryError('Expected exactly one strict JSON object.');
        },
      },
      { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
    );
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'invalid', reason: 'Expected one JSON object, without prose or Markdown.' };
    }
    return { kind: 'ok', value: value as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof JsonBoundaryError) && !(error instanceof SyntaxError)) throw error;
    return {
      kind: 'invalid',
      reason:
        error instanceof JsonBoundaryError
          ? error.message
          : 'Expected exactly one strict JSON object.',
    };
  }
}
