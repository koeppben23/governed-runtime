/**
 * @module git
 * @description Git subprocess adapter -- thin wrapper around git CLI commands.
 *
 * Provides the git operations the FlowGuard system needs:
 * - Worktree root detection (resolveRoot)
 * - Changed file discovery (changedFiles, diffFiles)
 * - Branch info (currentBranch)
 * - Worktree cleanliness check (isClean)
 * - Remote origin URL retrieval (remoteOriginUrl)
 *
 * Design:
 * - Uses child_process.execFile (no shell invocation -- zero injection risk)
 * - Typed errors (GitError with codes)
 * - Timeout protection (5 seconds per command, configurable)
 * - Path normalization (git outputs forward slashes, we normalize to OS convention)
 * - All returned file paths are relative to worktree root
 * - windowsHide: true (suppress console window on Windows)
 *
 * Security:
 * - execFile with argument array (never string concatenation)
 * - No user input interpolated into shell commands
 * - Timeout prevents runaway git processes (e.g., on very large repos)
 *
 * This module is the stable public façade for the git adapter. The
 * implementation is split along command groups into sibling modules
 * (`git-command`, `git-repo`, `git-changes`, `git-branch`, `git-identity`)
 * and re-exported here so consumers and module mocks keep one import path.
 *
 * @version v2
 */

export { GitError, type GitErrorCode } from './git-command.js';

export {
  resolveRoot,
  resolveGitControlPlanePaths,
  type GitControlPlaneLayout,
  isGitRepo,
  isGitRepoStrict,
} from './git-repo.js';

export {
  parsePorcelainZ,
  changedFiles,
  worktreeDiff,
  hashWorktreeFiles,
  listRepoSignals,
} from './git-changes.js';

export {
  currentBranch,
  isClean,
  headCommit,
  headCommitFull,
  headCommitFullStrict,
  defaultBranch,
  remoteOriginUrl,
} from './git-branch.js';

export { gitUserName, gitUserEmail } from './git-identity.js';
