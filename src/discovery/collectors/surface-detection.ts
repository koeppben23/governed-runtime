/**
 * @module discovery/collectors/surface-detection
 * @description Collector: API, persistence, CI/CD, security surface detection.
 *
 * Detects architectural surfaces by analyzing file paths and config files:
 * - API surfaces: route files, controller directories, OpenAPI specs
 * - Persistence surfaces: ORM configs, migration directories, schema files
 * - CI/CD surfaces: GitHub Actions, GitLab CI, Jenkins, CircleCI configs
 * - Security surfaces: auth configs, CORS, CSP, secret management
 * - Layers: controller/service/repository/model directory patterns
 *
 * All detection is file-path-based (no file content reading).
 * Classification is "fact" for file existence, "derived_signal" for pattern inference.
 *
 * @version v1
 */

import type {
  CollectorInput,
  CollectorOutput,
  SurfacesInfo,
  SurfaceInfo,
  LayerInfo,
  EvidenceClass,
} from '../types.js';

// ─── Detection Rules ──────────────────────────────────────────────────────────

interface SurfaceRule {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly RegExp[];
  readonly classification: EvidenceClass;
}

const API_RULES: readonly SurfaceRule[] = [
  {
    id: 'express-routes',
    label: 'Express/Fastify routes',
    patterns: [/routes?\//i, /controllers?\//i, /api\//i],
    classification: 'derived_signal',
  },
  {
    id: 'openapi-spec',
    label: 'OpenAPI specification',
    patterns: [/openapi\.(ya?ml|json)$/i, /swagger\.(ya?ml|json)$/i],
    classification: 'fact',
  },
  {
    id: 'graphql',
    label: 'GraphQL schema',
    patterns: [/\.graphql$/i, /schema\.gql$/i, /graphql\//i],
    classification: 'fact',
  },
  {
    id: 'grpc',
    label: 'gRPC protobuf',
    patterns: [/\.proto$/i, /proto\//i],
    classification: 'fact',
  },
];

const PERSISTENCE_RULES: readonly SurfaceRule[] = [
  {
    id: 'prisma',
    label: 'Prisma ORM',
    patterns: [/prisma\/schema\.prisma$/i, /prisma\//i],
    classification: 'fact',
  },
  {
    id: 'typeorm',
    label: 'TypeORM',
    patterns: [/ormconfig/i, /entity\//i, /migration\//i],
    classification: 'derived_signal',
  },
  {
    id: 'sequelize',
    label: 'Sequelize',
    patterns: [/\.sequelizerc$/i, /seeders?\//i],
    classification: 'fact',
  },
  {
    id: 'sql-migrations',
    label: 'SQL migrations',
    patterns: [/migrations?\//i, /\.sql$/i],
    classification: 'fact',
  },
  {
    id: 'hibernate',
    label: 'Hibernate/JPA',
    patterns: [/persistence\.xml$/i, /hibernate\.cfg/i],
    classification: 'fact',
  },
];

const CICD_RULES: readonly SurfaceRule[] = [
  {
    id: 'github-actions',
    label: 'GitHub Actions',
    patterns: [/\.github\/workflows\//i],
    classification: 'fact',
  },
  {
    id: 'gitlab-ci',
    label: 'GitLab CI',
    patterns: [/\.gitlab-ci\.ya?ml$/i],
    classification: 'fact',
  },
  {
    id: 'jenkins',
    label: 'Jenkins',
    patterns: [/Jenkinsfile$/i, /jenkins\//i],
    classification: 'fact',
  },
  {
    id: 'circleci',
    label: 'CircleCI',
    patterns: [/\.circleci\//i],
    classification: 'fact',
  },
  {
    id: 'azure-pipelines',
    label: 'Azure Pipelines',
    patterns: [/azure-pipelines\.ya?ml$/i],
    classification: 'fact',
  },
];

const SECURITY_RULES: readonly SurfaceRule[] = [
  {
    id: 'auth-config',
    label: 'Authentication config',
    patterns: [/auth\//i, /passport/i, /oauth/i, /jwt/i],
    classification: 'derived_signal',
  },
  {
    id: 'security-headers',
    label: 'Security headers / CSP',
    patterns: [/csp/i, /helmet/i, /security\.config/i],
    classification: 'derived_signal',
  },
  {
    id: 'secret-management',
    label: 'Secret management',
    patterns: [/\.env\.example$/i, /vault/i, /secrets?\//i],
    classification: 'derived_signal',
  },
];

/** Architectural layer detection patterns. */
const LAYER_PATTERNS: ReadonlyArray<{
  name: string;
  patterns: string[];
}> = [
  { name: 'controller', patterns: ['controllers/', 'controller/'] },
  { name: 'service', patterns: ['services/', 'service/'] },
  { name: 'repository', patterns: ['repositories/', 'repository/', 'repos/'] },
  { name: 'model', patterns: ['models/', 'model/', 'entities/', 'entity/'] },
  { name: 'middleware', patterns: ['middleware/', 'middlewares/'] },
  { name: 'util', patterns: ['utils/', 'util/', 'helpers/', 'lib/'] },
];

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect surface information from repository file paths.
 *
 * Scans all file paths against pattern rules to detect architectural surfaces.
 * Each surface is reported with evidence (matching file paths).
 */
export async function collectSurfaces(
  input: CollectorInput,
): Promise<CollectorOutput<SurfacesInfo>> {
  try {
    const normalized = input.allFiles.map((f) => f.replace(/\\/g, '/'));

    const api = detectSurfaces(normalized, API_RULES);
    const persistence = detectSurfaces(normalized, PERSISTENCE_RULES);
    const cicd = detectSurfaces(normalized, CICD_RULES);
    const security = detectSurfaces(normalized, SECURITY_RULES);
    const layers = detectLayers(normalized);

    return {
      status: 'complete',
      data: { api, persistence, cicd, security, layers },
    };
  } catch {
    return {
      status: 'failed',
      data: { api: [], persistence: [], cicd: [], security: [], layers: [] },
    };
  }
}

// ─── Internal Detection Functions ─────────────────────────────────────────────

/**
 * Detect surfaces by matching file paths against rules.
 * Returns one SurfaceInfo per rule that has at least one match.
 */
function detectSurfaces(files: readonly string[], rules: readonly SurfaceRule[]): SurfaceInfo[] {
  const surfaces: SurfaceInfo[] = [];

  for (const rule of rules) {
    const evidence: string[] = [];

    for (const filePath of files) {
      if (rule.patterns.some((p) => p.test(filePath))) {
        // Keep max 5 evidence paths per surface
        if (evidence.length < 5) evidence.push(filePath);
        // Early exit if we have enough evidence
        if (evidence.length >= 5) break;
      }
    }

    if (evidence.length > 0) {
      surfaces.push({
        id: rule.id,
        label: rule.label,
        classification: rule.classification,
        evidence,
      });
    }
  }

  return surfaces;
}

/**
 * Detect architectural layers by checking for known directory patterns.
 */
function detectLayers(files: readonly string[]): LayerInfo[] {
  const layers: LayerInfo[] = [];

  for (const layer of LAYER_PATTERNS) {
    const hasMatch = files.some((f) => layer.patterns.some((p) => f.includes(p)));
    if (hasMatch) {
      layers.push({
        name: layer.name,
        pathPatterns: [...layer.patterns],
      });
    }
  }

  return layers;
}
