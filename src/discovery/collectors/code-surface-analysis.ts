/**
 * @module discovery/collectors/code-surface-analysis
 * @description Bounded heuristic code-surface analysis.
 *
 * Reads a limited set of candidate source files and extracts semantically useful
 * signals (endpoints, auth boundaries, data access, external integrations).
 *
 * This collector is heuristic and confidence-based. It is not semantic truth.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CollectorInput,
  CollectorOutput,
  CodeSurfaceSignal,
  CodeSurfacesInfo,
  EvidenceClass,
} from '../types';

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
        budget: {
          scannedFiles: 0,
          scannedBytes: 0,
          maxFiles: MAX_FILES,
          maxBytesPerFile: MAX_BYTES_PER_FILE,
          maxTotalBytes: MAX_TOTAL_BYTES,
          timedOut: true,
        },
      },
    };
  }
}

async function runCollector(input: CollectorInput): Promise<CodeSurfacesInfo> {
  const candidates = input.allFiles
    .filter((f) => SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .slice(0, MAX_FILES);

  const endpoints: CodeSurfaceSignal[] = [];
  const authBoundaries: CodeSurfaceSignal[] = [];
  const dataAccess: CodeSurfaceSignal[] = [];
  const integrations: CodeSurfaceSignal[] = [];

  let scannedFiles = 0;
  let scannedBytes = 0;
  let degraded = input.allFiles.length > MAX_FILES;

  for (const relPath of candidates) {
    if (scannedBytes >= MAX_TOTAL_BYTES) {
      degraded = true;
      break;
    }

    const fullPath = path.join(input.worktreePath, relPath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      degraded = true;
      continue;
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES_PER_FILE) {
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

    detectSignals(content, relPath, ENDPOINT_RULES, endpoints);
    detectSignals(content, relPath, AUTH_RULES, authBoundaries);
    detectSignals(content, relPath, DATA_RULES, dataAccess);
    detectSignals(content, relPath, INTEGRATION_RULES, integrations);
  }

  return {
    status: degraded ? 'partial' : 'ok',
    endpoints,
    authBoundaries,
    dataAccess,
    integrations,
    budget: {
      scannedFiles,
      scannedBytes,
      maxFiles: MAX_FILES,
      maxBytesPerFile: MAX_BYTES_PER_FILE,
      maxTotalBytes: MAX_TOTAL_BYTES,
      timedOut: false,
    },
  };
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
