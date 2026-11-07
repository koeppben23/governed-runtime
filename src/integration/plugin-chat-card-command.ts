/** Explicit read-only inline chat card. No model turn, hydration or governance mutation. */
import type { Plugin } from '@opencode/plugin';

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];

/** The fenced payload carries no authority, state, policy or review content. */
export const FLOWGUARD_CHAT_CARD_MARKDOWN = [
  '## FlowGuard — current session',
  '',
  'The inline card is a read-only live projection. It is not a durable review',
  'snapshot, operator approval, or proof of a workflow transition.',
  '',
  '```flowguard-live',
  'v1',
  '```',
  '',
  'On unsupported surfaces, use /status or open the FlowGuard Workbench.',
].join('\n');

export function addChatCardCommand(ctx: Plugin.Context, editor: CommandEditor): void {
  editor.add({
    name: 'flowguard-card',
    description: 'FlowGuard — show an optional read-only live status card in chat (Desktop), with Markdown fallback.',
    execute: async (input) => {
      // Synthetic messages do not resume the agent. No state is read or modified here;
      // the GUI reads canonical status via the existing read-only RPC.
      await ctx.session.synthetic({
        sessionID: input.sessionID,
        text: FLOWGUARD_CHAT_CARD_MARKDOWN,
        resume: false,
      });
    },
  });
}
