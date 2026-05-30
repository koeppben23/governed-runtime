/**
 * @module discovery/collectors/code-surface-semantic-extractors
 * @description Conservative semantic code-surface extractors for common frameworks.
 *
 * These extractors are advisory and bounded by the caller's scan budget. They
 * never install dependencies, perform network access, or claim complete
 * architecture understanding.
 */

import * as path from 'node:path';
import type { CodeSurfaceSignal } from '../types.js';

export interface SemanticExtractionResult {
  readonly endpoints: CodeSurfaceSignal[];
  readonly authBoundaries: CodeSurfaceSignal[];
  readonly dataAccess: CodeSurfaceSignal[];
  readonly testTargets: CodeSurfaceSignal[];
  readonly appliedExtractors: string[];
  readonly diagnostics: string[];
}

interface SemanticCodeSurfaceExtractor {
  readonly id: string;
  readonly supportedExtensions: ReadonlySet<string>;
  readonly extract: (
    content: string,
    relPath: string,
  ) => Omit<SemanticExtractionResult, 'appliedExtractors'>;
}

type SemanticSignalBucket = 'endpoints' | 'authBoundaries' | 'dataAccess' | 'testTargets';

interface SemanticRule {
  readonly id: string;
  readonly label: string;
  readonly bucket: SemanticSignalBucket;
  readonly confidence: number;
  readonly patterns: readonly RegExp[];
}

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const JAVA_EXTENSIONS = new Set(['.java']);

const TS_JS_RULES: readonly SemanticRule[] = [
  {
    id: 'semantic-ts-route-handler',
    label: 'Semantic TS/JS route handler',
    bucket: 'endpoints',
    confidence: 0.9,
    patterns: [
      /\b(?:app|router|fastify)\.(?:get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]/,
      /\bfastify\.route\s*\(\s*\{[^}]*\b(?:method|url)\s*:/,
      /@(Controller|Get|Post|Put|Patch|Delete)\s*\(/,
    ],
  },
  {
    id: 'semantic-ts-auth-boundary',
    label: 'Semantic TS/JS auth guard or middleware',
    bucket: 'authBoundaries',
    confidence: 0.88,
    patterns: [
      /\b(?:requireAuth|authMiddleware|authenticate|authorize)\s*\(/,
      /\b(?:app|router)\.use\s*\([^)]*(?:requireAuth|authMiddleware|authenticate|authorize)/,
      /@UseGuards\s*\([^)]*(?:Auth|Jwt|Role|Guard)/,
    ],
  },
  {
    id: 'semantic-ts-data-access',
    label: 'Semantic TS/JS data access',
    bucket: 'dataAccess',
    confidence: 0.88,
    patterns: [
      /\bprisma\.[a-zA-Z0-9_]+\.(?:find|findMany|create|update|delete|upsert|aggregate)/,
      /\b(?:getRepository|Repository)<[^>]+>/,
      /\b(?:sequelize|mongoose|typeorm)\.(?:model|define|connect)/i,
    ],
  },
  {
    id: 'semantic-ts-test-target',
    label: 'Semantic TS/JS test target',
    bucket: 'testTargets',
    confidence: 0.65,
    patterns: [/\b(?:describe|it|test)\s*\(\s*['"`][^'"`]+['"`]/],
  },
];

const JAVA_RULES: readonly SemanticRule[] = [
  {
    id: 'semantic-java-spring-controller',
    label: 'Semantic Java Spring controller route',
    bucket: 'endpoints',
    confidence: 0.9,
    patterns: [
      /@(?:RestController|Controller)\b/,
      /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(/,
    ],
  },
  {
    id: 'semantic-java-auth-boundary',
    label: 'Semantic Java authorization boundary',
    bucket: 'authBoundaries',
    confidence: 0.88,
    patterns: [
      /@(?:PreAuthorize|Secured|RolesAllowed)\s*\(/,
      /\bSecurityFilterChain\b|\bOncePerRequestFilter\b/,
    ],
  },
  {
    id: 'semantic-java-data-access',
    label: 'Semantic Java data access',
    bucket: 'dataAccess',
    confidence: 0.88,
    patterns: [/@Repository\b/, /\b(?:JpaRepository|CrudRepository|JdbcTemplate)\b/],
  },
  {
    id: 'semantic-java-test-target',
    label: 'Semantic Java test target',
    bucket: 'testTargets',
    confidence: 0.65,
    patterns: [/@Test\b/, /\bclass\s+\w+Test\b/],
  },
];

const EXTRACTORS: readonly SemanticCodeSurfaceExtractor[] = [
  makeLineRuleExtractor('typescript-javascript-frameworks', TS_JS_EXTENSIONS, TS_JS_RULES),
  makeLineRuleExtractor('java-spring-frameworks', JAVA_EXTENSIONS, JAVA_RULES),
];

export function extractSemanticCodeSurfaces(
  content: string,
  relPath: string,
): SemanticExtractionResult {
  const ext = path.extname(relPath).toLowerCase();
  const matching = EXTRACTORS.filter((extractor) => extractor.supportedExtensions.has(ext));
  const aggregate = emptyResult();

  if (matching.length === 0) {
    return {
      ...aggregate,
      appliedExtractors: [],
      diagnostics: [`heuristic_only:${ext || 'unknown_extension'}`],
    };
  }

  for (const extractor of matching) {
    try {
      const extracted = extractor.extract(content, relPath);
      aggregate.endpoints.push(...extracted.endpoints);
      aggregate.authBoundaries.push(...extracted.authBoundaries);
      aggregate.dataAccess.push(...extracted.dataAccess);
      aggregate.testTargets.push(...extracted.testTargets);
      aggregate.diagnostics.push(...extracted.diagnostics);
      aggregate.appliedExtractors.push(extractor.id);
    } catch (error) {
      aggregate.diagnostics.push(
        `partial:${extractor.id}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return aggregate;
}

function makeLineRuleExtractor(
  id: string,
  supportedExtensions: ReadonlySet<string>,
  rules: readonly SemanticRule[],
): SemanticCodeSurfaceExtractor {
  return {
    id,
    supportedExtensions,
    extract(content, relPath) {
      const result = emptyResult();
      const lines = content.split('\n');
      let inBlockComment = false;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex] ?? '';
        const commentState = isCommentOnlyLine(line, inBlockComment);
        inBlockComment = commentState.inBlockComment;
        if (commentState.skip) continue;
        if (isPlainStringAssignment(line)) continue;

        const matchedBuckets = new Set<SemanticSignalBucket>();
        for (const rule of rules) {
          if (matchedBuckets.has(rule.bucket)) continue;
          if (!rule.patterns.some((pattern) => pattern.test(line))) continue;
          result[rule.bucket].push({
            id: rule.id,
            label: rule.label,
            confidence: rule.confidence,
            classification: 'derived_signal',
            evidence: [line.trim().slice(0, 140)],
            location: `${relPath}:${lineIndex + 1}`,
          });
          matchedBuckets.add(rule.bucket);
        }
      }

      return result;
    },
  };
}

function emptyResult(): SemanticExtractionResult {
  return {
    endpoints: [],
    authBoundaries: [],
    dataAccess: [],
    testTargets: [],
    appliedExtractors: [],
    diagnostics: [],
  };
}

function isCommentOnlyLine(
  line: string,
  alreadyInBlockComment: boolean,
): { readonly skip: boolean; readonly inBlockComment: boolean } {
  const trimmed = line.trim();
  if (alreadyInBlockComment) {
    return { skip: true, inBlockComment: !trimmed.includes('*/') };
  }
  if (trimmed.length === 0) return { skip: true, inBlockComment: false };
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
    return { skip: true, inBlockComment: false };
  }
  if (trimmed.startsWith('/*')) {
    return { skip: true, inBlockComment: !trimmed.includes('*/') };
  }
  if (trimmed.startsWith('*')) return { skip: true, inBlockComment: false };
  return { skip: false, inBlockComment: false };
}

function isPlainStringAssignment(line: string): boolean {
  return /^\s*(?:const|let|var)\s+\w+\s*=\s*['"`][^'"`]*['"`]\s*;?\s*$/.test(line);
}
