import { appendFileSync } from 'node:fs';
import { Plugin } from '@opencode/plugin';

// Loader observability only. No hooks, transforms, tools, mandates or activation.
function record(type, data = {}) {
  const path = process.env.FG_PROBE_JOURNAL;
  if (!path)
    throw Object.assign(new Error('Missing probe journal'), { code: 'PROBE_JOURNAL_MISSING' });
  appendFileSync(path, JSON.stringify({ type, ...data }) + '\n');
}

export default Plugin.define({
  id: 'flowguard.passive-probe',
  setup(ctx) {
    record('setup:ready', { appVersion: ctx.app.version, location: ctx.location });
    return () => record('setup:cleanup');
  },
});
