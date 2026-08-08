/**
 * @module providers/vitest/provider
 * @description Vitest assertion provider extension.
 * @version v1
 */

import {
  parseVitestJson,
  buildVitestLocalId,
} from '../../verification/assertion-parsers/vitest-json.js';
import { junitXmlParser } from '../../verification/assertion-parsers/parsers.js';
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
    scriptSignatures: [
      {
        executionProfileId: 'vitest-fallback',
        candidateKind: 'test' as const,
        executable: 'vitest',
      },
    ],
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
        assertionReport: {
          collection: 'run_specific' as const,
          transport: 'file' as const,
          format: 'vitest_json' as const,
          providerId: 'vitest' as const,
          outputArgumentTemplate:
            '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
          resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
        },
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
      {
        profileId: 'vitest-junit-aggregate',
        providerId: 'vitest' as const,
        format: 'junit_xml' as const,
        kind: 'test' as const,
        priority: 3,
        alternate: true,
        assertionReport: {
          collection: 'run_specific' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'vitest' as const,
          outputArgumentTemplate:
            '--reporter=junit --outputFile=.flowguard/reports/{attemptId}/vitest.junit.xml',
          resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.junit.xml',
        },
        attestFullCheckScope(command: string) {
          return /\bvitest\s+run\s*$/.test(command.trim());
        },
        createCandidate(ctx: { detectedStackIds: ReadonlySet<string>; packageManager: string }) {
          if (!ctx.detectedStackIds.has('testFramework:vitest')) return null;
          return {
            assertionCapability: 'structured' as const,
            kind: 'test' as const,
            command: fallbackCmd(ctx.packageManager, 'vitest run'),
            source: 'detectedStack:testFramework:vitest:aggregate',
            confidence: 'medium' as const,
            reason: 'Vitest JUnit aggregate suite evidence',
            assertionReport: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'junit_xml' as const,
              providerId: 'vitest' as const,
              outputArgumentTemplate:
                '--reporter=junit --outputFile=.flowguard/reports/{attemptId}/vitest.junit.xml',
              resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.junit.xml',
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
      {
        format: 'junit_xml' as ReportFormatId,
        parser: junitXmlParser,
        bindingCapability: 'aggregate' as const,
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
