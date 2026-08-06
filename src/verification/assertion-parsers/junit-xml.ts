/**
 * @module verification/assertion-parsers/junit-xml
 * @description JUnit XML report parser for structured assertion evidence.
 *
 * Covers Maven Surefire/Failsafe, Gradle, and Pytest (with --junitxml).
 * Extracts test results and maps them to StructuredAssertionEvidence.
 *
 * Assertion ID format: junit:<classname>#<methodname>
 * Status mapping:
 *   <failure> element → failed
 *   <error> element   → errored
 *   <skipped> element → skipped
 *   no child element  → passed
 *
 * Suite-level errors (no matching testcase): sets suiteInfrastructureError.
 *
 * @version v1
 */

import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
} from '../../state/evidence-validation.js';
import type { StructuredAssertionFramework } from '../../state/evidence-validation.js';
import { createHash } from 'node:crypto';

interface JUnitParseResult {
  assertions: StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function parseJUnitXml(xmlContent: string, _fileName: string): JUnitParseResult {
  const assertions: StructuredAssertionEvidence[] = [];
  let suiteInfrastructureError = false;

  const testCaseRegex = /<testcase\b[^>]*classname="([^"]*)"\s+name="([^"]*)"[^>]*>/g;

  // Detect suite-level infrastructure errors (errors attribute on testsuite)
  const suiteErrorsMatch = /<testsuite\b[^>]*errors="(\d+)"/.exec(xmlContent);
  const suiteErrors = suiteErrorsMatch ? Number(suiteErrorsMatch[1]) : 0;

  // Extract testcases
  const testCases: {
    classname: string;
    name: string;
    offset: number;
    endOffset: number;
  }[] = [];
  let tcm;
  while ((tcm = testCaseRegex.exec(xmlContent)) !== null) {
    const classname = tcm[1]!;
    const name = tcm[2]!;
    const offset = tcm.index + tcm[0].length;
    const closeTag = xmlContent.indexOf('</testcase>', offset);
    testCases.push({ classname, name, offset, endOffset: closeTag });
  }

  if (testCases.length === 0 && suiteErrors > 0) {
    suiteInfrastructureError = true;
    return {
      assertions: [],
      summary: {
        assertionCount: 0,
        passedCount: 0,
        failedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
        suiteInfrastructureError: true,
      },
    };
  }

  for (const tc of testCases) {
    const region = xmlContent.slice(tc.offset, tc.endOffset);
    const assertionId = `junit:${tc.classname}#${tc.name}`;

    const hasFailure = /<failure\b/.test(region);
    const hasError = /<error\b/.test(region);
    const hasSkipped = /<skipped\b/.test(region);

    let status: 'passed' | 'failed' | 'errored' | 'skipped';
    let failure: StructuredAssertionEvidence['failure'];

    if (hasSkipped) {
      status = 'skipped';
    } else if (hasError) {
      status = 'errored';
      const errorMatch = /<error\b[^>]*type="([^"]*)"[^>]*message="([^"]*)"[^>]*>/.exec(region);
      failure = {
        type: errorMatch?.[1],
        message: errorMatch?.[2],
        detailDigest: sha256(region),
      };
    } else if (hasFailure) {
      status = 'failed';
      const failureMatch = /<failure\b[^>]*type="([^"]*)"[^>]*message="([^"]*)"[^>]*>/.exec(region);
      failure = {
        type: failureMatch?.[1],
        message: failureMatch?.[2],
        detailDigest: sha256(region),
      };
    } else {
      status = 'passed';
    }

    assertions.push({
      assertionId,
      framework: 'junit' as StructuredAssertionFramework,
      status,
      suiteName: tc.classname.split('.').slice(0, -1).join('.') || undefined,
      testName: tc.name,
      sourceFile: undefined,
      durationMs: undefined,
      failure,
    });
  }

  const failedCount = assertions.filter((a) => a.status === 'failed').length;
  const erroredCount = assertions.filter((a) => a.status === 'errored').length;

  if (suiteErrors > 0 && failedCount + erroredCount === 0) {
    suiteInfrastructureError = true;
  }

  return {
    assertions,
    summary: {
      assertionCount: assertions.length,
      passedCount: assertions.filter((a) => a.status === 'passed').length,
      failedCount,
      erroredCount,
      skippedCount: assertions.filter((a) => a.status === 'skipped').length,
      suiteInfrastructureError,
    },
  };
}
