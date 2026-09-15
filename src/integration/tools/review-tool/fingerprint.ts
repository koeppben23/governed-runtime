import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';

export type ReviewFingerprintInput = {
  prNumber?: number;
  branch?: string;
  base?: string;
  url?: string;
  text?: string;
  inputOrigin?: string;
  references?: unknown;
  resolvedBranchSha?: string;
  resolvedBaseSha?: string;
};

export function fingerprintReviewInput(a: ReviewFingerprintInput): string {
  return hashText(
    canonicalJsonStringify({
      version: 'v2',
      prNumber: a.prNumber,
      branch: a.branch,
      base: a.base,
      url: a.url,
      textDigest: a.text === undefined ? undefined : hashText(a.text),
      inputOrigin: a.inputOrigin,
      referencesDigest:
        a.references === undefined ? undefined : hashText(canonicalJsonStringify(a.references)),
      resolvedBranchSha: a.resolvedBranchSha,
      resolvedBaseSha: a.resolvedBaseSha,
    }),
  );
}
