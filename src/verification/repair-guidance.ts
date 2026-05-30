/**
 * @module verification/repair-guidance
 * @description Bounded advisory repair guidance derived from run-check output.
 *
 * This module interprets already-collected ExecutionEvidence. It never executes
 * commands, never changes pass/fail, and never contributes to outputDigest.
 */

import type { ExecutionEvidence } from './executor.js';
import type {
  RepairGuidance,
  RepairGuidanceCategory,
  RepairGuidanceConfidence,
  RepairGuidanceEvidenceExcerpt,
  RepairGuidanceLocation,
} from '../state/evidence-validation.js';

const MAX_PARSE_CHARS = 8_192;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 240;
const MAX_LOCATIONS = 10;

const BASE_NOT_VERIFIED = [
  'NOT_VERIFIED: Repair guidance is derived advisory interpretation and is not validation evidence authority.',
];

interface ParsedOutput {
  readonly category: RepairGuidanceCategory | null;
  readonly confidence: RepairGuidanceConfidence;
  readonly locations: RepairGuidanceLocation[];
  readonly evidence: RepairGuidanceEvidenceExcerpt[];
}

interface StreamLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export function deriveRepairGuidance(evidence: ExecutionEvidence): RepairGuidance {
  const excerpts = collectEvidenceExcerpts(evidence);

  if (evidence.passed) {
    return unavailable('passed', excerpts, [
      'No repair action is recommended for a passing check.',
    ]);
  }

  if (evidence.timedOut) {
    return available('timeout', 'high', [], excerpts, [
      'Inspect whether the command hangs, exceeds the configured timeout, or needs a narrower verification target.',
      'Rerun the check after reducing runtime or increasing coverage of the suspected slow path through normal project configuration.',
    ]);
  }

  const parsed = parseFailureOutput(evidence);
  if (!parsed.category || parsed.confidence === 'low') {
    return unavailable(
      parsed.category ? 'insufficient_confidence' : 'unparseable',
      parsed.evidence.length > 0 ? parsed.evidence : excerpts,
      [
        'Inspect the bounded stdout/stderr excerpts and rerun the failing check after applying a targeted fix.',
      ],
    );
  }

  return available(
    parsed.category,
    parsed.confidence,
    parsed.locations,
    parsed.evidence,
    recommendedActions(parsed.category),
  );
}

function parseFailureOutput(evidence: ExecutionEvidence): ParsedOutput {
  const lines = outputLines(evidence);
  const hasMeaningfulOutput = lines.some((line) => line.text.length > 0);
  const locations = collectLocations(lines);
  const category = hasMeaningfulOutput ? detectCategory(evidence, lines) : null;
  const matchedEvidence = collectEvidenceExcerpts(evidence, category);
  const confidence: RepairGuidanceConfidence = category
    ? locations.length > 0
      ? 'high'
      : 'medium'
    : 'low';

  return {
    category,
    confidence,
    locations,
    evidence: matchedEvidence,
  };
}

function detectCategory(
  evidence: ExecutionEvidence,
  lines: readonly StreamLine[],
): RepairGuidanceCategory | null {
  const combined = lines.map((line) => line.text).join('\n');
  const kind = evidence.kind;

  const typeCheckMatch = /\bTS\d{4}\b|Type '.*' is not assignable|tsc/i.test(combined);
  const lintMatch =
    /\beslint\b|\bno-unused-vars\b|\bprefer-const\b|\berror\s+[^\n]+\s+\w[\w/-]+/i.test(combined);
  const testMatch =
    /\bFAIL\b|AssertionError|\bExpected\b|\btest failed\b|\bTests?\s+failed\b/i.test(combined);
  const formatMatch = /prettier|formatting|Code style issues found|not formatted/i.test(combined);
  const securityMatch =
    /\b(CVE|GHSA)-[\w-]+\b|\bvulnerabilit(?:y|ies)\b|\bseverity\b|npm audit/i.test(combined);
  const coverageMatch =
    /coverage threshold|Statements\s*:\s*\d|Branches\s*:\s*\d|coverage.*failed/i.test(combined);
  const buildMatch =
    /\bbuild failed\b|\bModule not found\b|\bCannot find module\b|\bwebpack\b|\bvite\b|\brollup\b/i.test(
      combined,
    );

  if (kind === 'typecheck' && typeCheckMatch) return 'typecheck';
  if (kind === 'lint' && lintMatch) return 'lint';
  if (kind === 'test' && testMatch) return 'test';
  if (kind === 'format' && formatMatch) return 'format';
  if (kind === 'security' && securityMatch) return 'security';
  if (kind === 'coverage' && coverageMatch) return 'coverage';
  if (kind === 'build' && buildMatch) return 'build';

  if (typeCheckMatch) return 'typecheck';
  if (lintMatch) return 'lint';
  if (testMatch) return 'test';
  if (formatMatch) return 'format';
  if (securityMatch) return 'security';
  if (coverageMatch) return 'coverage';
  if (buildMatch) return 'build';

  return null;
}

function recommendedActions(category: RepairGuidanceCategory): string[] {
  switch (category) {
    case 'typecheck':
      return [
        'Inspect the listed type error locations and fix the type, import, or schema mismatch.',
        'Rerun the typecheck command after the targeted change.',
      ];
    case 'lint':
      return [
        'Fix the reported lint rule violations at the listed locations.',
        'Rerun lint to verify no new violations remain.',
      ];
    case 'test':
      return [
        'Inspect the failing test assertion and the implementation path it exercises.',
        'Apply the smallest behavior or test fixture fix, then rerun the failing test target.',
      ];
    case 'build':
      return [
        'Inspect the first build error and its referenced module or configuration.',
        'Fix the build input or dependency/configuration issue, then rerun the build.',
      ];
    case 'format':
      return [
        'Apply the project formatter or edit the listed files to match formatting rules.',
        'Rerun the format check.',
      ];
    case 'security':
      return [
        'Inspect the reported advisory or vulnerable dependency and choose a policy-compliant remediation.',
        'Rerun the security check after dependency or configuration changes.',
      ];
    case 'coverage':
      return [
        'Identify the coverage threshold that failed and the uncovered changed behavior.',
        'Add focused tests or adjust the implementation path, then rerun coverage.',
      ];
    case 'timeout':
      return [
        'Inspect why the check exceeded its runtime budget without assuming root cause.',
        'Rerun a narrower check or adjust project configuration if the command is expected to be long-running.',
      ];
  }
}

function available(
  category: RepairGuidanceCategory,
  confidence: RepairGuidanceConfidence,
  affectedLocations: RepairGuidanceLocation[],
  evidence: RepairGuidanceEvidenceExcerpt[],
  recommendedNextActions: string[],
): RepairGuidance {
  return {
    kind: 'derived_repair_guidance',
    advisory: true,
    source: 'run_check_output',
    status: 'available',
    category,
    confidence,
    affectedLocations: affectedLocations.slice(0, MAX_LOCATIONS),
    evidence: evidence.slice(0, MAX_EXCERPTS),
    recommendedNextActions,
    notVerified: [...BASE_NOT_VERIFIED],
  };
}

function unavailable(
  reason: 'passed' | 'unparseable' | 'insufficient_confidence',
  evidence: RepairGuidanceEvidenceExcerpt[],
  recommendedNextActions: string[],
): RepairGuidance {
  return {
    kind: 'derived_repair_guidance',
    advisory: true,
    source: 'run_check_output',
    status: 'unavailable',
    reason,
    evidence: evidence.slice(0, reason === 'passed' ? 0 : 1),
    recommendedNextActions,
    notVerified: [
      ...BASE_NOT_VERIFIED,
      'NOT_VERIFIED: No sufficiently reliable repair category was established.',
    ],
  };
}

function collectLocations(lines: readonly StreamLine[]): RepairGuidanceLocation[] {
  const locations: RepairGuidanceLocation[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?<file>[\w./\\-]+\.[\w]+)\((?<line>\d+),(?<column>\d+)\)/,
    /(?<file>[\w./\\-]+\.[\w]+):(?<line>\d+):(?<column>\d+)/,
    /(?<file>[\w./\\-]+\.[\w]+):(?<line>\d+)/,
  ];

  for (const { text } of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match?.groups) continue;
      const location = {
        file: match.groups.file ?? null,
        line: match.groups.line ? Number(match.groups.line) : null,
        column: match.groups.column ? Number(match.groups.column) : null,
      };
      const key = `${location.file}:${location.line}:${location.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(location);
      if (locations.length >= MAX_LOCATIONS) return locations;
    }
  }
  return locations;
}

function collectEvidenceExcerpts(
  evidence: ExecutionEvidence,
  category?: RepairGuidanceCategory | null,
): RepairGuidanceEvidenceExcerpt[] {
  const needles = categoryNeedles(category);
  const excerpts: RepairGuidanceEvidenceExcerpt[] = [];
  for (const line of outputLines(evidence)) {
    if (needles.length > 0 && !needles.some((needle) => needle.test(line.text))) continue;
    excerpts.push({ stream: line.stream, excerpt: sanitizeExcerpt(line.text) });
    if (excerpts.length >= MAX_EXCERPTS) return excerpts;
  }
  if (excerpts.length === 0) {
    for (const line of outputLines(evidence)) {
      excerpts.push({ stream: line.stream, excerpt: sanitizeExcerpt(line.text) });
      if (excerpts.length >= MAX_EXCERPTS) break;
    }
  }
  return excerpts;
}

function categoryNeedles(category?: RepairGuidanceCategory | null): RegExp[] {
  switch (category) {
    case 'typecheck':
      return [/TS\d{4}|Type '.*' is not assignable|error/i];
    case 'lint':
      return [/eslint|\berror\b|\bwarning\b|no-unused|prefer-const/i];
    case 'test':
      return [/FAIL|AssertionError|Expected|failed/i];
    case 'build':
      return [/build failed|Module not found|Cannot find module|error/i];
    case 'format':
      return [/prettier|format|not formatted|Code style/i];
    case 'security':
      return [/CVE|GHSA|vulnerabilit|severity|audit/i];
    case 'coverage':
      return [/coverage|threshold|Statements|Branches/i];
    case 'timeout':
    case null:
    case undefined:
      return [];
  }
}

function outputLines(evidence: ExecutionEvidence): StreamLine[] {
  return [...boundedLines('stdout', evidence.stdout), ...boundedLines('stderr', evidence.stderr)];
}

function boundedLines(stream: 'stdout' | 'stderr', output: string): StreamLine[] {
  return output
    .slice(0, MAX_PARSE_CHARS)
    .split('\n')
    .map((line) => sanitizeLine(line))
    .filter((line) => line.length > 0)
    .map((text) => ({ stream, text }));
}

function sanitizeLine(line: string): string {
  return (
    line
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function sanitizeExcerpt(line: string): string {
  return sanitizeLine(line).slice(0, MAX_EXCERPT_CHARS);
}
