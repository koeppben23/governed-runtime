/** Canonical parsing and projection of repository changes represented as a Git patch. */

export type RepositoryChangeKind =
  'add' | 'modify' | 'delete' | 'rename' | 'copy' | 'mode' | 'binary';

export interface CanonicalRepositoryChange {
  readonly kind: RepositoryChangeKind;
  readonly oldPath?: string;
  readonly newPath?: string;
  /** Exact normalized patch section supplied to the reviewer. */
  readonly reviewerMaterial: string;
}

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

    const oldPath =
      markerPath(section, 'rename from ') ?? markerPath(section, 'copy from ') ?? paths.oldPath;
    const newPath =
      markerPath(section, 'rename to ') ?? markerPath(section, 'copy to ') ?? paths.newPath;
    const kind = changeKind(section);
    changes.push({
      kind,
      ...(kind === 'add' ? {} : { oldPath }),
      ...(kind === 'delete' ? {} : { newPath }),
      reviewerMaterial: section,
    });
  }
  return { changes };
}

export function repositoryChangePaths(changes: CanonicalRepositoryChanges): string[] {
  const paths = new Set<string>();
  for (const change of changes.changes) {
    if (change.oldPath) paths.add(change.oldPath);
    if (change.newPath) paths.add(change.newPath);
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
        (change.oldPath !== undefined && requested.has(change.oldPath)) ||
        (change.newPath !== undefined && requested.has(change.newPath)),
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

function markerPath(section: string, marker: string): string | undefined {
  const line = section.split('\n').find((candidate) => candidate.startsWith(marker));
  if (!line) return undefined;
  const value = line.slice(marker.length);
  return value.length > 0 ? value : undefined;
}

function changeKind(section: string): RepositoryChangeKind {
  if (section.includes('\nnew file mode ')) return 'add';
  if (section.includes('\ndeleted file mode ')) return 'delete';
  if (section.includes('\nrename from ')) return 'rename';
  if (section.includes('\ncopy from ')) return 'copy';
  if (section.includes('\nold mode ') || section.includes('\nnew mode ')) return 'mode';
  if (section.includes('\nBinary files ') || section.includes('\nGIT binary patch'))
    return 'binary';
  return 'modify';
}
