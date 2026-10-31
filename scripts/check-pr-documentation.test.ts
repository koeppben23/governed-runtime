import { describe, expect, it } from 'vitest';
import { validatePrDocumentation } from './check-pr-documentation.mjs';

describe('mandatory per-PR changelog', () => {
  it('fails for a PR without changelog even when docs are changed', () => {
    expect(validatePrDocumentation(['docs/readme.md']).ok).toBe(false);
  });

  it('passes when CHANGELOG.md changes', () => {
    expect(validatePrDocumentation(['CHANGELOG.md', 'AGENTS.md']).ok).toBe(true);
  });

  it('does not allow substring or nested fake changelog paths', () => {
    expect(validatePrDocumentation(['docs/CHANGELOG.md', 'CHANGELOG.md.bak']).ok).toBe(false);
  });
});
