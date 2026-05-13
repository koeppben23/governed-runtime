/**
 * @module evidence-binding
 * @description Workspace binding schema — links an OpenCode session to a git worktree.
 *
 * @version v1
 */

import { z } from 'zod';
import { FINGERPRINT_PATTERN } from '../shared/flowguard-identifiers.js';
import { OpenCodeSessionId } from './evidence-primitives.js';

/**
 * Workspace binding resolved during init().
 * Links an OpenCode session to a git worktree and workspace registry.
 * Populated by context.sessionID and context.worktree from the Custom Tool API.
 *
 * fingerprint: 24-hex repository fingerprint derived from the canonical remote
 * URL (or local path fallback). Used as the workspace directory name under
 * ~/.config/opencode/workspaces/{fingerprint}/. Deterministic and stable
 * across clones of the same remote.
 */
export const BindingInfo = z
  .object({
    sessionId: OpenCodeSessionId,
    worktree: z.string().min(1),
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
    resolvedAt: z.string().datetime(),
  })
  .readonly();
export type BindingInfo = z.infer<typeof BindingInfo>;
