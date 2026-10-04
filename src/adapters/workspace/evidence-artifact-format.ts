/**
 * @module adapters/workspace/evidence-artifact-format
 * @description Deterministic markdown rendering for derived ticket and plan
 * evidence artifacts. The rendered body is hashed into the artifact metadata.
 *
 * @version v1
 */

export function formatTicketMarkdown(
  version: number,
  ticketText: string,
  createdAt: string,
  sessionId: string,
): string {
  return [
    `# Ticket v${version}`,
    '',
    `- Session: ${sessionId}`,
    `- Created At: ${createdAt}`,
    '',
    '## Ticket Text',
    '',
    ticketText,
    '',
  ].join('\n');
}

export function formatPlanMarkdown(
  version: number,
  planBody: string,
  createdAt: string,
  sessionId: string,
): string {
  return [
    `# Plan v${version}`,
    '',
    `- Session: ${sessionId}`,
    `- Created At: ${createdAt}`,
    '',
    planBody,
    '',
  ].join('\n');
}
