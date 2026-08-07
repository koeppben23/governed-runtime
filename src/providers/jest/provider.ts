/**
 * @module providers/jest/provider
 * @description Jest assertion provider extension.
 * @version v1
 */

import { parseJestJson, buildJestLocalId } from '../../verification/assertion-parsers/jest-json.js';
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

export const jestProvider: AssertionProviderExtension = {
  manifest: { providerId: 'jest' as ProviderId, label: 'Jest' },

  discovery: {
    detectionIds: ['testFramework:jest'],
    scriptSignatures: [
      { executionProfileId: 'jest-fallback', candidateKind: 'test' as const, executable: 'jest' },
    ],
    runtimeRequirements: [
      {
        id: 'jest',
        role: 'tool' as const,
        probe: { kind: 'exec' as const, command: 'node_modules/.bin/jest --version' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'jest_json' as const,
      providerId: 'jest' as const,
      outputArgumentTemplate: '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
    },
    executionProfiles: [
      {
        profileId: 'jest-fallback',
        providerId: 'jest' as const,
        format: 'jest_json' as const,
        kind: 'test' as const,
        priority: 3,
        assertionReport: {
          collection: 'run_specific' as const,
          transport: 'file' as const,
          format: 'jest_json' as const,
          providerId: 'jest' as const,
          outputArgumentTemplate: '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
          resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
        },
        createCandidate(ctx: { detectedStackIds: ReadonlySet<string>; packageManager: string }) {
          if (!ctx.detectedStackIds.has('testFramework:jest')) return null;
          const pm = ctx.packageManager;
          return {
            assertionCapability: 'structured' as const,
            kind: 'test' as const,
            command: fallbackCmd(pm, 'jest'),
            source: 'detectedStack:testFramework:jest',
            confidence: 'medium' as const,
            reason: `Jest detected; using ${pm} fallback`,
            assertionReport: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'jest_json' as const,
              providerId: 'jest' as const,
              outputArgumentTemplate:
                '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
              resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
            },
          };
        },
      },
    ],
  },

  verification: {
    formats: [
      {
        format: 'jest_json' as ReportFormatId,
        parser: {
          format: 'jest_json' as ReportFormatId,
          parse(content: string, _fileName: string, context: { providerId: string }) {
            return parseJestJson(content, context);
          },
        },
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: {
      providerId: 'jest' as ProviderId,
      assertionBindingFormats: new Set<ReportFormatId>(['jest_json']),
      buildLocalId(parsed: ParsedAssertion) {
        if (parsed.kind !== 'jest_json') throw new Error(`jest codec received ${parsed.kind}`);
        return buildJestLocalId(parsed.filePath, [...parsed.ancestorTitles], parsed.title);
      },
      validateLocalId(localId: string) {
        return JS_LOCAL_ID_RE.test(localId);
      },
    },
  },
};
