import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
} from '../../state/evidence-validation.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { ParseContext, ParserResult } from './types.js';
import { hashText } from '../../shared/hashing.js';

interface GoTestEvent {
  Action?: string;
  Test?: string;
  Package?: string;
  Output?: string;
  Elapsed?: number;
}

function mapStatus(action: string): 'passed' | 'failed' | 'skipped' {
  if (action === 'pass') return 'passed';
  if (action === 'fail') return 'failed';
  return 'skipped';
}

export function buildGoLocalId(pkg: string, test: string): string {
  return `${pkg}::${test}`;
}

function testKey(pkg: string, test: string): string {
  return `${pkg}\x00${test}`;
}

function parseGoEventLine(line: string): GoTestEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const event: GoTestEvent = JSON.parse(trimmed);
    return event;
  } catch {
    return null;
  }
}

function buildFailedGoFailure(outputs: readonly string[]): StructuredAssertionEvidence['failure'] {
  const firstLine = outputs.find((o) => o.trim())?.trim();
  return {
    message: firstLine ? firstLine.split('\n')[0] : undefined,
    detailDigest: outputs.length > 0 ? hashText(outputs.join('')) : undefined,
  };
}

function recordGoTestOutput(
  event: GoTestEvent,
  pkg: string,
  test: string,
  outputByTest: Map<string, string[]>,
): void {
  const key = testKey(pkg, test);
  const outputs = outputByTest.get(key) ?? [];
  outputs.push(event.Output ?? '');
  outputByTest.set(key, outputs);
}

function buildTerminalGoAssertion(
  event: GoTestEvent,
  pkg: string,
  test: string,
  providerId: ProviderId,
  outputByTest: Map<string, string[]>,
): StructuredAssertionEvidence {
  const status = mapStatus(event.Action ?? '');
  const localId = buildGoLocalId(pkg, test);
  const assertion: AssertionIdentity = { providerId, localId };
  const key = testKey(pkg, test);
  const outputs = outputByTest.get(key) ?? [];
  outputByTest.delete(key);

  return {
    assertion,
    providerId,
    status,
    suiteName: pkg || undefined,
    testName: test,
    durationMs: typeof event.Elapsed === 'number' ? Math.round(event.Elapsed * 1000) : undefined,
    failure: status === 'failed' ? buildFailedGoFailure(outputs) : undefined,
  };
}

function processGoTestEvent(
  event: GoTestEvent,
  outputByTest: Map<string, string[]>,
  providerId: ProviderId,
): StructuredAssertionEvidence | null {
  const action = event.Action;
  const pkg = event.Package ?? '';
  const test = event.Test;

  if (action === 'output' && test) {
    recordGoTestOutput(event, pkg, test, outputByTest);
    return null;
  }

  if ((action === 'pass' || action === 'fail' || action === 'skip') && test) {
    return buildTerminalGoAssertion(event, pkg, test, providerId, outputByTest);
  }

  return null;
}

export function parseGoTestJson(eventsJson: string, context: ParseContext): ParserResult {
  const providerId: ProviderId = context.providerId;
  const lines = eventsJson.split('\n');
  const outputByTest = new Map<string, string[]>();
  const assertions: StructuredAssertionEvidence[] = [];

  for (const line of lines) {
    const event = parseGoEventLine(line);
    if (event === null) continue;
    const assertion = processGoTestEvent(event, outputByTest, providerId);
    if (assertion !== null) assertions.push(assertion);
  }

  if (assertions.length === 0) {
    return emptyResult();
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
