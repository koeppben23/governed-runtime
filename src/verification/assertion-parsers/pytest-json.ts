/**
 * @module verification/assertion-parsers/pytest-json
 * @description Pytest JSON report parser (pytest --json-report).
 *
 * Produces structured assertion evidence with canonical localIds derived from
 * the pytest nodeid. The nodeid is used directly as the localId — it is a
 * stable, unique identifier within a pytest run.
 *
 * Only assertion-binding-capable for pytest_json format. pytest through
 * JUnit XML is check-level only (nodeid not reconstructable from XML).
 *
 * @version v1
 */

import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
} from '../../state/evidence-validation.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { ParseContext, ParserResult } from './types.js';
import { hashText } from '../../shared/hashing.js';
import { VerificationError } from '../errors.js';

interface PytestTest {
  nodeid: string;
  outcome: string;
  setup?: { outcome: string };
  call?: { outcome: string; longrepr?: string; duration?: number };
  teardown?: { outcome: string };
  keywords?: string[];
}

interface PytestJsonReport {
  tests?: PytestTest[];
  collectors?: unknown[];
  created?: number;
}

function mapStatus(raw: string): 'passed' | 'failed' | 'errored' | 'skipped' {
  if (raw === 'passed') return 'passed';
  if (raw === 'failed') return 'failed';
  if (raw === 'error') return 'errored';
  if (raw === 'skipped') return 'skipped';
  return 'skipped';
}

export function buildPytestLocalId(nodeId: string): string {
  return nodeId;
}

function buildPytestCallFailure(
  longrepr: string | undefined,
): StructuredAssertionEvidence['failure'] {
  if (!longrepr) return undefined;
  return {
    message: longrepr.split('\n')[0] || undefined,
    detailDigest: hashText(longrepr),
  };
}

function buildPytestFailure(
  test: PytestTest,
  status: StructuredAssertionEvidence['status'],
): StructuredAssertionEvidence['failure'] {
  if (status === 'failed') {
    return buildPytestCallFailure(test.call?.longrepr);
  }
  if (status === 'errored') {
    const setupErr = test.setup?.outcome === 'error' ? test.setup : undefined;
    const teardownErr = test.teardown?.outcome === 'error' ? test.teardown : undefined;
    const detail = setupErr ?? teardownErr;
    return detail ? buildPytestCallFailure(test.call?.longrepr) : undefined;
  }
  return undefined;
}

function buildPytestAssertion(
  test: PytestTest,
  providerId: ProviderId,
): StructuredAssertionEvidence | null {
  const nodeId = test.nodeid;
  if (!nodeId) return null;

  const outcome = test.outcome ?? 'skipped';
  // Determine the primary status: check call phase first, then overall
  const callOutcome = test.call?.outcome ?? outcome;
  const status = mapStatus(callOutcome);
  const localId = buildPytestLocalId(nodeId);
  const assertion: AssertionIdentity = { providerId, localId };

  return {
    assertion,
    providerId,
    status,
    suiteName: undefined,
    testName: nodeId.split('::').pop() ?? nodeId,
    durationMs:
      typeof test.call?.duration === 'number' ? Math.round(test.call.duration * 1000) : undefined,
    failure: buildPytestFailure(test, status),
  };
}

export function parsePytestJson(jsonText: string, context: ParseContext): ParserResult {
  const providerId: ProviderId = context.providerId;

  let report: PytestJsonReport;
  try {
    report = JSON.parse(jsonText) as PytestJsonReport;
  } catch {
    throw new VerificationError(
      'VERIFICATION_REPORT_PARSE_FAILED',
      'pytest_json: failed to parse JSON report',
    );
  }

  const tests = report?.tests;
  if (!Array.isArray(tests) || tests.length === 0) {
    return emptyResult();
  }

  const assertions = tests
    .map((test) => buildPytestAssertion(test, providerId))
    .filter((assertion): assertion is StructuredAssertionEvidence => assertion !== null);

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
