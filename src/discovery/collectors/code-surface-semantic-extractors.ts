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
  makeJavaSpringExtractor(),
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

function makeJavaSpringExtractor(): SemanticCodeSurfaceExtractor {
  const nonEndpointExtractor = makeLineRuleExtractor(
    'java-spring-non-endpoint-signals',
    JAVA_EXTENSIONS,
    JAVA_RULES,
  );

  return {
    id: 'java-spring-frameworks',
    supportedExtensions: JAVA_EXTENSIONS,
    extract(content, relPath) {
      const result = nonEndpointExtractor.extract(content, relPath);
      result.endpoints.push(...extractJavaSpringRouteHandlers(content, relPath));
      return result;
    },
  };
}

const JAVA_MAPPING_ANNOTATION =
  /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/;
const JAVA_TYPE_DECLARATION = /\b(?:class|interface|enum|record)\b/;
const JAVA_ANNOTATION = /^@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/;
const JAVA_METHOD_DECLARATION =
  /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^{}()]+>\s*)?(?:[A-Za-z_$][\w$.]*(?:\s*<[^{}()]+>)?(?:\s*\[\])?\s+)+[A-Za-z_$][\w$]*\s*\(/;

interface JavaSourcePosition {
  readonly lineIndex: number;
  readonly columnIndex: number;
}

/**
 * A mapping annotation represents a route only when its next declaration is a
 * method. Class-level RequestMapping annotations supply a path prefix instead.
 */
function extractJavaSpringRouteHandlers(content: string, relPath: string): CodeSurfaceSignal[] {
  const lines = content.split('\n');
  const endpoints: CodeSurfaceSignal[] = [];
  const mappedDeclarations = new Set<number>();
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const commentState = isCommentOnlyLine(line, inBlockComment);
    inBlockComment = commentState.inBlockComment;
    if (commentState.skip) continue;
    const annotationColumn = findJavaMappingAnnotation(line);
    if (annotationColumn === null) continue;

    const annotationEnd = consumeJavaAnnotation(lines, {
      lineIndex,
      columnIndex: annotationColumn,
    });
    if (annotationEnd === null) continue;

    const declaration = findJavaAnnotatedDeclaration(lines, annotationEnd);
    if (declaration === null || mappedDeclarations.has(declaration)) continue;
    mappedDeclarations.add(declaration);

    endpoints.push({
      id: 'semantic-java-spring-controller',
      label: 'Semantic Java Spring route handler',
      confidence: 0.9,
      classification: 'derived_signal',
      evidence: [line.trim().slice(0, 140)],
      location: `${relPath}:${lineIndex + 1}`,
    });
  }

  return endpoints;
}

function findJavaMappingAnnotation(line: string): number | null {
  let quote: '"' | "'" | null = null;
  let inBlockComment = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index] ?? '';
    if (inBlockComment) {
      if (character === '*' && line[index + 1] === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (quote !== null) {
      if (character === '\\') {
        index++;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '/' && line[index + 1] === '/') break;
    if (character === '/' && line[index + 1] === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    if (character === '@' && JAVA_MAPPING_ANNOTATION.test(line.slice(index))) return index;
  }
  return null;
}

function consumeJavaAnnotation(
  lines: readonly string[],
  start: JavaSourcePosition,
): JavaSourcePosition | null {
  const line = lines[start.lineIndex] ?? '';
  const annotation = JAVA_ANNOTATION.exec(line.slice(start.columnIndex));
  if (annotation === null) return null;

  let lineIndex = start.lineIndex;
  let columnIndex = start.columnIndex + annotation[0].length;
  while (/\s/.test((lines[lineIndex] ?? '')[columnIndex] ?? '')) columnIndex++;
  if ((lines[lineIndex] ?? '')[columnIndex] !== '(') return { lineIndex, columnIndex };

  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (; lineIndex < lines.length; lineIndex++) {
    const currentLine = lines[lineIndex] ?? '';
    for (; columnIndex < currentLine.length; columnIndex++) {
      const character = currentLine[columnIndex] ?? '';
      if (quote !== null) {
        if (character === '\\') {
          columnIndex++;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '(') {
        depth++;
      } else if (character === ')' && --depth === 0) {
        return { lineIndex, columnIndex: columnIndex + 1 };
      }
    }
    columnIndex = 0;
  }
  return null;
}

function findJavaAnnotatedDeclaration(
  lines: readonly string[],
  start: JavaSourcePosition,
): number | null {
  let inBlockComment = false;

  for (let position = start; position.lineIndex < lines.length;) {
    const line = lines[position.lineIndex] ?? '';
    const remainder = line.slice(position.columnIndex);
    const trimmed = remainder.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      position = { lineIndex: position.lineIndex + 1, columnIndex: 0 };
      continue;
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = !trimmed.includes('*/');
      position = { lineIndex: position.lineIndex + 1, columnIndex: 0 };
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      position = { lineIndex: position.lineIndex + 1, columnIndex: 0 };
      continue;
    }
    if (trimmed.startsWith('@')) {
      const annotationEnd = consumeJavaAnnotation(lines, {
        lineIndex: position.lineIndex,
        columnIndex: position.columnIndex + remainder.indexOf(trimmed),
      });
      if (annotationEnd === null) return null;
      position = annotationEnd;
      continue;
    }
    if (JAVA_TYPE_DECLARATION.test(trimmed)) return null;
    if (JAVA_METHOD_DECLARATION.test(trimmed)) return position.lineIndex;
    if (trimmed.includes(';') || trimmed.includes('{')) return null;
    position = { lineIndex: position.lineIndex + 1, columnIndex: 0 };
  }
  return null;
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
