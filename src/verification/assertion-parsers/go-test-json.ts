import type {
  AssertionExtractionSummary,
  StructuredAssertionEvidence,
  StructuredAssertionFramework,
} from '../../state/evidence-validation.js';
import { createHash } from 'node:crypto';

interface GoTestJsonResult {
  assertions: StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

interface GoTestEvent {
  Action?: string;
  Test?: string;
  Package?: string;
  Output?: string;
  Elapsed?: number;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function mapStatus(action: string): 'passed' | 'failed' | 'skipped' {
  if (action === 'pass') return 'passed';
  if (action === 'fail') return 'failed';
  return 'skipped';
}

function buildAssertionId(pkg: string, test: string): string {
  return `go:${pkg}::${test}`;
}

function testKey(pkg: string, test: string): string {
  return `${pkg}\x00${test}`;
}

export function parseGoTestJson(eventsJson: string): GoTestJsonResult {
  const lines = eventsJson.split('\n');
  const outputByTest = new Map<string, string[]>();
  const assertions: StructuredAssertionEvidence[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: GoTestEvent;
    try {
      event = JSON.parse(trimmed) as GoTestEvent;
    } catch {
      continue;
    }

    const action = event.Action;
    const pkg = event.Package ?? '';
    const test = event.Test;

    if (action === 'output' && test) {
      const key = testKey(pkg, test);
      const outputs = outputByTest.get(key) ?? [];
      outputs.push(event.Output ?? '');
      outputByTest.set(key, outputs);
      continue;
    }

    if ((action === 'pass' || action === 'fail' || action === 'skip') && test) {
      const status = mapStatus(action);
      const assertionId = buildAssertionId(pkg, test);
      const key = testKey(pkg, test);
      const outputs = outputByTest.get(key) ?? [];

      let failure: StructuredAssertionEvidence['failure'];
      if (status === 'failed') {
        const firstLine = outputs.find((o) => o.trim())?.trim();
        failure = {
          message: firstLine ? firstLine.split('\n')[0] : undefined,
          detailDigest: outputs.length > 0 ? sha256(outputs.join('')) : undefined,
        };
      }

      assertions.push({
        assertionId,
        framework: 'go_test' as StructuredAssertionFramework,
        status,
        suiteName: pkg || undefined,
        testName: test,
        durationMs:
          typeof event.Elapsed === 'number' ? Math.round(event.Elapsed * 1000) : undefined,
        failure,
      });

      outputByTest.delete(key);
    }
  }

  if (assertions.length === 0) {
    return emptyResult();
  }

  return {
    assertions,
    summary: buildSummary(assertions),
  };
}

function emptyResult(): GoTestJsonResult {
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
