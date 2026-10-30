/** Wire the capture fence outside other handlers, before any tool side effect. */
import type { Hooks } from '@opencode-ai/plugin';
import type { ReviewerCaptureController } from './reviewer-capture.js';

export function attachReviewerCaptureHooks(hooks: Hooks, capture: ReviewerCaptureController): void {
  const message = hooks['chat.message'];
  hooks['chat.message'] = async (input, output) => {
    await message?.(input, output);
    capture.onMessage(input, output);
  };
  const messages = hooks['experimental.chat.messages.transform'];
  hooks['experimental.chat.messages.transform'] = async (input, output) => {
    await messages?.(input, output);
    capture.onMessages(output);
  };
  const params = hooks['chat.params'];
  hooks['chat.params'] = async (input, output) => {
    await params?.(input, output);
    capture.onParams(input, output);
  };
  const before = hooks['tool.execute.before'];
  hooks['tool.execute.before'] = async (input, output) => {
    capture.beforeTool(input);
    await before?.(input, output);
  };
}
