import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';

import { addChatCardCommand, FLOWGUARD_CHAT_CARD_MARKDOWN } from './plugin-start-command.js';

describe('native read-only chat card', () => {
  it('publishes a bounded marker with no state, digest, or approval payload', () => {
    expect(FLOWGUARD_CHAT_CARD_MARKDOWN).toContain('```flowguard-live\nv1\n```');
    expect(FLOWGUARD_CHAT_CARD_MARKDOWN).toContain('not a durable review');
    expect(FLOWGUARD_CHAT_CARD_MARKDOWN).not.toContain('/approve');
  });

  it('publishes once without starting the model or executing a workflow', async () => {
    const synthetic = vi.fn(async () => undefined);
    const commands: Array<{
      name: string;
      execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>;
    }> = [];
    const context = { session: { synthetic } } as unknown as Plugin.Context;
    const editor = {
      add: (entry: (typeof commands)[number]) => {
        commands.push(entry);
      },
    } as unknown as Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
    addChatCardCommand(context, editor);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('flowguard-card');
    const command = commands[0];
    if (!command) throw new Error('No chat-card command registered');
    await command.execute({ sessionID: 'ses_root', prompt: { text: '' } });
    expect(synthetic).toHaveBeenCalledTimes(1);
    expect(synthetic).toHaveBeenCalledWith({
      sessionID: 'ses_root',
      text: FLOWGUARD_CHAT_CARD_MARKDOWN,
      resume: false,
    });
  });
});
