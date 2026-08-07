/**
 * @module providers/vitest/provider
 * @description Vitest assertion provider extension.
 * @version v1
 */

import {
  parseVitestJson,
  buildVitestLocalId,
} from '../../verification/assertion-parsers/vitest-json.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

const JS_LOCAL_ID_RE = /^[^:]+(::[^:]+)+$/;

function fallbackCmd(pm: string, cmd: string): string {
  if (pm === 'pnpm') return `pnpm ${cmd}`;
  if (pm === 'yarn') return `yarn ${cmd}`;
  if (pm === 'bun') return `bunx ${cmd}`;
  return `npx ${cmd}`;
}

export const vitestProvider: AssertionProviderExtension = {
  manifest: { providerId: 'vitest' as ProviderId, label: 'Vitest' },

  discovery: {
    detectionIds: ['testFramework:vitest'],
    scriptSignatures: [{ executable: 'vitest' }],
    runtimeRequirements: [
      {
        id: 'vitest',
        role: 'tool' as const,
        probe: { kind: 'exec' as const, command: 'node_modules/.bin/vitest --version' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'vitest_json' as const,
      providerId: 'vitest' as const,
      outputArgumentTemplate:
        '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
    },
    executionProfiles: [
      {
        profileId: 'vitest-fallback',
        providerId: 'vitest' as const,
        format: 'vitest_json' as const,
        kind: 'test' as const,
        priority: 2,
        createCandidate(ctx: { detectedStackIds: ReadonlySet<string>; packageManager: string }) {
          if (!ctx.detectedStackIds.has('testFramework:vitest')) return null;
          const pm = ctx.packageManager;
          return {
            assertionCapability: 'structured' as const,
            kind: 'test' as const,
            command: fallbackCmd(pm, 'vitest run'),
            source: 'detectedStack:testFramework:vitest',
            confidence: 'medium' as const,
            reason: `Vitest detected; using ${pm} fallback`,
            assertionReport: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'vitest_json' as const,
              providerId: 'vitest' as const,
              outputArgumentTemplate:
                '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
              resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
            },
          };
        },
      },
    ],
  },

  verification: {
    formats: [
      {
        format: 'vitest_json' as ReportFormatId,
        parser: {
          format: 'vitest_json' as ReportFormatId,
          parse(content: string, _fileName: string, context: { providerId: string }) {
            return parseVitestJson(content, context);
          },
        },
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: {
      providerId: 'vitest' as ProviderId,
      assertionBindingFormats: new Set<ReportFormatId>(['vitest_json']),
      buildLocalId(parsed: ParsedAssertion) {
        if (parsed.kind !== 'vitest_json') throw new Error(`vitest codec received ${parsed.kind}`);
        return buildVitestLocalId(parsed.filePath, [...parsed.ancestorTitles], parsed.title);
      },
      validateLocalId(localId: string) {
        return JS_LOCAL_ID_RE.test(localId);
      },
    },
  },
};
