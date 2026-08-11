import { describe, expect, it } from 'vitest';

import {
  filterRepositoryChanges,
  parseCanonicalRepositoryChanges,
  projectRepositoryReviewerMaterial,
  repositoryChangePaths,
} from './repository-change.js';

describe('canonical repository changes', () => {
  it('preserves explicit add, modify, delete, rename, copy, mode, and binary path semantics', () => {
    const changes = parseCanonicalRepositoryChanges(`diff --git a/add.ts b/add.ts
new file mode 100644
diff --git a/modify.ts b/modify.ts
@@ -1 +1 @@
-old
+new
diff --git a/delete.ts b/delete.ts
deleted file mode 100644
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/source.ts b/copy.ts
similarity index 100%
copy from source.ts
copy to copy.ts
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`);

    expect(changes?.changes).toMatchObject([
      { kind: 'add', newPath: 'add.ts' },
      { kind: 'modify', oldPath: 'modify.ts', newPath: 'modify.ts' },
      { kind: 'delete', oldPath: 'delete.ts' },
      { kind: 'rename', oldPath: 'old.ts', newPath: 'new.ts' },
      { kind: 'copy', oldPath: 'source.ts', newPath: 'copy.ts' },
      { kind: 'mode', oldPath: 'script.sh', newPath: 'script.sh' },
      { kind: 'binary', oldPath: 'image.png', newPath: 'image.png' },
    ]);
    expect(changes && repositoryChangePaths(changes)).toEqual([
      'add.ts',
      'copy.ts',
      'delete.ts',
      'image.png',
      'modify.ts',
      'new.ts',
      'old.ts',
      'script.sh',
      'source.ts',
    ]);
  });

  it('validates target paths and projects complete selected changes', () => {
    const changes = parseCanonicalRepositoryChanges(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
new
`);
    expect(changes).not.toBeNull();
    const scoped = filterRepositoryChanges(changes!, ['old.ts']);

    expect(scoped && repositoryChangePaths(scoped)).toEqual(['new.ts', 'old.ts']);
    expect(scoped && projectRepositoryReviewerMaterial(scoped)).toContain('rename to new.ts');
    expect(scoped && projectRepositoryReviewerMaterial(scoped)).not.toContain('other.ts');
    expect(filterRepositoryChanges(changes!, ['missing.ts'])).toBeNull();
  });

  it('fails closed for an unparseable diff header', () => {
    expect(parseCanonicalRepositoryChanges('diff --git malformed')).toBeNull();
  });

  it.each([
    [
      'rename markers that disagree with the header',
      `diff --git a/source.ts b/target.ts
similarity index 100%
rename from source.ts
rename to injected.ts
`,
    ],
    [
      'ambiguous change kinds',
      `diff --git a/file.ts b/file.ts
new file mode 100644
Binary files a/file.ts and b/file.ts differ
`,
    ],
    [
      'repository paths that escape the root',
      `diff --git a/../outside.ts b/../outside.ts
@@ -1 +1 @@
-old
+new
`,
    ],
    [
      'partial rename metadata',
      `diff --git a/old.ts b/new.ts
rename from old.ts
`,
    ],
    [
      'duplicate extended headers',
      `diff --git a/file.ts b/file.ts
new file mode 100644
new file mode 100755
`,
    ],
  ])('fails closed for %s', (_case, diff) => {
    expect(parseCanonicalRepositoryChanges(diff)).toBeNull();
  });
});
