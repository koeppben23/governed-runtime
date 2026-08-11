/** Canonical parsing and projection of repository changes represented as a Git patch. */

export type RepositoryChangeKind =
  'add' | 'modify' | 'delete' | 'rename' | 'copy' | 'mode' | 'binary';

export type CanonicalRepositoryChange =
  | { readonly kind: 'add'; readonly newPath: string; readonly reviewerMaterial: string }
  | { readonly kind: 'delete'; readonly oldPath: string; readonly reviewerMaterial: string }
  | {
      readonly kind: 'modify' | 'rename' | 'copy' | 'mode' | 'binary';
      readonly oldPath: string;
      readonly newPath: string;
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

function parseChange(
  section: string,
  oldPath: string,
  newPath: string,
): CanonicalRepositoryChange | null {
  if (!isRepositoryPath(oldPath) || !isRepositoryPath(newPath)) return null;
  const preamble = section.split('\n').slice(1, firstPatchBodyLine(section));
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
  const isAdd = newFileModes.length > 0;
  const isDelete = deletedFileModes.length > 0;
  const isMode = oldModes.length > 0 || newModes.length > 0;
  const isRename = renameFrom.length > 0 || renameTo.length > 0;
  const isCopy = copyFrom.length > 0 || copyTo.length > 0;
  const isBinary =
    section.split('\n').some((line) => line === 'GIT binary patch') ||
    section
      .split('\n')
      .some((line) => line === `Binary files a/${oldPath} and b/${newPath} differ`);

  // Extended headers are authoritative only before the patch body. Conflicting
  // forms and header/marker disagreement are ambiguous repository scope.
  if (
    [isAdd, isDelete, isRename, isCopy, isMode, isBinary].filter(Boolean).length > 1 ||
    (isAdd && newFileModes.length !== 1) ||
    (isDelete && deletedFileModes.length !== 1) ||
    (isRename &&
      (renameFrom.length !== 1 ||
        renameTo.length !== 1 ||
        renameFrom[0] !== oldPath ||
        renameTo[0] !== newPath)) ||
    (isCopy &&
      (copyFrom.length !== 1 ||
        copyTo.length !== 1 ||
        copyFrom[0] !== oldPath ||
        copyTo[0] !== newPath)) ||
    (isMode && (oldModes.length !== 1 || newModes.length !== 1))
  ) {
    return null;
  }
  const reviewerMaterial = section;
  if (isAdd) return { kind: 'add', newPath, reviewerMaterial };
  if (isDelete) return { kind: 'delete', oldPath, reviewerMaterial };
  if (isRename) return { kind: 'rename', oldPath, newPath, reviewerMaterial };
  if (isCopy) return { kind: 'copy', oldPath, newPath, reviewerMaterial };
  if (isMode) return { kind: 'mode', oldPath, newPath, reviewerMaterial };
  if (isBinary) return { kind: 'binary', oldPath, newPath, reviewerMaterial };
  return { kind: 'modify', oldPath, newPath, reviewerMaterial };
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
