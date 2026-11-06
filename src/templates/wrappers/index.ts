/** One auto-discovered native V2 plugin. Tools are registered by its setup. */
export const PLUGIN_RELATIVE_PATH = 'plugins/flowguard/index.ts';

export const PLUGIN_WRAPPER = `\
/** FlowGuard native OpenCode V2 plugin; installation does not activate governance. */
export { default } from "@flowguard/core/integration/plugin";
`;

/** Optional TUI companion; absence or an unsupported host leaves Markdown as fallback. */
export const TUI_PLUGIN_RELATIVE_PATH = 'plugins/flowguard/tui.ts';

export const TUI_PLUGIN_WRAPPER = `\
/** FlowGuard optional OpenCode TUI workflow chooser; never a governance authority. */
export { default } from "@flowguard/core/integration/tui-plugin";
`;
