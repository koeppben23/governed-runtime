/**
 * @module verification/assertion-extractor
 * @description Structured assertion extraction from collected reports.
 *
 * Parses raw assertion reports via the registry and validates local
 * identities through provider codecs. Report collection (filesystem I/O,
 * snapshot diffing, stdout reading) lives in assertion-report-collector.ts.
 *
 * @version v2
 */

import type {
  AssertionExtractionResult,
  AssertionExtractionSummary,
} from '../state/evidence-validation.js';
import type { ReportFormatId, ProviderId } from '../state/assertion-identity.js';
import type { AssertionReportSpec } from '../state/discovery-schemas.js';
import type { PreparedVerificationExecution } from './verification-execution.js';
import type { CollectedAssertionReport } from './assertion-report-collector.js';
import { collectAssertionReports } from './assertion-report-collector.js';
import type { ExecutionEvidence } from './executor.js';

import {
  PARSER_BY_FORMAT,
  ASSERTION_FORMATS_BY_PROVIDER,
  AGGREGATE_FORMATS_BY_PROVIDER,
  ASSERTION_CODEC_BY_PROVIDER,
} from '../providers/registry.js';

// ─── Internal ────────────────────────────────────────────────────────────────

interface ParserResult {
  assertions: import('../state/evidence-validation.js').StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

function parseWithFormat(
  format: ReportFormatId,
  providerId: ProviderId,
  content: string,
  fileName: string,
): ParserResult {
  const parser = PARSER_BY_FORMAT.get(format);
  if (!parser) {
    throw new Error(`unsupported assertion report format: ${format}`);
  }
  return parser.parse(content, fileName, { providerId });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function completeAssertionExtraction(
  prepared: PreparedVerificationExecution,
  execution: ExecutionEvidence,
  cwd: string,
): Promise<AssertionExtractionResult> {
  const { attemptId } = prepared;

  if (prepared.assertion.capability !== 'structured') {
    return { status: 'not_configured' };
  }

  const collection = await collectAssertionReports(prepared, execution, cwd);
  if (collection.status === 'blocked') {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: collection.reasonCode,
      reason: collection.reason,
    };
  }

  const report = collection.report;
  const spec = prepared.assertion.report.spec;

  try {
    const raw = await parseCollectedReport(report, attemptId);
    const result = stripNonBindingAssertions(raw, spec);
    return validateExtractedIdentities(result, spec);
  } catch (err: unknown) {
    return {
      status: 'inconclusive',
      attemptId,
      reasonCode: 'parse_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function stripNonBindingAssertions(
  result: AssertionExtractionResult,
  spec: AssertionReportSpec,
): AssertionExtractionResult {
  if (result.status !== 'extracted') return result;

  const bindingCapability = resolveBindingCapability(
    spec.providerId,
    spec.format as ReportFormatId,
  );
  if (bindingCapability !== 'check_only') return { ...result, bindingCapability };

  return {
    ...result,
    bindingCapability: 'check_only',
    assertions: [],
    summary: {
      ...result.summary,
      assertionCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
    },
  };
}

function resolveBindingCapability(
  providerId: ProviderId,
  format: ReportFormatId,
): 'assertion' | 'aggregate' | 'check_only' {
  if (ASSERTION_FORMATS_BY_PROVIDER.get(providerId)?.has(format)) return 'assertion';
  if (AGGREGATE_FORMATS_BY_PROVIDER.get(providerId)?.has(format)) return 'aggregate';
  return 'check_only';
}

function validateExtractedIdentities(
  result: AssertionExtractionResult,
  spec: AssertionReportSpec,
): AssertionExtractionResult {
  if (result.status !== 'extracted' || result.assertions.length === 0) return result;

  const codec = ASSERTION_CODEC_BY_PROVIDER.get(spec.providerId);
  if (!codec) {
    return {
      status: 'inconclusive',
      attemptId: result.attemptId,
      reasonCode: 'identity_codec_missing',
      reason: `Provider '${spec.providerId}' has no registered assertion identity codec`,
    };
  }

  for (const assertion of result.assertions) {
    if (!codec.validateLocalId(assertion.assertion.localId)) {
      return {
        status: 'inconclusive',
        attemptId: result.attemptId,
        reasonCode: 'invalid_local_id',
        reason: `Local assertion id '${assertion.assertion.localId}' failed codec validation for provider '${spec.providerId}'`,
      };
    }
  }
  return result;
}

// ─── Parsing dispatch ────────────────────────────────────────────────────────

async function parseCollectedReport(
  report: CollectedAssertionReport,
  attemptId: string,
): Promise<AssertionExtractionResult> {
  switch (report.transport) {
    case 'stdout': {
      const parsed = parseWithFormat(report.format, report.providerId, report.content, '<stdout>');
      if (!parsed.assertions.length) {
        return {
          status: 'inconclusive',
          attemptId,
          reasonCode: 'report_empty',
          reason: 'report parsing produced no test results',
        };
      }
      return {
        status: 'extracted',
        attemptId,
        providerId: report.providerId,
        format: report.format,
        bindingCapability: resolveBindingCapability(report.providerId, report.format),
        reportDigests: [report.digest],
        assertions: parsed.assertions,
        summary: parsed.summary,
      };
    }
    case 'file': {
      const allAssertions: ParserResult['assertions'] = [];
      const allSummaries: AssertionExtractionSummary[] = [];
      const digests: string[] = [];

      for (const file of report.reports) {
        const parsed = parseWithFormat(report.format, report.providerId, file.content, file.path);
        allAssertions.push(...parsed.assertions);
        allSummaries.push(parsed.summary);
        digests.push(file.digest);
      }

      if (allAssertions.length === 0) {
        return {
          status: 'inconclusive',
          attemptId,
          reasonCode: 'report_empty',
          reason: 'report parsing produced no test results',
        };
      }

      return {
        status: 'extracted',
        attemptId,
        providerId: report.providerId,
        format: report.format,
        bindingCapability: resolveBindingCapability(report.providerId, report.format),
        reportDigests: digests,
        assertions: allAssertions,
        summary: mergeSummaries(allSummaries),
      };
    }
  }
}

// ─── Summary Merging ─────────────────────────────────────────────────────────

function mergeSummaries(summaries: AssertionExtractionSummary[]): AssertionExtractionSummary {
  return {
    assertionCount: sum(summaries, 'assertionCount'),
    passedCount: sum(summaries, 'passedCount'),
    failedCount: sum(summaries, 'failedCount'),
    erroredCount: sum(summaries, 'erroredCount'),
    skippedCount: sum(summaries, 'skippedCount'),
    suiteInfrastructureError: summaries.some((s) => s.suiteInfrastructureError),
  };
}

function sum(
  summaries: AssertionExtractionSummary[],
  key: keyof AssertionExtractionSummary,
): number {
  return summaries.reduce((acc, s) => acc + (s[key] as number), 0);
}
