/**
 * Provider Conformance Contract
 *
 * Defines the generic conformance case descriptor and the registry of
 * conformance cases for each supported assertion provider.
 *
 * Each case maps a real frozen tool output (golden fixture) to expected
 * parser results — pass/fail/skip status, localId values, and summary
 * invariants. The contract is tested by assertion-golden-conformance.test.ts.
 */

import type { ProviderId, ReportFormatId } from '../../../src/state/assertion-identity.js';
import type { AssertionExtractionSummary } from '../../../src/state/evidence-validation.js';

export interface ExpectedAssertion {
  readonly localId: string;
  readonly status: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly testName?: string;
  readonly sourceFile?: string;
}

export interface AssertionProviderConformanceCase {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly format: ReportFormatId;
  readonly collection: 'run_specific' | 'snapshot_diff' | 'stdout';
  readonly fixture: string;
  readonly expected: {
    readonly bindingCapability: 'assertion';
    readonly assertions: readonly ExpectedAssertion[];
    readonly summary: Partial<AssertionExtractionSummary>;
  };
}

export interface NegativeConformanceCase {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly format: ReportFormatId;
  readonly fixture: string;
  readonly expectedStatus: 'inconclusive' | 'blocked';
  readonly expectedReasonCode: string;
}

// ─── JUnit (Maven Surefire 3.5.2 + JUnit Jupiter 5.11.4) ──────────────────

const JUNIT_MAVEN_BASIC: AssertionProviderConformanceCase = {
  id: 'junit-maven-basic',
  providerId: 'junit',
  format: 'junit_xml',
  collection: 'snapshot_diff',
  fixture: 'junit/TEST-com.example.CalculatorTest$AdvancedOperations.xml',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'com.example.CalculatorTest#testAddition',
        status: 'passed',
        testName: 'testAddition',
      },
      {
        localId: 'com.example.CalculatorTest#testFailingAssertion',
        status: 'failed',
        testName: 'testFailingAssertion',
      },
      {
        localId: 'com.example.CalculatorTest#testSkipped',
        status: 'skipped',
        testName: 'testSkipped',
      },
      {
        localId: 'com.example.CalculatorTest#testSubtraction',
        status: 'passed',
        testName: 'testSubtraction',
      },
      {
        localId: 'com.example.CalculatorTest$AdvancedOperations#testNestedFailing',
        status: 'failed',
        testName: 'testNestedFailing',
      },
      {
        localId: 'com.example.CalculatorTest$AdvancedOperations#testMultiplication',
        status: 'passed',
        testName: 'testMultiplication',
      },
    ],
    summary: {
      assertionCount: 6,
      passedCount: 3,
      failedCount: 2,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

const JUNIT_MULTI_SUITE: AssertionProviderConformanceCase = {
  id: 'junit-multi-suite',
  providerId: 'junit',
  format: 'junit_xml',
  collection: 'snapshot_diff',
  fixture: 'junit/multi-suite.xml',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'com.example.CalculatorTest#testAddition',
        status: 'passed',
        testName: 'testAddition',
      },
      {
        localId: 'com.example.CalculatorTest#testFailingAssertion',
        status: 'failed',
        testName: 'testFailingAssertion',
      },
      {
        localId: 'com.example.CalculatorTest#testSkipped',
        status: 'skipped',
        testName: 'testSkipped',
      },
      {
        localId: 'com.example.CalculatorTest#testSubtraction',
        status: 'passed',
        testName: 'testSubtraction',
      },
      {
        localId: 'com.example.CalculatorTest$AdvancedOperations#testNestedFailing',
        status: 'failed',
        testName: 'testNestedFailing',
      },
      {
        localId: 'com.example.CalculatorTest$AdvancedOperations#testMultiplication',
        status: 'passed',
        testName: 'testMultiplication',
      },
    ],
    summary: {
      assertionCount: 6,
      passedCount: 3,
      failedCount: 2,
      erroredCount: 0,
      skippedCount: 1,
    },
  },
};

// ─── Vitest 3.2.7 ─────────────────────────────────────────────────────────

const VITEST_BASIC: AssertionProviderConformanceCase = {
  id: 'vitest-basic',
  providerId: 'vitest',
  format: 'vitest_json',
  collection: 'run_specific',
  fixture: 'vitest/pass-fail-skip.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId:
          'src/math.test.ts::calculator::add::adds two positive numbers',
        status: 'passed',
        testName: 'adds two positive numbers',
      },
      {
        localId:
          'src/math.test.ts::calculator::add::adds negative numbers',
        status: 'passed',
        testName: 'adds negative numbers',
      },
      {
        localId:
          'src/math.test.ts::calculator::subtract::subtracts two numbers',
        status: 'passed',
        testName: 'subtracts two numbers',
      },
      {
        localId:
          'src/math.test.ts::calculator::multiply::multiplies two numbers',
        status: 'passed',
        testName: 'multiplies two numbers',
      },
      {
        localId:
          'src/math.test.ts::calculator::multiply::failing multiplication',
        status: 'failed',
        testName: 'failing multiplication',
      },
      {
        localId:
          'src/math.test.ts::calculator::skipped division test',
        status: 'skipped',
        testName: 'skipped division test',
      },
    ],
    summary: {
      assertionCount: 6,
      passedCount: 4,
      failedCount: 1,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

const VITEST_NESTED: AssertionProviderConformanceCase = {
  id: 'vitest-nested',
  providerId: 'vitest',
  format: 'vitest_json',
  collection: 'run_specific',
  fixture: 'vitest/nested.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId:
          'src/nested.test.ts::outer::inner::nested passes',
        status: 'passed',
        testName: 'nested passes',
      },
      {
        localId:
          'src/nested.test.ts::outer::inner::nested fails',
        status: 'failed',
        testName: 'nested fails',
      },
      {
        localId: 'src/nested.test.ts::outer::outer skipped',
        status: 'skipped',
        testName: 'outer skipped',
      },
    ],
    summary: {
      assertionCount: 3,
      passedCount: 1,
      failedCount: 1,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

const JEST_NESTED: AssertionProviderConformanceCase = {
  id: 'jest-nested',
  providerId: 'jest',
  format: 'jest_json',
  collection: 'run_specific',
  fixture: 'jest/nested.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId:
          'src/nested.test.js::outer::inner::nested passes',
        status: 'passed',
        testName: 'nested passes',
      },
      {
        localId:
          'src/nested.test.js::outer::inner::nested fails',
        status: 'failed',
        testName: 'nested fails',
      },
      {
        localId: 'src/nested.test.js::outer::outer skipped',
        status: 'skipped',
        testName: 'outer skipped',
      },
    ],
    summary: {
      assertionCount: 3,
      passedCount: 1,
      failedCount: 1,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

// ─── Jest 29.7.0 ──────────────────────────────────────────────────────────

const JEST_BASIC: AssertionProviderConformanceCase = {
  id: 'jest-basic',
  providerId: 'jest',
  format: 'jest_json',
  collection: 'run_specific',
  fixture: 'jest/pass-fail-skip.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId:
          'src/math.test.js::calculator::add::adds two positive numbers',
        status: 'passed',
        testName: 'adds two positive numbers',
      },
      {
        localId:
          'src/math.test.js::calculator::add::adds negative numbers',
        status: 'passed',
        testName: 'adds negative numbers',
      },
      {
        localId:
          'src/math.test.js::calculator::subtract::subtracts two numbers',
        status: 'passed',
        testName: 'subtracts two numbers',
      },
      {
        localId:
          'src/math.test.js::calculator::multiply::multiplies two numbers',
        status: 'passed',
        testName: 'multiplies two numbers',
      },
      {
        localId:
          'src/math.test.js::calculator::multiply::failing multiplication',
        status: 'failed',
        testName: 'failing multiplication',
      },
      {
        localId:
          'src/math.test.js::calculator::skipped division test',
        status: 'skipped',
        testName: 'skipped division test',
      },
    ],
    summary: {
      assertionCount: 6,
      passedCount: 4,
      failedCount: 1,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

const PYTEST_PARAMETRIZED: AssertionProviderConformanceCase = {
  id: 'pytest-parametrized',
  providerId: 'pytest',
  format: 'pytest_json',
  collection: 'run_specific',
  fixture: 'pytest/parametrized.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'tests/test_math.py::test_parametrized[2-3-5]',
        status: 'passed',
        testName: 'test_parametrized[2-3-5]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized[-1--1--2]',
        status: 'passed',
        testName: 'test_parametrized[-1--1--2]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized[0-5-5]',
        status: 'passed',
        testName: 'test_parametrized[0-5-5]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized_failing[2-3-6]',
        status: 'failed',
        testName: 'test_parametrized_failing[2-3-6]',
      },
    ],
    summary: {
      assertionCount: 4,
      passedCount: 3,
      failedCount: 1,
      erroredCount: 0,
      skippedCount: 0,
    },
  },
};

// ─── pytest 8.4.2 + pytest-json-report 1.5.0 ──────────────────────────────

const PYTEST_BASIC: AssertionProviderConformanceCase = {
  id: 'pytest-basic',
  providerId: 'pytest',
  format: 'pytest_json',
  collection: 'run_specific',
  fixture: 'pytest/pass-fail-skip.json',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'tests/test_math.py::test_addition',
        status: 'passed',
        testName: 'test_addition',
      },
      {
        localId: 'tests/test_math.py::test_subtraction',
        status: 'passed',
        testName: 'test_subtraction',
      },
      {
        localId: 'tests/test_math.py::test_failing_assertion',
        status: 'failed',
        testName: 'test_failing_assertion',
      },
      {
        localId: 'tests/test_math.py::test_skipped',
        status: 'skipped',
        testName: 'test_skipped',
      },
      {
        localId: 'tests/test_math.py::test_parametrized[2-3-5]',
        status: 'passed',
        testName: 'test_parametrized[2-3-5]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized[-1--1--2]',
        status: 'passed',
        testName: 'test_parametrized[-1--1--2]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized[0-5-5]',
        status: 'passed',
        testName: 'test_parametrized[0-5-5]',
      },
      {
        localId: 'tests/test_math.py::test_parametrized_failing[2-3-6]',
        status: 'failed',
        testName: 'test_parametrized_failing[2-3-6]',
      },
      {
        localId: 'tests/test_math.py::TestMultiply::test_positive',
        status: 'passed',
        testName: 'test_positive',
      },
      {
        localId: 'tests/test_math.py::TestMultiply::test_with_zero',
        status: 'passed',
        testName: 'test_with_zero',
      },
      {
        localId: 'tests/test_math.py::TestMultiply::test_failing',
        status: 'failed',
        testName: 'test_failing',
      },
    ],
    summary: {
      assertionCount: 11,
      passedCount: 7,
      failedCount: 3,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

const GO_SUBTESTS: AssertionProviderConformanceCase = {
  id: 'go-subtests',
  providerId: 'go_test',
  format: 'go_test_json',
  collection: 'stdout',
  fixture: 'go/subtests.jsonl',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'flowguard-conformance-go::TestNested',
        status: 'failed',
        testName: 'TestNested',
      },
      {
        localId:
          'flowguard-conformance-go::TestNested/nested_failing',
        status: 'failed',
        testName: 'TestNested/nested_failing',
      },
      {
        localId:
          'flowguard-conformance-go::TestNested/multiplication',
        status: 'passed',
        testName: 'TestNested/multiplication',
      },
    ],
    summary: {
      assertionCount: 3,
      passedCount: 1,
      failedCount: 2,
      erroredCount: 0,
      skippedCount: 0,
    },
  },
};

// ─── Go 1.26.5 ────────────────────────────────────────────────────────────

const GO_BASIC: AssertionProviderConformanceCase = {
  id: 'go-basic',
  providerId: 'go_test',
  format: 'go_test_json',
  collection: 'stdout',
  fixture: 'go/pass-fail-skip.jsonl',
  expected: {
    bindingCapability: 'assertion',
    assertions: [
      {
        localId: 'flowguard-conformance-go::TestAddition',
        status: 'passed',
        testName: 'TestAddition',
      },
      {
        localId: 'flowguard-conformance-go::TestSubtraction',
        status: 'passed',
        testName: 'TestSubtraction',
      },
      {
        localId: 'flowguard-conformance-go::TestFailing',
        status: 'failed',
        testName: 'TestFailing',
      },
      {
        localId: 'flowguard-conformance-go::TestNested',
        status: 'failed',
        testName: 'TestNested',
      },
      {
        localId: 'flowguard-conformance-go::TestNested/multiplication',
        status: 'passed',
        testName: 'TestNested/multiplication',
      },
      {
        localId: 'flowguard-conformance-go::TestNested/nested_failing',
        status: 'failed',
        testName: 'TestNested/nested_failing',
      },
      {
        localId: 'flowguard-conformance-go::TestSkipped',
        status: 'skipped',
        testName: 'TestSkipped',
      },
    ],
    summary: {
      assertionCount: 7,
      passedCount: 3,
      failedCount: 3,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  },
};

// ─── Exported registry ────────────────────────────────────────────────────

export const CONFORMANCE_CASES: readonly AssertionProviderConformanceCase[] = [
  JUNIT_MAVEN_BASIC,
  JUNIT_MULTI_SUITE,
  VITEST_BASIC,
  VITEST_NESTED,
  JEST_BASIC,
  JEST_NESTED,
  PYTEST_BASIC,
  PYTEST_PARAMETRIZED,
  GO_BASIC,
  GO_SUBTESTS,
];

export const NEGATIVE_CASES: readonly NegativeConformanceCase[] = [
  {
    id: 'junit-malformed',
    providerId: 'junit',
    format: 'junit_xml',
    fixture: 'junit/malformed.xml',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'parse_failed',
  },
  {
    id: 'junit-empty',
    providerId: 'junit',
    format: 'junit_xml',
    fixture: 'junit/empty-testsuite.xml',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'report_empty',
  },
  {
    id: 'vitest-malformed',
    providerId: 'vitest',
    format: 'vitest_json',
    fixture: 'vitest/malformed.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'parse_failed',
  },
  {
    id: 'vitest-empty',
    providerId: 'vitest',
    format: 'vitest_json',
    fixture: 'vitest/empty.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'report_empty',
  },
  {
    id: 'jest-malformed',
    providerId: 'jest',
    format: 'jest_json',
    fixture: 'jest/malformed.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'parse_failed',
  },
  {
    id: 'jest-empty',
    providerId: 'jest',
    format: 'jest_json',
    fixture: 'jest/empty.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'report_empty',
  },
  {
    id: 'pytest-malformed',
    providerId: 'pytest',
    format: 'pytest_json',
    fixture: 'pytest/malformed.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'parse_failed',
  },
  {
    id: 'pytest-empty',
    providerId: 'pytest',
    format: 'pytest_json',
    fixture: 'pytest/empty.json',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'report_empty',
  },
  {
    id: 'go-empty',
    providerId: 'go_test',
    format: 'go_test_json',
    fixture: 'go/empty.jsonl',
    expectedStatus: 'inconclusive',
    expectedReasonCode: 'report_empty',
  },
];
