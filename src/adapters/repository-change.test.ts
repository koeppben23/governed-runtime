import { describe, expect, it } from 'vitest';

import {
  filterRepositoryChanges,
  parseCanonicalRepositoryChanges,
  projectRepositoryReviewerMaterial,
  repositoryChangePaths,
} from './repository-change.js';

describe('canonical repository changes', () => {
  it('models add, delete, rename, copy, mode, and binary paths', () => {
    const changes = parseCanonicalRepositoryChanges(`diff --git a/add.ts b/add.ts
new file mode 100644
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

    expect(changes?.changes.map((change) => change.kind)).toEqual([
      'add',
      'delete',
      'rename',
      'copy',
      'mode',
      'binary',
    ]);
    expect(changes && repositoryChangePaths(changes)).toEqual([
      'add.ts',
      'copy.ts',
      'delete.ts',
      'image.png',
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
});
