/** Canonical operator notice for the effective frozen gate behavior. */
export function buildGateNotice(
  gateBehavior: string | undefined,
  mode: string | undefined,
): string | null {
  if (gateBehavior !== 'auto_approve') return null;
  return (
    `Auto-approve is active (mode: ${mode ?? 'unknown'}). ` +
    'Plan and evidence review gates advance WITHOUT a human decision. ' +
    'Use team or regulated for human-gated approval.'
  );
}
