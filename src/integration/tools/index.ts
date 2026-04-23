/**
 * @module integration/tools
 * @description Barrel export for FlowGuard tool definitions.
 *
 * Re-exports 11 tools from focused modules:
 * - helpers.ts       — shared interfaces, formatters, workspace/state/policy helpers
 * - hydrate.ts       — session bootstrap with discovery and profile resolution
 * - plan.ts          — plan submission and self-review loop
 * - implement.ts     — implementation recording and review loop
 * - architecture.ts  — ADR submission and self-review loop
 * - simple-tools.ts  — status, ticket, decision, validate, review, abort, archive
 *
 * Barrel re-exports are resolved by the post-build ESM import fixer.
 *
 * @version v4
 */

import type { ToolDefinition } from './helpers.js';
import {
  status as rawStatus,
  ticket as rawTicket,
  decision as rawDecision,
  validate as rawValidate,
  review as rawReview,
  abort_session as rawAbortSession,
  archive as rawArchive,
} from './simple-tools.js';
import { hydrate as rawHydrate } from './hydrate.js';
import { plan as rawPlan } from './plan.js';
import { implement as rawImplement } from './implement.js';
import { architecture as rawArchitecture } from './architecture.js';

function zodCompat(tool: ToolDefinition): ToolDefinition {
  for (const schema of Object.values(tool.args)) {
    if (schema && typeof schema === 'object') {
      const candidate = schema as { _def?: unknown; _zod?: { def: unknown } };
      if (!candidate._zod && candidate._def) {
        Object.defineProperty(candidate, '_zod', {
          value: { def: candidate._def },
          enumerable: false,
          configurable: true,
        });
      }
    }
  }
  return tool;
}

// ── Simple tools ─────────────────────────────────────────────────────────────
export const status = zodCompat(rawStatus);
export const ticket = zodCompat(rawTicket);
export const decision = zodCompat(rawDecision);
export const validate = zodCompat(rawValidate);
export const review = zodCompat(rawReview);
export const abort_session = zodCompat(rawAbortSession);
export const archive = zodCompat(rawArchive);

// ── Complex tools ────────────────────────────────────────────────────────────
export const hydrate = zodCompat(rawHydrate);
export const plan = zodCompat(rawPlan);
export const implement = zodCompat(rawImplement);
export const architecture = zodCompat(rawArchitecture);
