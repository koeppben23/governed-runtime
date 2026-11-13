/** Logical repository paths, independent of the host filesystem separator. */
export function normalizeRepoRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Linear-space wildcard matching; no user-controlled regular expression. */
function matchesSegment(pattern: string, value: string): boolean {
  let previous = [true, ...Array<boolean>(value.length).fill(false)];
  for (const token of pattern) {
    const next = Array<boolean>(value.length + 1).fill(false);
    next[0] = token === '*' && previous[0] === true;
    for (let i = 1; i <= value.length; i++) {
      next[i] =
        token === '*'
          ? previous[i] === true || next[i - 1] === true
          : previous[i - 1] === true && token === value[i - 1];
    }
    previous = next;
  }
  return previous[value.length] === true;
}

/** `*` matches within a segment, `**` matches zero or more whole segments. */
export function matchesRepositoryGlob(pattern: string, value: string): boolean {
  const segments = value.split('/');
  let previous = [true, ...Array<boolean>(segments.length).fill(false)];
  for (const part of pattern.split('/')) {
    const next = Array<boolean>(segments.length + 1).fill(false);
    next[0] = part === '**' && previous[0] === true;
    for (let i = 1; i <= segments.length; i++) {
      next[i] =
        part === '**'
          ? previous[i] === true || next[i - 1] === true
          : previous[i - 1] === true && matchesSegment(part, segments[i - 1] ?? '');
    }
    previous = next;
  }
  return previous[segments.length] === true;
}
