import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText, hashTextShort } from '../../../shared/hashing.js';

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

function v1(a: ReviewFingerprintInput): string {
  return hashText(
    JSON.stringify({
      prNumber: a.prNumber,
      branch: a.branch,
      url: a.url,
      textHash: a.text ? hashTextShort(a.text, 16) : undefined,
      inputOrigin: a.inputOrigin,
      references: a.references ? hashTextShort(JSON.stringify(a.references), 16) : undefined,
      resolvedBranchSha: a.resolvedBranchSha,
      resolvedBaseSha: a.resolvedBaseSha,
    }),
  );
}
function v2(a: ReviewFingerprintInput): string {
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
export function fingerprintReviewInput(
  a: ReviewFingerprintInput,
  version: 'v1' | 'v2' = 'v2',
): string {
  return version === 'v1' ? v1(a) : v2(a);
}
