/**
 * @module verification/assertion-parsers/registry
 * @description Central lookup registry for assertion report parsers and identity codecs.
 *
 * Immutable maps — no runtime registration. Adding a provider or format
 * requires editing this file (compile-time visibility).
 *
 * @version v1
 */

import type { ReportFormatId } from '../../state/assertion-identity.js';
import type { ProviderId } from '../../state/evidence-validation.js';
import type { AssertionReportParser, AssertionIdentityCodec, ParsedAssertion } from './types.js';

import { parseJUnitXml, buildJUnitLocalId } from './junit-xml.js';
import { parseVitestJson, buildVitestLocalId } from './vitest-json.js';
import { parseJestJson, buildJestLocalId } from './jest-json.js';
import { parseGoTestJson, buildGoLocalId } from './go-test-json.js';
import { parsePytestJson, buildPytestLocalId } from './pytest-json.js';

// ─── Parsers (lookup by FORMAT) ──────────────────────────────────────────────

export const PARSER_BY_FORMAT: ReadonlyMap<ReportFormatId, AssertionReportParser> = new Map([
  [
    'junit_xml',
    {
      format: 'junit_xml',
      parse(content, fileName, context) {
        return parseJUnitXml(content, fileName, context);
      },
    },
  ],
  [
    'vitest_json',
    {
      format: 'vitest_json',
      parse(content, _fileName, context) {
        return parseVitestJson(content, context);
      },
    },
  ],
  [
    'jest_json',
    {
      format: 'jest_json',
      parse(content, _fileName, context) {
        return parseJestJson(content, context);
      },
    },
  ],
  [
    'go_test_json',
    {
      format: 'go_test_json',
      parse(content, _fileName, context) {
        return parseGoTestJson(content, context);
      },
    },
  ],
  [
    'pytest_json',
    {
      format: 'pytest_json',
      parse(content, _fileName, context) {
        return parsePytestJson(content, context);
      },
    },
  ],
]);

// ─── Codecs (lookup by PROVIDER — only assertion-binding-capable) ────────────

const JUNIT_LOCAL_ID_RE = /^[^#]+#[^#]+$/;
const PYTEST_LOCAL_ID_RE = /^[^:]+(::[^:]+)+$/;
const JS_LOCAL_ID_RE = /^[^:]+(::[^:]+)+$/;
const GO_LOCAL_ID_RE = /^[^:]+::[^:]+$/;

const junitCodec: AssertionIdentityCodec = {
  providerId: 'junit' as ProviderId,
  assertionBindingFormats: new Set<ReportFormatId>(['junit_xml']),
  buildLocalId(parsed) {
    if (parsed.kind !== 'junit_xml') {
      return `${parsed.kind}#unknown`;
    }
    return buildJUnitLocalId(parsed.className, parsed.methodName);
  },
  validateLocalId(localId) {
    return JUNIT_LOCAL_ID_RE.test(localId);
  },
};

const vitestCodec: AssertionIdentityCodec = {
  providerId: 'vitest' as ProviderId,
  assertionBindingFormats: new Set<ReportFormatId>(['vitest_json']),
  buildLocalId(parsed) {
    if (parsed.kind !== 'vitest_json') {
      return 'vitest_json::unknown';
    }
    return buildVitestLocalId(parsed.filePath, [...parsed.ancestorTitles], parsed.title);
  },
  validateLocalId(localId) {
    return JS_LOCAL_ID_RE.test(localId);
  },
};

const jestCodec: AssertionIdentityCodec = {
  providerId: 'jest' as ProviderId,
  assertionBindingFormats: new Set<ReportFormatId>(['jest_json']),
  buildLocalId(parsed) {
    if (parsed.kind !== 'jest_json') {
      return 'jest_json::unknown';
    }
    return buildJestLocalId(parsed.filePath, [...parsed.ancestorTitles], parsed.title);
  },
  validateLocalId(localId) {
    return JS_LOCAL_ID_RE.test(localId);
  },
};

const goTestCodec: AssertionIdentityCodec = {
  providerId: 'go_test' as ProviderId,
  assertionBindingFormats: new Set<ReportFormatId>(['go_test_json']),
  buildLocalId(parsed) {
    if (parsed.kind !== 'go_test_json') {
      return 'go_test_json::unknown';
    }
    return buildGoLocalId(parsed.pkg, parsed.testName);
  },
  validateLocalId(localId) {
    return GO_LOCAL_ID_RE.test(localId);
  },
};

const pytestCodec: AssertionIdentityCodec = {
  providerId: 'pytest' as ProviderId,
  assertionBindingFormats: new Set<ReportFormatId>(['pytest_json']),
  buildLocalId(parsed) {
    if (parsed.kind !== 'pytest_json') {
      return 'pytest_json::unknown';
    }
    return buildPytestLocalId(parsed.nodeId);
  },
  validateLocalId(localId) {
    return PYTEST_LOCAL_ID_RE.test(localId);
  },
};

export const ASSERTION_CODEC_BY_PROVIDER: ReadonlyMap<ProviderId, AssertionIdentityCodec> = new Map(
  [
    ['junit' as ProviderId, junitCodec],
    ['vitest' as ProviderId, vitestCodec],
    ['jest' as ProviderId, jestCodec],
    ['go_test' as ProviderId, goTestCodec],
    ['pytest' as ProviderId, pytestCodec],
  ],
);

// ─── Format → Provider table ─────────────────────────────────────────────────

/** All formats a provider supports (for check-level evidence). */
export const FORMATS_BY_PROVIDER: ReadonlyMap<ProviderId, ReadonlySet<ReportFormatId>> = new Map([
  ['junit' as ProviderId, new Set<ReportFormatId>(['junit_xml'])],
  ['pytest' as ProviderId, new Set<ReportFormatId>(['pytest_json', 'junit_xml'])],
  ['vitest' as ProviderId, new Set<ReportFormatId>(['vitest_json'])],
  ['jest' as ProviderId, new Set<ReportFormatId>(['jest_json'])],
  ['go_test' as ProviderId, new Set<ReportFormatId>(['go_test_json'])],
]);

/** Formats for which a provider can produce stable assertion-level identities. */
export const ASSERTION_FORMATS_BY_PROVIDER: ReadonlyMap<
  ProviderId,
  ReadonlySet<ReportFormatId>
> = new Map([
  ['junit' as ProviderId, new Set<ReportFormatId>(['junit_xml'])],
  ['pytest' as ProviderId, new Set<ReportFormatId>(['pytest_json'])],
  ['vitest' as ProviderId, new Set<ReportFormatId>(['vitest_json'])],
  ['jest' as ProviderId, new Set<ReportFormatId>(['jest_json'])],
  ['go_test' as ProviderId, new Set<ReportFormatId>(['go_test_json'])],
]);

// ─── Resolution helpers ──────────────────────────────────────────────────────

export type IdentityResolution =
  | { status: 'resolved'; localId: string }
  | { status: 'unknown_provider' }
  | { status: 'no_assertion_codec'; reason: string }
  | { status: 'invalid_format'; reason: string }
  | { status: 'invalid_local_id'; reason: string };

export function resolveLocalIdentity(
  providerId: ProviderId,
  parsed: ParsedAssertion,
): IdentityResolution {
  const codec = ASSERTION_CODEC_BY_PROVIDER.get(providerId);
  if (!codec) return { status: 'unknown_provider' };

  const format = parsed.kind;
  if (!codec.assertionBindingFormats.has(format as ReportFormatId)) {
    return {
      status: 'no_assertion_codec',
      reason: `provider '${providerId}' cannot produce assertion-level identities from ${format} reports`,
    };
  }

  const localId = codec.buildLocalId(parsed);
  if (!codec.validateLocalId(localId)) {
    return { status: 'invalid_local_id', reason: `invalid localId for ${providerId}: ${localId}` };
  }

  return { status: 'resolved', localId };
}
