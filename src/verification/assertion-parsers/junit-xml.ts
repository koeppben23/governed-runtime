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
import { createHash } from 'node:crypto';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Canonical localId for a JUnit test: classname followed by # and method name.
 */
export function buildJUnitLocalId(className: string, methodName: string): string {
  return `${className}#${methodName}`;
}

export function parseJUnitXml(
  xmlContent: string,
  _fileName: string,
  context: ParseContext,
): ParserResult {
  const assertions: StructuredAssertionEvidence[] = [];
  let suiteInfrastructureError = false;
  const providerId: ProviderId = context.providerId;

  const suiteErrorsMatch = /<testsuite\b[^>]*errors="(\d+)"/.exec(xmlContent);
  const suiteErrors = suiteErrorsMatch ? Number(suiteErrorsMatch[1]) : 0;

  const hasTestsuiteTag = /<testsuite\b/i.test(xmlContent);
  const hasTestcaseTag = /<testcase\b/i.test(xmlContent);
  if (!hasTestsuiteTag && !hasTestcaseTag) {
    throw new Error(
      'junit_xml: not a valid JUnit XML report — no <testsuite> or <testcase> tags found',
    );
  }

  const testCaseOpenRegex = /<testcase\b[^>]*>/g;
  const attrClassname = /\bclassname="([^"]*)"/;
  const attrName = /\bname="([^"]*)"/;

  const testCases: {
    classname: string;
    name: string;
    offset: number;
    endOffset: number;
  }[] = [];
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

  for (const tc of testCases) {
    const region = xmlContent.slice(tc.offset, tc.endOffset);
    const localId = buildJUnitLocalId(tc.classname, tc.name);
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
      assertion,
      providerId,
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
