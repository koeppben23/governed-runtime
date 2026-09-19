/** Canonical parsing and projection of repository changes represented as a Git patch. */

export type RepositoryChangeKind = 'add' | 'modify' | 'delete' | 'rename' | 'copy';
export type RepositoryChangeRepresentation = 'text' | 'binary';

export interface RepositoryModeChange {
  readonly oldMode: string;
  readonly newMode: string;
}

export type CanonicalRepositoryChange =
  | {
      readonly kind: 'add';
      readonly newPath: string;
      readonly representation: RepositoryChangeRepresentation;
      readonly reviewerMaterial: string;
    }
  | {
      readonly kind: 'delete';
      readonly oldPath: string;
      readonly representation: RepositoryChangeRepresentation;
      readonly reviewerMaterial: string;
    }
  | {
      readonly kind: 'modify' | 'rename' | 'copy';
      readonly oldPath: string;
      readonly newPath: string;
      readonly representation: RepositoryChangeRepresentation;
      readonly modeChange?: RepositoryModeChange;
      readonly reviewerMaterial: string;
    };

export interface CanonicalRepositoryChanges {
  readonly changes: readonly CanonicalRepositoryChange[];
}

/**
 * Parse a Git patch into its path-bearing changes. A section whose header cannot
 * be unambiguously parsed is rejected rather than silently omitted from scope.
 */
export function parseCanonicalRepositoryChanges(diff: string): CanonicalRepositoryChanges | null {
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.length > 0);
  if (sections.length === 0 || sections.some((section) => !section.startsWith('diff --git ')))
    return null;

  const changes: CanonicalRepositoryChange[] = [];
  for (const section of sections) {
    const header = section.slice(
      0,
      section.indexOf('\n') === -1 ? section.length : section.indexOf('\n'),
    );
    const paths = parseDiffHeader(header);
    if (!paths) return null;

    const change = parseChange(section, paths.oldPath, paths.newPath);
    if (!change) return null;
    changes.push(change);
  }
  return { changes };
}

export function repositoryChangePaths(changes: CanonicalRepositoryChanges): string[] {
  const paths = new Set<string>();
  for (const change of changes.changes) {
    if ('oldPath' in change) paths.add(change.oldPath);
    if ('newPath' in change) paths.add(change.newPath);
  }
  return [...paths].sort();
}

/** Return null when a requested path is not part of the parsed repository subject. */
export function filterRepositoryChanges(
  changes: CanonicalRepositoryChanges,
  targetPaths: readonly string[] | undefined,
): CanonicalRepositoryChanges | null {
  if (targetPaths === undefined) return changes;
  const requested = new Set(targetPaths);
  if (
    requested.size === 0 ||
    [...requested].some((path) => !path || !repositoryChangePaths(changes).includes(path))
  ) {
    return null;
  }
  return {
    changes: changes.changes.filter(
      (change) =>
        ('oldPath' in change && requested.has(change.oldPath)) ||
        ('newPath' in change && requested.has(change.newPath)),
    ),
  };
}

export function projectRepositoryReviewerMaterial(changes: CanonicalRepositoryChanges): string {
  return changes.changes.map((change) => change.reviewerMaterial).join('');
}

function parseDiffHeader(header: string): { oldPath: string; newPath: string } | null {
  const prefix = 'diff --git ';
  if (!header.startsWith(prefix)) return null;
  const oldToken = readGitPath(header, prefix.length);
  if (!oldToken) return null;
  const newToken = readGitPath(header, oldToken.next);
  if (!newToken || newToken.next !== header.length) return null;
  if (!oldToken.path.startsWith('a/') || !newToken.path.startsWith('b/')) return null;
  const oldPath = oldToken.path.slice(2);
  const newPath = newToken.path.slice(2);
  return oldPath && newPath ? { oldPath, newPath } : null;
}

function readGitPath(input: string, start: number): { path: string; next: number } | null {
  if (input[start] === ' ') start++;
  if (input[start] === '"') {
    let value = '';
    for (let i = start + 1; i < input.length; i++) {
      if (input[i] === '"') return { path: value, next: i + 1 };
      if (input[i] === '\\' && i + 1 < input.length) {
        const escaped = input[++i];
        if (escaped !== '\\' && escaped !== '"') return null;
        value += escaped;
      } else {
        value += input[i];
      }
    }
    return null;
  }
  const end = input.indexOf(' ', start);
  return {
    path: input.slice(start, end === -1 ? input.length : end),
    next: end === -1 ? input.length : end + 1,
  };
}

interface LifecycleHeaders {
  readonly renameFrom: string[];
  readonly renameTo: string[];
  readonly copyFrom: string[];
  readonly copyTo: string[];
  readonly newFileModes: string[];
  readonly deletedFileModes: string[];
  readonly oldModes: string[];
  readonly newModes: string[];
  readonly isAdd: boolean;
  readonly isDelete: boolean;
  readonly isMode: boolean;
  readonly isRename: boolean;
  readonly isCopy: boolean;
}

function parseLifecycleHeaders(preamble: readonly string[]): LifecycleHeaders {
  const values = (marker: string): string[] =>
    preamble.filter((line) => line.startsWith(marker)).map((line) => line.slice(marker.length));
  const renameFrom = values('rename from ');
  const renameTo = values('rename to ');
  const copyFrom = values('copy from ');
  const copyTo = values('copy to ');
  const newFileModes = values('new file mode ');
  const deletedFileModes = values('deleted file mode ');
  const oldModes = values('old mode ');
  const newModes = values('new mode ');
  return {
    renameFrom,
    renameTo,
    copyFrom,
    copyTo,
    newFileModes,
    deletedFileModes,
    oldModes,
    newModes,
    isAdd: newFileModes.length > 0,
    isDelete: deletedFileModes.length > 0,
    isMode: oldModes.length > 0 || newModes.length > 0,
    isRename: renameFrom.length > 0 || renameTo.length > 0,
    isCopy: copyFrom.length > 0 || copyTo.length > 0,
  };
}

function hasSingleLifecycle(headers: LifecycleHeaders): boolean {
  const lifecycleCount = [headers.isAdd, headers.isDelete, headers.isRename, headers.isCopy].filter(
    Boolean,
  ).length;
  if (lifecycleCount > 1) return false;
  // Mode metadata is orthogonal to a modify, but not to an add or delete.
  return !((headers.isAdd || headers.isDelete) && headers.isMode);
}

function hasConsistentRename(headers: LifecycleHeaders, oldPath: string, newPath: string): boolean {
  if (!headers.isRename) return true;
  return (
    headers.renameFrom.length === 1 &&
    headers.renameTo.length === 1 &&
    headers.renameFrom[0] === oldPath &&
    headers.renameTo[0] === newPath
  );
}

function hasConsistentCopy(headers: LifecycleHeaders, oldPath: string, newPath: string): boolean {
  if (!headers.isCopy) return true;
  return (
    headers.copyFrom.length === 1 &&
    headers.copyTo.length === 1 &&
    headers.copyFrom[0] === oldPath &&
    headers.copyTo[0] === newPath
  );
}

function hasConsistentModeHeaders(headers: LifecycleHeaders): boolean {
  if (headers.isAdd && headers.newFileModes.length !== 1) return false;
  if (headers.isDelete && headers.deletedFileModes.length !== 1) return false;
  if (headers.isMode && (headers.oldModes.length !== 1 || headers.newModes.length !== 1)) {
    return false;
  }
  return true;
}

/**
 * Lifecycle headers are mutually exclusive. Binary representation and mode
 * metadata are orthogonal attributes of an otherwise valid lifecycle.
 */
function hasConsistentLifecycle(
  headers: LifecycleHeaders,
  oldPath: string,
  newPath: string,
): boolean {
  return (
    hasSingleLifecycle(headers) &&
    hasConsistentRename(headers, oldPath, newPath) &&
    hasConsistentCopy(headers, oldPath, newPath) &&
    hasConsistentModeHeaders(headers)
  );
}

function isBinarySection(lines: readonly string[], oldPath: string, newPath: string): boolean {
  return lines.some(
    (line) =>
      line === 'GIT binary patch' || line === `Binary files a/${oldPath} and b/${newPath} differ`,
  );
}

function buildChange(
  headers: LifecycleHeaders,
  oldPath: string,
  newPath: string,
  representation: RepositoryChangeRepresentation,
  reviewerMaterial: string,
): CanonicalRepositoryChange {
  const modeChange = headers.isMode
    ? { oldMode: headers.oldModes[0]!, newMode: headers.newModes[0]! }
    : undefined;
  if (headers.isAdd) return { kind: 'add', newPath, representation, reviewerMaterial };
  if (headers.isDelete) return { kind: 'delete', oldPath, representation, reviewerMaterial };
  const modeChangeFields = modeChange !== undefined ? { modeChange } : {};
  if (headers.isRename) {
    return {
      kind: 'rename',
      oldPath,
      newPath,
      representation,
      ...modeChangeFields,
      reviewerMaterial,
    };
  }
  if (headers.isCopy) {
    return {
      kind: 'copy',
      oldPath,
      newPath,
      representation,
      ...modeChangeFields,
      reviewerMaterial,
    };
  }
  return {
    kind: 'modify',
    oldPath,
    newPath,
    representation,
    ...modeChangeFields,
    reviewerMaterial,
  };
}

function parseChange(
  section: string,
  oldPath: string,
  newPath: string,
): CanonicalRepositoryChange | null {
  if (!isRepositoryPath(oldPath) || !isRepositoryPath(newPath)) return null;
  const lines = section.split('\n');
  const preamble = lines.slice(1, firstPatchBodyLine(section));
  const headers = parseLifecycleHeaders(preamble);
  if (!hasConsistentLifecycle(headers, oldPath, newPath)) return null;
  const representation: RepositoryChangeRepresentation = isBinarySection(lines, oldPath, newPath)
    ? 'binary'
    : 'text';
  return buildChange(headers, oldPath, newPath, representation, section);
}

function firstPatchBodyLine(section: string): number {
  const lines = section.split('\n');
  const body = lines.findIndex(
    (line, index) =>
      index > 0 &&
      (line.startsWith('@@ ') ||
        line.startsWith('--- ') ||
        line === 'GIT binary patch' ||
        line.startsWith('Binary files ')),
  );
  return body === -1 ? lines.length : body;
}

function isRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}
