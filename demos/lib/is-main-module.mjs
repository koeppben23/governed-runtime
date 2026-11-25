/**
 * @module demos/lib/is-main-module
 * @description Entry-point detection for demo CLI modules.
 *
 * Node resolves `import.meta.url` to the REAL path of the module, while
 * `process.argv[1]` can be a symlinked invocation path (macOS `/tmp` is a
 * symlink to `/private/tmp`). Comparing the raw strings therefore makes a
 * directly invoked CLI silently skip its `main()` and exit 0 without running
 * anything - an unacceptable failure mode for an evidence-based demo.
 *
 * Compare REAL paths so a CLI invoked through a symlinked location still runs.
 *
 * @version v1
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
