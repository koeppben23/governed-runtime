/**
 * @module verification/assertion-parsers/types
 * @description Discriminated assertion parse result, parser context, and
 * provider interfaces for the assertion extraction pipeline.
 *
 * @version v1
 */

import type { ProviderId, ReportFormatId } from '../../state/assertion-identity.js';
import type {
  StructuredAssertionEvidence,
  AssertionExtractionSummary,
} from '../../state/evidence-validation.js';

// ─── Discriminated parse input ───────────────────────────────────────────────

/**
 * Framework- and format-specific assertion parse input.
 *
 * Each variant corresponds to exactly one report format. The codec receives the
 * same parsed input regardless of which provider is encoded — e.g. a
 * `junit_xml` parse input is identical whether the actual framework is JUnit or
 * pytest. The difference is in the {@link codec} that consumes it.
 */
export type ParsedAssertion =
  | {
      kind: 'junit_xml';
      className: string;
      methodName: string;
      sourceFile?: string;
    }
  | {
      kind: 'pytest_json';
      nodeId: string;
    }
  | {
      kind: 'jest_json' | 'vitest_json';
      filePath: string;
      ancestorTitles: readonly string[];
      title: string;
    }
  | {
      kind: 'go_test_json';
      pkg: string;
      testName: string;
    };

// ─── Parser context ──────────────────────────────────────────────────────────

export interface ParseContext {
  readonly providerId: ProviderId;
}

// ─── Parser result ───────────────────────────────────────────────────────────

export interface ParserResult {
  assertions: StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Parses a raw assertion report into structured evidence.
 *
 * Receives the provider context so a single format parser can serve multiple
 * frameworks (e.g. junit_xml for both junit and pytest).
 */
export interface AssertionReportParser {
  readonly format: ReportFormatId;
  parse(content: string, fileName: string, context: ParseContext): ParserResult;
}

/**
 * Encodes and validates provider-specific local assertion identities.
 *
 * Only assertion-binding-capable providers expose a codec. A provider that
 * supports a format for check-level evidence but not for assertion-level
 * binding simply omits a codec from the registry.
 */
export interface AssertionIdentityCodec {
  readonly providerId: ProviderId;
  /** Set of report formats for which this codec can produce a stable localId. */
  readonly assertionBindingFormats: ReadonlySet<ReportFormatId>;
  /** Build a canonical localId from a parsed assertion. */
  buildLocalId(parsed: ParsedAssertion): string;
  /** Validate whether a user-supplied localId matches this codec's format. */
  validateLocalId(localId: string): boolean;
}
