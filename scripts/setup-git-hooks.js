// Setup git hooks from scripts/ into .git/hooks/
// Called by `npm run setup-hooks` and auto-runs via `prepare` after `npm install`.
// Silent when .git is absent (npm pack, CI without checkout, etc.).

import { chmod, cp, stat, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(__dirname, '..', '.git', 'hooks');

try {
  await access(hooksDir, constants.F_OK);
} catch {
  // No .git/hooks — skip silently
  process.exit(0);
}

const hooks = ['pre-push'];

let installed = 0;
for (const hook of hooks) {
  const src = join(__dirname, hook);
  const dst = join(hooksDir, hook);

  const srcExists = await stat(src).then(
    () => true,
    () => false,
  );
  if (!srcExists) {
    console.error(`[setup-hooks] source not found: ${src}`);
    continue;
  }

  await cp(src, dst);
  await chmod(dst, 0o755);
  installed++;
}

if (installed > 0) {
  console.error(`[setup-hooks] installed ${installed} hook(s) into .git/hooks/`);
}
