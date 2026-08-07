import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
} from '../../state/evidence-validation.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { ParseContext, ParserResult } from './types.js';
import { createHash } from 'node:crypto';

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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
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

export function parseVitestJson(jsonText: string, context: ParseContext): ParserResult {
  const providerId: ProviderId = context.providerId;

  let report: VitestJsonReport;
  try {
    report = JSON.parse(jsonText) as VitestJsonReport;
  } catch {
    throw new Error('vitest_json: failed to parse JSON report');
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
      const ancestors = ar.ancestorTitles ?? [];
      const rawStatus = ar.status ?? 'passed';
      const status = mapStatus(rawStatus);
      const testTitle = ar.title ?? 'unknown';
      const localId = buildVitestLocalId(fileName, ancestors, testTitle);
      const assertion: AssertionIdentity = { providerId, localId };

      let failure: StructuredAssertionEvidence['failure'];
      if (status === 'failed') {
        const msg = ar.failureMessages?.[0];
        failure = {
          message: msg ? msg.split('\n')[0] : undefined,
          detailDigest: msg ? sha256(msg) : undefined,
        };
      }

      assertions.push({
        assertion,
        providerId,
        status,
        suiteName: ancestors.length > 0 ? ancestors.join(' > ') : undefined,
        testName: testTitle,
        durationMs: typeof ar.duration === 'number' ? ar.duration : undefined,
        failure,
      });
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
