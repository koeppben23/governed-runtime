/**
 * @module integration/tools
 * @description Barrel export for FlowGuard tool definitions.
 *
 * Re-exports 11 tools from focused modules:
 * - helpers.ts        — shared interfaces, formatters, workspace/state/policy helpers
 * - hydrate.ts        — session bootstrap with discovery and profile resolution
 * - plan.ts           — plan submission and self-review loop
 * - implement.ts      — implementation recording and review loop
 * - architecture.ts   — ADR submission and self-review loop
 * - status-tool.ts    — read-only session state check
 * - decision-tool.ts  — human review verdict at user gates
 * - validate-tool.ts  — validation check result recording
 * - simple-tools.ts   — ticket, review, abort, archive
 *
 * Barrel re-exports are resolved by the post-build ESM import fixer.
 *
 * @version v5
 */

import { status as rawStatus } from './status-tool.js';
import { decision as rawDecision } from './decision-tool.js';
import { validate as rawValidate } from './validate-tool.js';
import {
  ticket as rawTicket,
  review as rawReview,
  abort_session as rawAbortSession,
  archive as rawArchive,
} from './simple-tools.js';
import { hydrate as rawHydrate } from './hydrate.js';
import { plan as rawPlan } from './plan.js';
import { implement as rawImplement } from './implement.js';
import { architecture as rawArchitecture } from './architecture.js';

// ── Focused tools ────────────────────────────────────────────────────────────
export const status = rawStatus;
export const decision = rawDecision;
export const validate = rawValidate;

// ── Simple tools ─────────────────────────────────────────────────────────────
export const ticket = rawTicket;
export const review = rawReview;
export const abort_session = rawAbortSession;
export const archive = rawArchive;

// ── Complex tools ────────────────────────────────────────────────────────────
export const hydrate = rawHydrate;
export const plan = rawPlan;
export const implement = rawImplement;
export const architecture = rawArchitecture;
