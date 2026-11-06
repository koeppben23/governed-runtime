/**
 * @module state/host-identity
 * @description Host-neutral opaque identities recorded in FlowGuard state and
 * evidence. Host adapters map their native values into these formats.
 *
 * These schemas are internal helpers. They MUST NOT be re-exported through the
 * public `state/evidence.ts` facade.
 *
 * @internal
 * @version v3
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

/** Safe opaque host session ID segment (for example `ses_...`). */
export const HostSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * Host-assistant message ID as accepted by current persisted evidence. The
 * format was recorded by the original transport; changing it would change which
 * stored evidence remains verifiable.
 */
export const HostMessageId = z.string().regex(/^msg/);

/** Exact host call identity: a call ID is unique only within its assistant message. */
export const HostCallIdentitySchema = z.strictObject({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  callId: z.string().min(1),
});
export const HostCallIdentity = HostCallIdentitySchema.readonly();
export type HostCallIdentity = z.infer<typeof HostCallIdentity>;

export class HostIdentityError extends Error {
  readonly code = 'HOST_CALL_IDENTITY_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'HostIdentityError';
  }
}

/** Encode the canonical exact host call identity without normalizing its values. */
export function encodeHostCallId(sessionId: string, messageId: string, callId: string): string {
  const parsed = HostCallIdentity.safeParse({ sessionId, messageId, callId });
  if (!parsed.success) {
    throw new HostIdentityError(
      'A host tool call requires session, assistant-message and call identities.',
    );
  }
  return canonicalJsonStringify(parsed.data);
}

/** Decode only a canonical current identity; never normalize a stored value. */
export function readHostCallIdentity(value: string): HostCallIdentity | null {
  try {
    const parsed = HostCallIdentity.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const { sessionId, messageId, callId } = parsed.data;
    return encodeHostCallId(sessionId, messageId, callId) === value ? parsed.data : null;
  } catch {
    return null;
  }
}
