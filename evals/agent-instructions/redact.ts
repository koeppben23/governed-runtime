/**
 * Redact every explicitly declared non-empty secret value before persistence.
 * Longest-first ordering avoids partial replacement when one secret is a prefix
 * of another. Secret length is never treated as a proxy for sensitivity.
 */
export function redactSecrets(text: string, values: readonly string[]): string {
  const secrets = [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join('***REDACTED***');
  }
  return result;
}
