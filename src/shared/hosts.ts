/**
 * @module shared/hosts
 * @description Canonical host identifiers for FlowGuard host execution selection.
 */

export const HOST_IDS = ['opencode', 'claude-code', 'codex'] as const;

export type HostId = (typeof HOST_IDS)[number];

export const DEFAULT_HOST: HostId = 'opencode';

export function isHostId(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}
