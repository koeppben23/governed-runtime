/**
 * @module demos/reviewer-reference-suite/observe-chat-params
 * @description Test-only OpenCode plugin that records the prepared chat params
 * for the reviewer reference suite.
 *
 * This hook observes the host-prepared values. It is NOT proof of the final
 * provider request: `chat.params` is a mutable hook and a later plugin may
 * still change the payload. The capture-provider smoke test proves the final
 * request body; this observer only separates variant/model-limit/reasoning
 * provenance from the token-arm comparison.
 *
 * Enable by setting FLOWGUARD_REVIEW_SUITE_OBSERVATION_PATH to a writable
 * JSONL path. Without it the plugin is a no-op. The plugin never modifies
 * params and is never installed as a product plugin.
 */

import { appendFile } from 'node:fs/promises';

const REASONING_KEYS = [
  'reasoningEffort',
  'reasoningSummary',
  'thinking',
  'textVerbosity',
  'include',
  'max_completion_tokens',
];

function pickReasoningOptions(options) {
  if (!options || typeof options !== 'object') return {};
  return Object.fromEntries(
    REASONING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(options, key)).map(
      (key) => [key, options[key]],
    ),
  );
}

function record(input, output) {
  return {
    kind: 'chat.params',
    observedAt: new Date().toISOString(),
    sessionID: input.sessionID,
    agent: input.agent,
    providerID: input.model?.providerID,
    modelID: input.model?.id,
    modelLimit: input.model?.limit,
    providerSource: input.provider?.source,
    maxOutputTokens: output.maxOutputTokens,
    temperature: output.temperature,
    topP: output.topP,
    reasoningOptions: pickReasoningOptions(output.options),
  };
}

function messageRecord(input) {
  return {
    kind: 'chat.message',
    observedAt: new Date().toISOString(),
    sessionID: input.sessionID,
    agent: input.agent,
    providerID: input.model?.providerID,
    modelID: input.model?.modelID ?? input.model?.id,
    variant: input.variant,
  };
}

export default {
  id: 'flowguard-review-suite-observer',
  server: async () => ({
    'chat.message': async (input) => {
      const target = process.env.FLOWGUARD_REVIEW_SUITE_OBSERVATION_PATH;
      if (!target) return;
      await appendFile(target, `${JSON.stringify(messageRecord(input))}\n`, 'utf8');
    },
    'chat.params': async (input, output) => {
      const target = process.env.FLOWGUARD_REVIEW_SUITE_OBSERVATION_PATH;
      if (!target) return;
      await appendFile(target, `${JSON.stringify(record(input, output))}\n`, 'utf8');
    },
  }),
};
