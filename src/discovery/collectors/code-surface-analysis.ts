/**
 * @module discovery/collectors/code-surface-analysis
 * @description Bounded heuristic code-surface analysis.
 *
 * Reads a limited set of candidate source files and extracts semantically useful
 * signals (endpoints, auth boundaries, data access, external integrations).
 *
 * This collector is heuristic and confidence-based. It is not semantic truth.
 *
 * Scanning strategy:
 * - Filters allFiles to source-extension candidates only
 * - Ranks candidates by keyword-based priority: routes/controllers first,
 *   then auth/security, persistence/data, config/entry/integration,
 *   framework/IOC, then unmatched. Within each tier, shallow files first, then
 *   alphabetical. Ranking is deterministic across platforms and separators.
 * - Takes first MAX_FILES from ranked candidates
 * - Reports `partial` based on source-candidate budget exhaustion, NOT total repo file count
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CollectorInput,
  CollectorOutput,
  CodeSurfaceSignal,
  CodeSurfacesInfo,
  EvidenceClass,
  ReadOutcome,
} from '../types.js';
import { extractSemanticCodeSurfaces } from './code-surface-semantic-extractors.js';

const MAX_FILES = 200;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 2_500;

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.go',
  '.py',
  '.rb',
  '.cs',
]);

// ─── Prioritization ───────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, number> = {
  route: 5,
  routes: 5,
  controller: 5,
  controllers: 5,
  handler: 5,
  handlers: 5,
  endpoint: 5,
  endpoints: 5,
  api: 5,
  router: 5,
  auth: 4,
  guard: 4,
  guards: 4,
  middleware: 4,
  middlewares: 4,
  protect: 4,
  security: 4,
  session: 4,
  token: 4,
  repository: 3,
  repositories: 3,
  model: 3,
  models: 3,
  schema: 3,
  schemas: 3,
  entity: 3,
  entities: 3,
  dao: 3,
  store: 3,
  database: 3,
  prisma: 3,
  migration: 3,
  migrations: 3,
  seed: 3,
  config: 2,
  configs: 2,
  setup: 2,
  main: 2,
  index: 2,
  server: 2,
  app: 2,
  bootstrap: 2,
  client: 2,
  clients: 2,
  adapter: 2,
  adapters: 2,
  gateway: 2,
  gateways: 2,
  service: 1,
  services: 1,
  provider: 1,
  providers: 1,
  module: 1,
  modules: 1,
  factory: 1,
  factories: 1,
  decorator: 1,
  interceptor: 1,
  interceptors: 1,
  filter: 1,
  pipe: 1,
  pipes: 1,
  resolver: 1,
  resolvers: 1,
};

function computePriority(filePath: string): number {
  const normalized = filePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? normalized;
  const stem = basename.replace(/\.[^.]+$/, '').toLowerCase();

  const seen = new Set<string>();
  let score = 0;

  function addWeight(key: string) {
    const w = CATEGORY_KEYWORDS[key];
    if (w !== undefined && !seen.has(key)) {
      seen.add(key);
      score += w;
    }
  }

  addWeight(stem);

  for (const seg of segments) {
    const segStem = seg.replace(/\.[^.]+$/, '').toLowerCase();
    addWeight(segStem);
  }

  return score;
}

function precomputePriorities(candidates: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of candidates) {
    map.set(f, computePriority(f));
  }
  return map;
}

interface Rule {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  readonly classification: EvidenceClass;
  readonly patterns: readonly RegExp[];
}

const ENDPOINT_RULES: readonly Rule[] = [
  {
    id: 'http-endpoint',
    label: 'HTTP route handler',
    confidence: 0.85,
    classification: 'derived_signal',
    patterns: [
      /\b(?:app|router|fastify)\.(?:get|post|put|patch|delete|route)\s*\(/,
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\b/,
    ],
  },
  {
    id: 'graphql-endpoint',
    label: 'GraphQL endpoint',
    confidence: 0.8,
    classification: 'derived_signal',
    patterns: [/\bgraphql\s*\(/, /\bApolloServer\b/, /type\s+Query\s*\{/],
  },
];

const AUTH_RULES: readonly Rule[] = [
  {
    id: 'auth-boundary',
    label: 'Authentication/Authorization boundary',
    confidence: 0.8,
    classification: 'derived_signal',
    patterns: [
      /\b(authenticate|authorize|authMiddleware|requireAuth)\b/,
      /\bpassport\b|\bjwt\b|\boauth\b/i,
      /@(PreAuthorize|RolesAllowed|Secured)\b/,
    ],
  },
];

const DATA_RULES: readonly Rule[] = [
  {
    id: 'data-access',
    label: 'Data access boundary',
    confidence: 0.8,
    classification: 'derived_signal',
    patterns: [
      /\bprisma\.[a-z]+\b/i,
      /\b(sequelize|typeorm|mongoose)\b/i,
      /\bRepository<[^>]+>/,
      /\bSELECT\s+.+\s+FROM\b/i,
      /\b(jdbc|sqlx|knex)\b/i,
    ],
  },
];

const INTEGRATION_RULES: readonly Rule[] = [
  {
    id: 'external-integration',
    label: 'External system integration',
    confidence: 0.75,
    classification: 'derived_signal',
    patterns: [
      /\b(axios|fetch|HttpClient)\s*\(/,
      /\b(kafka|rabbitmq|sqs|pubsub|nats)\b/i,
      /\b(redis|grpc|websocket|amqp)\b/i,
    ],
  },
];

export async function collectCodeSurfaces(
  input: CollectorInput,
): Promise<CollectorOutput<CodeSurfacesInfo>> {
  try {
    const result = await withTimeout(runCollector(input), TIMEOUT_MS);
    return {
      status: result.status === 'ok' ? 'complete' : result.status,
      data: result,
    };
  } catch {
    return {
      status: 'failed',
      data: {
        status: 'failed',
        endpoints: [],
        authBoundaries: [],
        dataAccess: [],
        integrations: [],
        testTargets: [],
        budget: {
          scannedFiles: 0,
          scannedBytes: 0,
          maxFiles: MAX_FILES,
          maxBytesPerFile: MAX_BYTES_PER_FILE,
          maxTotalBytes: MAX_TOTAL_BYTES,
          timedOut: true,
        },
        semanticExtraction: {
          status: 'partial',
          appliedExtractors: [],
          unsupportedReason: 'Code-surface collector failed before semantic extraction completed.',
          diagnostics: ['semantic_extraction_not_completed'],
        },
      },
    };
  }
}

async function runCollector(input: CollectorInput): Promise<CodeSurfacesInfo> {
  // Filter to source-extension candidates only, then sort deterministically
  const allSourceCandidates = input.allFiles.filter((f) =>
    SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );

  const totalSourceCandidates = allSourceCandidates.length;

  // Deterministic ranking: priority score (higher first), then depth, then alphabetical
  const priorities = precomputePriorities(allSourceCandidates);
  const sorted = [...allSourceCandidates].sort((a, b) => {
    const pA = priorities.get(a) ?? 0;
    const pB = priorities.get(b) ?? 0;
    if (pA !== pB) return pB - pA;
    const depthA = a.split(/[/\\]/).length;
    const depthB = b.split(/[/\\]/).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  // Budget: partial if source candidates exceed MAX_FILES
  const budgetExhausted = totalSourceCandidates > MAX_FILES;
  const candidates = sorted.slice(0, MAX_FILES);

  const endpoints: CodeSurfaceSignal[] = [];
  const authBoundaries: CodeSurfaceSignal[] = [];
  const dataAccess: CodeSurfaceSignal[] = [];
  const integrations: CodeSurfaceSignal[] = [];
  const testTargets: CodeSurfaceSignal[] = [];
  const readStatuses: Record<string, ReadOutcome> = {};
  const semanticAppliedExtractors = new Set<string>();
  const semanticDiagnostics: string[] = [];
  let semanticPartial = false;

  let scannedFiles = 0;
  let scannedBytes = 0;
  let degraded = budgetExhausted;

  for (const relPath of candidates) {
    if (scannedBytes >= MAX_TOTAL_BYTES) {
      degraded = true;
      break;
    }

    const fullPath = path.join(input.worktreePath, relPath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') {
        readStatuses[relPath] = 'denied';
      } else {
        readStatuses[relPath] = 'not_found';
      }
      degraded = true;
      continue;
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES_PER_FILE) {
      readStatuses[relPath] = 'too_large';
      degraded = true;
      content = content.slice(0, MAX_BYTES_PER_FILE);
    }

    const consumed = Buffer.byteLength(content, 'utf-8');
    if (scannedBytes + consumed > MAX_TOTAL_BYTES) {
      degraded = true;
      break;
    }

    scannedBytes += consumed;
    scannedFiles += 1;
    readStatuses[relPath] = 'read_ok';

    detectSignals(content, relPath, ENDPOINT_RULES, endpoints);
    detectSignals(content, relPath, AUTH_RULES, authBoundaries);
    detectSignals(content, relPath, DATA_RULES, dataAccess);
    detectSignals(content, relPath, INTEGRATION_RULES, integrations);

    const semantic = extractSemanticCodeSurfaces(content, relPath);
    addUniqueSignals(endpoints, semantic.endpoints);
    addUniqueSignals(authBoundaries, semantic.authBoundaries);
    addUniqueSignals(dataAccess, semantic.dataAccess);
    addUniqueSignals(testTargets, semantic.testTargets);
    for (const extractor of semantic.appliedExtractors) semanticAppliedExtractors.add(extractor);
    for (const diagnostic of semantic.diagnostics) {
      if (diagnostic.startsWith('partial:')) semanticPartial = true;
      semanticDiagnostics.push(`${relPath}:${diagnostic}`);
    }
  }

  // Only include readStatuses if there were non-ok outcomes
  const hasNonOkReads = Object.values(readStatuses).some((s) => s !== 'read_ok');

  return {
    status: degraded ? 'partial' : 'ok',
    endpoints,
    authBoundaries,
    dataAccess,
    integrations,
    testTargets,
    budget: {
      scannedFiles,
      scannedBytes,
      maxFiles: MAX_FILES,
      maxBytesPerFile: MAX_BYTES_PER_FILE,
      maxTotalBytes: MAX_TOTAL_BYTES,
      timedOut: false,
      totalSourceCandidates,
      budgetExhausted,
    },
    semanticExtraction: {
      status: semanticPartial
        ? 'partial'
        : semanticAppliedExtractors.size > 0
          ? 'applied'
          : 'heuristic_only',
      appliedExtractors: [...semanticAppliedExtractors].sort(),
      unsupportedReason:
        semanticAppliedExtractors.size === 0
          ? 'No semantic extractor matched scanned source files; heuristic code-surface rules were used.'
          : null,
      diagnostics: semanticDiagnostics.slice(0, 24),
    },
    ...(hasNonOkReads ? { readStatuses } : {}),
  };
}

function addUniqueSignals(
  target: CodeSurfaceSignal[],
  additions: readonly CodeSurfaceSignal[],
): void {
  const seen = new Set(target.map(signalKey));
  for (const signal of additions) {
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(signal);
  }
}

function signalKey(signal: CodeSurfaceSignal): string {
  return `${signal.id}:${signal.location}:${signal.evidence.join('\u001f')}`;
}

function detectSignals(
  content: string,
  relPath: string,
  rules: readonly Rule[],
  out: CodeSurfaceSignal[],
): void {
  const lines = content.split('\n');
  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!rule.patterns.some((r) => r.test(line))) continue;
      out.push({
        id: rule.id,
        label: rule.label,
        confidence: rule.confidence,
        classification: rule.classification,
        evidence: [line.trim().slice(0, 140)],
        location: `${relPath}:${i + 1}`,
      });
      break;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
