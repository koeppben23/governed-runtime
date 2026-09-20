import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
} from '../../state/evidence-validation.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { ParseContext, ParserResult } from './types.js';
import { hashText } from '../../shared/hashing.js';
import { VerificationError } from '../errors.js';

interface VitestAssertionResult {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
}

interface VitestTestResult {
  name?: string;
  assertionResults?: VitestAssertionResult[];
}

interface VitestJsonReport {
  testResults?: VitestTestResult[];
}

function mapStatus(raw: string): 'passed' | 'failed' | 'skipped' {
  if (raw === 'passed') return 'passed';
  if (raw === 'failed') return 'failed';
  return 'skipped';
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function buildVitestLocalId(
  filePath: string,
  ancestorTitles: string[],
  title: string,
): string {
  const normalized = normalizeFilePath(filePath);
  const chain = ancestorTitles.join('::');
  if (chain) {
    return `${normalized}::${chain}::${title}`;
  }
  return `${normalized}::${title}`;
}

function buildVitestFailure(msg: string | undefined): StructuredAssertionEvidence['failure'] {
  return {
    message: msg ? msg.split('\n')[0] : undefined,
    detailDigest: msg ? hashText(msg) : undefined,
  };
}

function buildVitestAssertion(
  ar: VitestAssertionResult,
  fileName: string,
  providerId: ProviderId,
): StructuredAssertionEvidence {
  const ancestors = ar.ancestorTitles ?? [];
  const status = mapStatus(ar.status ?? 'passed');
  const testTitle = ar.title ?? 'unknown';
  const localId = buildVitestLocalId(fileName, ancestors, testTitle);
  const assertion: AssertionIdentity = { providerId, localId };

  return {
    assertion,
    providerId,
    status,
    suiteName: ancestors.length > 0 ? ancestors.join(' > ') : undefined,
    testName: testTitle,
    durationMs: typeof ar.duration === 'number' ? ar.duration : undefined,
    failure: status === 'failed' ? buildVitestFailure(ar.failureMessages?.[0]) : undefined,
  };
}

export function parseVitestJson(jsonText: string, context: ParseContext): ParserResult {
  const providerId: ProviderId = context.providerId;

  let report: VitestJsonReport;
  try {
    report = JSON.parse(jsonText) as VitestJsonReport;
  } catch {
    throw new VerificationError(
      'VERIFICATION_REPORT_PARSE_FAILED',
      'vitest_json: failed to parse JSON report',
    );
  }

  const testResults = report?.testResults;
  if (!Array.isArray(testResults) || testResults.length === 0) {
    return emptyResult();
  }

  const assertions: StructuredAssertionEvidence[] = [];

  for (const testResult of testResults) {
    const fileName = testResult.name ?? 'unknown';
    const assertionResults = testResult.assertionResults;
    if (!Array.isArray(assertionResults)) continue;

    for (const ar of assertionResults) {
      assertions.push(buildVitestAssertion(ar, fileName, providerId));
    }
  }

  return {
    assertions,
    summary: buildSummary(assertions),
  };
}

function emptyResult(): ParserResult {
  return {
    assertions: [],
    summary: {
      assertionCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
      suiteInfrastructureError: false,
    },
  };
}

function buildSummary(assertions: StructuredAssertionEvidence[]): AssertionExtractionSummary {
  return {
    assertionCount: assertions.length,
    passedCount: assertions.filter((a) => a.status === 'passed').length,
    failedCount: assertions.filter((a) => a.status === 'failed').length,
    erroredCount: assertions.filter((a) => a.status === 'errored').length,
    skippedCount: assertions.filter((a) => a.status === 'skipped').length,
    suiteInfrastructureError: false,
  };
}
