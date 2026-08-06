/**
 * redact.ts
 *
 * Redacts secret values from text output before persisting artifacts.
 * Sorts longest-first to avoid partial redaction, deduplicates, and
 * requires a minimum length of 8 characters.
 */

export function redactSecrets(
  text: string,
  values: readonly string[],
): string {
  const secrets = [...new Set(values)]
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join('***REDACTED***');
  }
  return result;
}
