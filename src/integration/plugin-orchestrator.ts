/**
 * @module integration/plugin-orchestrator
 * @description Runtime-facing review orchestration types.
 *
 * Independent review is executed through the visible native Task transport
 * (`src/integration/native-task-review.ts`). The former SDK autospawn
 * dispatcher and its pipelines were removed; this module now only owns the
 * shared `OrchestratorDeps` surface consumed by the plugin runtime and the
 * native review lifecycle.
 *
 * @version v3
 */

export type { OrchestratorDeps } from './review/pipeline-types.js';
