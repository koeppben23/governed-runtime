/**
 * @module integration/plugin-orchestrator
 * @description Runtime-facing review orchestration types.
 *
 * Independent review is executed through the visible native reviewer subagent
 * transport (`review/dispatch/native-review-dispatch.ts`), with durable
 * dispatch lineage in `review/dispatch/durable-dispatch.ts` and capture/evidence
 * binding in `review/dispatch/native-review-capture.ts` and
 * `review/dispatch/native-review-evidence.ts`. The former SDK autospawn
 * dispatcher and its pipelines were removed; this module now only owns the
 * shared `OrchestratorDeps` surface consumed by the plugin runtime and the
 * native review lifecycle.
 *
 * @version v3
 */

export type { OrchestratorDeps } from './review/pipeline-types.js';
