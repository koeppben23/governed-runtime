/**
 * @module discovery/collectors/domain-signals
 * @description Collector: domain keyword and glossary source detection.
 *
 * Detects domain-relevant signals from file paths:
 * - Directory/file names that suggest domain concepts (e.g., "payment", "invoice")
 * - Glossary source files (README, GLOSSARY, CONTRIBUTING)
 *
 * All detection is path-based (no file content reading).
 * Classification is "derived_signal" for keyword inference from paths.
 *
 * @version v1
 */

import * as path from "node:path";
import type {
  CollectorInput,
  CollectorOutput,
  DomainSignals,
  DomainKeyword,
} from "../types";

// ─── Domain Keyword Rules ─────────────────────────────────────────────────────

/**
 * Domain keyword categories detected from directory/file names.
 * Each keyword maps to patterns found in path segments.
 */
const DOMAIN_KEYWORDS: ReadonlyArray<{
  term: string;
  patterns: readonly RegExp[];
}> = [
  { term: "authentication", patterns: [/\bauth\b/i, /\blogin\b/i, /\bsignup\b/i] },
  { term: "authorization", patterns: [/\bpermission/i, /\broles?\b/i, /\bacl\b/i] },
  { term: "payment", patterns: [/\bpayment/i, /\bbilling\b/i, /\binvoice/i, /\bcheckout\b/i] },
  { term: "user-management", patterns: [/\busers?\b/i, /\bprofile/i, /\baccount/i] },
  { term: "messaging", patterns: [/\bmessag/i, /\bnotif/i, /\bemail/i, /\bchat\b/i] },
  { term: "scheduling", patterns: [/\bschedul/i, /\bcron\b/i, /\bjob/i, /\bqueue/i] },
  { term: "analytics", patterns: [/\banalytics?\b/i, /\bmetric/i, /\btelemetry/i] },
  { term: "storage", patterns: [/\bstorage\b/i, /\bupload/i, /\bblob\b/i, /\bs3\b/i] },
  { term: "search", patterns: [/\bsearch\b/i, /\belastic/i, /\bindex/i] },
  { term: "configuration", patterns: [/\bconfig\b/i, /\bsettings?\b/i, /\bpreferenc/i] },
];

/** Files that might contain domain glossary or documentation. */
const GLOSSARY_PATTERNS: readonly RegExp[] = [
  /^readme/i,
  /^glossary/i,
  /^contributing/i,
  /^architecture/i,
  /^adr\//i,
  /^docs?\//i,
  /^wiki\//i,
  /^dictionary/i,
  /^domain/i,
];

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect domain signals from repository file paths.
 *
 * Scans file paths for domain-relevant keywords and identifies
 * potential glossary source files.
 */
export async function collectDomainSignals(
  input: CollectorInput,
): Promise<CollectorOutput<DomainSignals>> {
  try {
    const normalized = input.allFiles.map((f) => f.replace(/\\/g, "/"));
    const keywords = detectKeywords(normalized);
    const glossarySources = detectGlossarySources(normalized);

    return {
      status: "complete",
      data: { keywords, glossarySources },
    };
  } catch {
    return {
      status: "failed",
      data: { keywords: [], glossarySources: [] },
    };
  }
}

// ─── Internal Detection Functions ─────────────────────────────────────────────

/**
 * Detect domain keywords by matching path segments against known patterns.
 */
function detectKeywords(files: readonly string[]): DomainKeyword[] {
  const counts = new Map<string, number>();

  for (const filePath of files) {
    // Extract path segments for matching
    const segments = filePath.split("/");
    const pathStr = segments.join(" ") + " " + path.basename(filePath);

    for (const rule of DOMAIN_KEYWORDS) {
      if (rule.patterns.some((p) => p.test(pathStr))) {
        counts.set(rule.term, (counts.get(rule.term) ?? 0) + 1);
      }
    }
  }

  const keywords: DomainKeyword[] = [];
  for (const [term, occurrences] of counts) {
    keywords.push({
      term,
      occurrences,
      classification: "derived_signal",
    });
  }

  // Sort by occurrences descending
  return keywords.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Detect glossary source files by matching against known patterns.
 */
function detectGlossarySources(files: readonly string[]): string[] {
  const sources: string[] = [];

  for (const filePath of files) {
    if (GLOSSARY_PATTERNS.some((p) => p.test(filePath))) {
      sources.push(filePath);
      // Limit to 10 glossary sources
      if (sources.length >= 10) break;
    }
  }

  return sources;
}
