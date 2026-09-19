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
import { DiscoveryError } from '../errors.js';

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
    patterns: [/\b(?:app|router|fastify)\.(?:get|post|put|patch|delete|route)\s*\(/],
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

interface CandidateContent {
  readonly kind: 'content';
  readonly content: string;
  readonly outcome: Extract<ReadOutcome, 'read_ok' | 'too_large'>;
}

interface CandidateUnreadable {
  readonly kind: 'unreadable';
  readonly outcome: Extract<ReadOutcome, 'denied' | 'not_found'>;
}

type CandidateRead = CandidateContent | CandidateUnreadable;

function readErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String(err.code);
  }
  return '';
}

async function readSourceCandidate(fullPath: string): Promise<CandidateRead> {
  let content: string;
  try {
    content = await fs.readFile(fullPath, 'utf-8');
  } catch (err: unknown) {
    const code = readErrorCode(err);
    const outcome = code === 'EACCES' || code === 'EPERM' ? 'denied' : 'not_found';
    return { kind: 'unreadable', outcome };
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES_PER_FILE) {
    return { kind: 'content', content: content.slice(0, MAX_BYTES_PER_FILE), outcome: 'too_large' };
  }
  return { kind: 'content', content, outcome: 'read_ok' };
}

interface CodeSurfaceRunState {
  readonly endpoints: CodeSurfaceSignal[];
  readonly authBoundaries: CodeSurfaceSignal[];
  readonly dataAccess: CodeSurfaceSignal[];
  readonly integrations: CodeSurfaceSignal[];
  readonly testTargets: CodeSurfaceSignal[];
  readonly readStatuses: Record<string, ReadOutcome>;
  readonly semanticAppliedExtractors: Set<string>;
  readonly semanticDiagnostics: string[];
  semanticPartial: boolean;
  scannedFiles: number;
  scannedBytes: number;
  degraded: boolean;
}

function createCodeSurfaceRunState(degraded: boolean): CodeSurfaceRunState {
  return {
    endpoints: [],
    authBoundaries: [],
    dataAccess: [],
    integrations: [],
    testTargets: [],
    readStatuses: {},
    semanticAppliedExtractors: new Set<string>(),
    semanticDiagnostics: [],
    semanticPartial: false,
    scannedFiles: 0,
    scannedBytes: 0,
    degraded,
  };
}

function compareSourceCandidates(
  a: string,
  b: string,
  priorities: ReadonlyMap<string, number>,
): number {
  const pA = priorities.get(a) ?? 0;
  const pB = priorities.get(b) ?? 0;
  if (pA !== pB) return pB - pA;
  const depthA = a.split(/[/\\]/).length;
  const depthB = b.split(/[/\\]/).length;
  if (depthA !== depthB) return depthA - depthB;
  return a.localeCompare(b);
}

function collectSignalsFromFile(
  content: string,
  relPath: string,
  state: CodeSurfaceRunState,
): void {
  detectSignals(content, relPath, ENDPOINT_RULES, state.endpoints);
  detectSignals(content, relPath, AUTH_RULES, state.authBoundaries);
  detectSignals(content, relPath, DATA_RULES, state.dataAccess);
  detectSignals(content, relPath, INTEGRATION_RULES, state.integrations);

  const semantic = extractSemanticCodeSurfaces(content, relPath);
  addUniqueSignals(state.endpoints, semantic.endpoints);
  addUniqueSignals(state.authBoundaries, semantic.authBoundaries);
  addUniqueSignals(state.dataAccess, semantic.dataAccess);
  addUniqueSignals(state.testTargets, semantic.testTargets);
  for (const extractor of semantic.appliedExtractors)
    state.semanticAppliedExtractors.add(extractor);
  for (const diagnostic of semantic.diagnostics) {
    if (diagnostic.startsWith('partial:')) state.semanticPartial = true;
    state.semanticDiagnostics.push(`${relPath}:${diagnostic}`);
  }
}

function buildCodeSurfacesInfo(
  state: CodeSurfaceRunState,
  budgetExhausted: boolean,
  totalSourceCandidates: number,
): CodeSurfacesInfo {
  // Only include readStatuses if there were non-ok outcomes
  const hasNonOkReads = Object.values(state.readStatuses).some((s) => s !== 'read_ok');

  return {
    status: state.degraded ? 'partial' : 'ok',
    endpoints: state.endpoints,
    authBoundaries: state.authBoundaries,
    dataAccess: state.dataAccess,
    integrations: state.integrations,
    testTargets: state.testTargets,
    budget: {
      scannedFiles: state.scannedFiles,
      scannedBytes: state.scannedBytes,
      maxFiles: MAX_FILES,
      maxBytesPerFile: MAX_BYTES_PER_FILE,
      maxTotalBytes: MAX_TOTAL_BYTES,
      timedOut: false,
      totalSourceCandidates,
      budgetExhausted,
    },
    semanticExtraction: {
      status: state.semanticPartial
        ? 'partial'
        : state.semanticAppliedExtractors.size > 0
          ? 'applied'
          : 'heuristic_only',
      appliedExtractors: [...state.semanticAppliedExtractors].sort(),
      unsupportedReason:
        state.semanticAppliedExtractors.size === 0
          ? 'No semantic extractor matched scanned source files; heuristic code-surface rules were used.'
          : null,
      diagnostics: state.semanticDiagnostics.slice(0, 24),
    },
    ...(hasNonOkReads ? { readStatuses: state.readStatuses } : {}),
  };
}

async function runCollector(input: CollectorInput): Promise<CodeSurfacesInfo> {
  // Filter to source-extension candidates only, then sort deterministically
  const allSourceCandidates = input.allFiles.filter((f) =>
    SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );

  const totalSourceCandidates = allSourceCandidates.length;

  // Deterministic ranking: priority score (higher first), then depth, then alphabetical
  const priorities = precomputePriorities(allSourceCandidates);
  const sorted = [...allSourceCandidates].sort((a, b) => compareSourceCandidates(a, b, priorities));

  // Budget: partial if source candidates exceed MAX_FILES
  const budgetExhausted = totalSourceCandidates > MAX_FILES;
  const candidates = sorted.slice(0, MAX_FILES);

  const state = createCodeSurfaceRunState(budgetExhausted);

  for (const relPath of candidates) {
    if (state.scannedBytes >= MAX_TOTAL_BYTES) {
      state.degraded = true;
      break;
    }

    const read = await readSourceCandidate(path.join(input.worktreePath, relPath));
    if (read.kind === 'unreadable') {
      state.readStatuses[relPath] = read.outcome;
      state.degraded = true;
      continue;
    }

    if (read.outcome === 'too_large') {
      state.readStatuses[relPath] = 'too_large';
      state.degraded = true;
    }

    const consumed = Buffer.byteLength(read.content, 'utf-8');
    if (state.scannedBytes + consumed > MAX_TOTAL_BYTES) {
      state.degraded = true;
      break;
    }

    state.scannedBytes += consumed;
    state.scannedFiles += 1;
    state.readStatuses[relPath] = 'read_ok';

    collectSignalsFromFile(read.content, relPath, state);
  }

  return buildCodeSurfacesInfo(state, budgetExhausted, totalSourceCandidates);
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
    const timer = setTimeout(
      () => reject(new DiscoveryError('DISCOVERY_CODE_SURFACE_TIMEOUT', `Timed out after ${ms}ms`)),
      ms,
    );
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
