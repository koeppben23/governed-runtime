import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
  StructuredAssertionFramework,
} from '../../state/evidence-validation.js';
import { createHash } from 'node:crypto';

interface JestJsonResult {
  assertions: StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

interface JestAssertionResult {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
  location?: string;
}

interface JestTestResult {
  name?: string;
  assertionResults?: JestAssertionResult[];
}

interface JestJsonReport {
  testResults?: JestTestResult[];
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function mapStatus(raw: string): 'passed' | 'failed' | 'skipped' {
  if (raw === 'passed') return 'passed';
  if (raw === 'failed') return 'failed';
  return 'skipped';
}

function buildAssertionId(filePath: string, ancestorTitles: string[], title: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const chain = ancestorTitles.join('::');
  if (chain) {
    return `jest:${normalized}::${chain}::${title}`;
  }
  return `jest:${normalized}::${title}`;
}

export function parseJestJson(jsonText: string): JestJsonResult {
  let report: JestJsonReport;
  try {
    report = JSON.parse(jsonText) as JestJsonReport;
  } catch {
    return emptyResult();
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
      const assertionId = buildAssertionId(fileName, ancestors, testTitle);

      let failure: StructuredAssertionEvidence['failure'];
      if (status === 'failed') {
        const msg = ar.failureMessages?.[0];
        failure = {
          message: msg ? msg.split('\n')[0] : undefined,
          detailDigest: msg ? sha256(msg) : undefined,
        };
      }

      let sourceFile: string | undefined;
      if (ar.location) {
        sourceFile = ar.location.replace(/:\d+:\d+$/, '');
      }

      assertions.push({
        assertionId,
        framework: 'jest' as StructuredAssertionFramework,
        status,
        suiteName: ancestors.length > 0 ? ancestors.join(' > ') : undefined,
        testName: testTitle,
        sourceFile,
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

function emptyResult(): JestJsonResult {
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
