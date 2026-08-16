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
import { createHash } from 'node:crypto';

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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
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

export function parsePytestJson(jsonText: string, context: ParseContext): ParserResult {
  const providerId: ProviderId = context.providerId;

  let report: PytestJsonReport;
  try {
    report = JSON.parse(jsonText) as PytestJsonReport;
  } catch {
    throw new Error('pytest_json: failed to parse JSON report');
  }

  const tests = report?.tests;
  if (!Array.isArray(tests) || tests.length === 0) {
    return emptyResult();
  }

  const assertions: StructuredAssertionEvidence[] = [];

  for (const test of tests) {
    const nodeId = test.nodeid;
    if (!nodeId) continue;

    const outcome = test.outcome ?? 'skipped';
    // Determine the primary status: check call phase first, then overall
    const callOutcome = test.call?.outcome ?? outcome;
    const status = mapStatus(callOutcome);
    const localId = buildPytestLocalId(nodeId);
    const assertion: AssertionIdentity = { providerId, localId };

    let failure: StructuredAssertionEvidence['failure'];
    if (status === 'failed' && test.call?.longrepr) {
      const longrepr = test.call.longrepr;
      failure = {
        message: longrepr.split('\n')[0] || undefined,
        detailDigest: sha256(longrepr),
      };
    } else if (status === 'errored') {
      const setupErr = test.setup?.outcome === 'error' ? test.setup : undefined;
      const teardownErr = test.teardown?.outcome === 'error' ? test.teardown : undefined;
      const detail = setupErr ?? teardownErr;
      if (detail && test.call?.longrepr) {
        failure = {
          message: test.call.longrepr.split('\n')[0] || undefined,
          detailDigest: sha256(test.call.longrepr),
        };
      }
    }

    const testName = nodeId.split('::').pop() ?? nodeId;

    assertions.push({
      assertion,
      providerId,
      status,
      suiteName: undefined,
      testName,
      durationMs:
        typeof test.call?.duration === 'number' ? Math.round(test.call.duration * 1000) : undefined,
      failure,
    });
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
