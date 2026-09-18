/**
 * @module verification/assertion-parsers/junit-xml
 * @description JUnit XML report parser for structured assertion evidence.
 *
 * Covers Maven Surefire/Failsafe, Gradle, and pytest (with --junitxml).
 * Extracts test results and maps them to StructuredAssertionEvidence.
 *
 * The parser receives a {@link ParseContext} so a single XML parser can serve
 * multiple frameworks. The identity codec (junit or pytest) controls how
 * `localId` is built from the parsed XML fields.
 *
 * Status mapping:
 *   <failure> element → failed
 *   <error> element   → errored
 *   <skipped> element → skipped
 *   no child element  → passed
 *
 * Suite-level errors (no matching testcase): sets suiteInfrastructureError.
 *
 * @version v2
 */

import type { StructuredAssertionEvidence } from '../../state/evidence-validation.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { ParseContext, ParserResult } from './types.js';
import { hashText } from '../../shared/hashing.js';

/**
 * Canonical localId for a JUnit test: classname followed by # and method name.
 */
export function buildJUnitLocalId(className: string, methodName: string): string {
  return `${className}#${methodName}`;
}

interface JUnitTestCaseRef {
  readonly classname: string;
  readonly name: string;
  readonly offset: number;
  readonly endOffset: number;
}

function readSuiteErrors(xmlContent: string): number {
  const suiteErrorsMatch = /<testsuite\b[^>]*errors="(\d+)"/.exec(xmlContent);
  return suiteErrorsMatch ? Number(suiteErrorsMatch[1]) : 0;
}

function assertJUnitDocumentShape(xmlContent: string): void {
  const hasTestsuiteTag = /<testsuite\b/i.test(xmlContent);
  const hasTestcaseTag = /<testcase\b/i.test(xmlContent);
  if (!hasTestsuiteTag && !hasTestcaseTag) {
    throw new Error(
      'junit_xml: not a valid JUnit XML report — no <testsuite> or <testcase> tags found',
    );
  }
}

function collectJUnitTestCases(xmlContent: string): JUnitTestCaseRef[] {
  const testCaseOpenRegex = /<testcase\b[^>]*>/g;
  const attrClassname = /\bclassname="([^"]*)"/;
  const attrName = /\bname="([^"]*)"/;

  const testCases: JUnitTestCaseRef[] = [];
  let tcm;
  while ((tcm = testCaseOpenRegex.exec(xmlContent)) !== null) {
    const tag = tcm[0];
    const classnameMatch = attrClassname.exec(tag);
    const nameMatch = attrName.exec(tag);
    if (!classnameMatch || !nameMatch) continue;
    const isSelfClosing = tag.endsWith('/>');
    const afterOpen = tcm.index + tag.length;
    if (isSelfClosing) {
      testCases.push({
        classname: classnameMatch[1]!,
        name: nameMatch[1]!,
        offset: afterOpen,
        endOffset: afterOpen,
      });
    } else {
      const closeTag = xmlContent.indexOf('</testcase>', afterOpen);
      testCases.push({
        classname: classnameMatch[1]!,
        name: nameMatch[1]!,
        offset: afterOpen,
        endOffset: closeTag !== -1 ? closeTag : afterOpen,
      });
    }
  }
  return testCases;
}

function buildJUnitAssertion(
  region: string,
  testCase: JUnitTestCaseRef,
  providerId: ProviderId,
): StructuredAssertionEvidence {
  const localId = buildJUnitLocalId(testCase.classname, testCase.name);
  const assertion: AssertionIdentity = { providerId, localId };

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
      detailDigest: hashText(region),
    };
  } else if (hasFailure) {
    status = 'failed';
    const failureMatch = /<failure\b[^>]*type="([^"]*)"[^>]*message="([^"]*)"[^>]*>/.exec(region);
    failure = {
      type: failureMatch?.[1],
      message: failureMatch?.[2],
      detailDigest: hashText(region),
    };
  } else {
    status = 'passed';
  }

  return {
    assertion,
    providerId,
    status,
    suiteName: testCase.classname.split('.').slice(0, -1).join('.') || undefined,
    testName: testCase.name,
    sourceFile: undefined,
    durationMs: undefined,
    failure,
  };
}

function countByStatus(
  assertions: readonly StructuredAssertionEvidence[],
  status: StructuredAssertionEvidence['status'],
): number {
  return assertions.filter((assertion) => assertion.status === status).length;
}

function buildJUnitSummary(
  assertions: readonly StructuredAssertionEvidence[],
  suiteErrors: number,
): ParserResult['summary'] {
  const failedCount = countByStatus(assertions, 'failed');
  const erroredCount = countByStatus(assertions, 'errored');
  return {
    assertionCount: assertions.length,
    passedCount: countByStatus(assertions, 'passed'),
    failedCount,
    erroredCount,
    skippedCount: countByStatus(assertions, 'skipped'),
    suiteInfrastructureError: suiteErrors > 0 && failedCount + erroredCount === 0,
  };
}

export function parseJUnitXml(
  xmlContent: string,
  _fileName: string,
  context: ParseContext,
): ParserResult {
  const providerId: ProviderId = context.providerId;
  const suiteErrors = readSuiteErrors(xmlContent);
  assertJUnitDocumentShape(xmlContent);

  const testCases = collectJUnitTestCases(xmlContent);
  if (testCases.length === 0 && suiteErrors > 0) {
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

  const assertions = testCases.map((testCase) =>
    buildJUnitAssertion(
      xmlContent.slice(testCase.offset, testCase.endOffset),
      testCase,
      providerId,
    ),
  );
  return { assertions, summary: buildJUnitSummary(assertions, suiteErrors) };
}
