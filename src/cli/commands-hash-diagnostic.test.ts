import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { COMMANDS } from './templates.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('COMMANDS_HASH_DIAGNOSTIC', () => {
  it('prints the complete current command-template hash', () => {
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    const hash = sha256(commandsJson);
    throw new Error(`COMMANDS_HASH=${hash}`);
  });
});
