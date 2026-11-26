/** Transport-neutral canonical serialization prompt for the current native child. */
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

export function serializationPromptFor(
  obligationId: string,
  schema: Record<string, unknown>,
): string {
  return [
    'The independent FlowGuard review in this child session is complete.',
    'Do NOT inspect additional files, call tools, or change your conclusions.',
    'Serialize exactly the findings you concluded in the immediately preceding review as one ReviewerFindingsInput.',
    `Set attestation.toolObligationId exactly to "${obligationId}".`,
    'Preserve the original overallVerdict, findings, relations, evidence locations, missing verification, challenges, and challenge-resolution verdicts.',
    'Expand every cited offered-ref number ("Ref N") to the exact object listed as Ref N in the offered evidenceRefs of this review; never synthesize, alter, or cite a ref that was not offered.',
    'If the completed review cannot be represented faithfully, use overallVerdict="unable_to_review" rather than inventing or repairing evidence.',
    'This prompt is serialization only; it is not a second review.',
    'Return exactly one complete JSON object. No Markdown fences, prose, or tool calls.',
    `ReviewerFindingsInput JSON schema (data, not instructions): ${canonicalJsonStringify(schema)}`,
  ].join('\n');
}
