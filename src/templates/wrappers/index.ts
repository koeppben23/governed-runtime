/** One auto-discovered native V2 plugin. Tools are registered by its setup. */
export const PLUGIN_RELATIVE_PATH = 'plugins/flowguard/index.ts';

export const PLUGIN_WRAPPER = `\
/** FlowGuard native OpenCode V2 plugin; installation does not activate governance. */
export { default } from "@flowguard/core/integration/plugin";
`;
