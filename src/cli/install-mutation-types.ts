/**
 * @module cli/install-mutation-types
 * @description Sink interface for tracked directory/file mutations during install.
 */

export interface InstallMutationSink {
  ensureDir(path: string): Promise<void>;
  recordFile(path: string): void | Promise<void>;
}
