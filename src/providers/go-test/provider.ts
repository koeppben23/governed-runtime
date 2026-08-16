/**
 * @module providers/go-test/provider
 * @description Go test assertion provider extension.
 * @version v1
 */

import {
  parseGoTestJson,
  buildGoLocalId,
} from '../../verification/assertion-parsers/go-test-json.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

const GO_LOCAL_ID_RE = /^[^:]+::[^:]+$/;

export const goTestProvider: AssertionProviderExtension = {
  manifest: { providerId: 'go_test' as ProviderId, label: 'Go test' },

  discovery: {
    detectionIds: ['testFramework:go_test', 'language:go'],
    scriptSignatures: [
      {
        executionProfileId: 'go-test-stdout',
        candidateKind: 'test' as const,
        executable: 'go',
        requiredArgsPrefix: ['test'],
      },
    ],
    runtimeRequirements: [
      { id: 'go', role: 'tool' as const, probe: { kind: 'exec' as const, command: 'go version' } },
    ],
    assertionReportTemplate: {
      collection: 'stdout' as const,
      transport: 'stdout' as const,
      format: 'go_test_json' as const,
      providerId: 'go_test' as const,
    },
    executionProfiles: [
      {
        profileId: 'go-test-stdout',
        providerId: 'go_test' as const,
        format: 'go_test_json' as const,
        kind: 'test' as const,
        priority: 5,
        assertionReport: {
          collection: 'stdout' as const,
          transport: 'stdout' as const,
          format: 'go_test_json' as const,
          providerId: 'go_test' as const,
        },
        createCandidate(ctx: { detectedStackIds: ReadonlySet<string> }) {
          if (!ctx.detectedStackIds.has('testFramework:go_test')) return null;
          return {
            assertionCapability: 'structured' as const,
            kind: 'test' as const,
            command: 'go test -json ./...',
            source: 'detectedStack:testFramework:go_test',
            confidence: 'medium' as const,
            reason: 'Go toolchain detected; using go test -json',
            assertionReport: {
              collection: 'stdout' as const,
              transport: 'stdout' as const,
              format: 'go_test_json' as const,
              providerId: 'go_test' as const,
            },
          };
        },
      },
    ],
  },

  verification: {
    formats: [
      {
        format: 'go_test_json' as ReportFormatId,
        parser: {
          format: 'go_test_json' as ReportFormatId,
          parse(content: string, _fileName: string, context: { providerId: string }) {
            return parseGoTestJson(content, context);
          },
        },
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: {
      providerId: 'go_test' as ProviderId,
      assertionBindingFormats: new Set<ReportFormatId>(['go_test_json']),
      buildLocalId(parsed: ParsedAssertion) {
        if (parsed.kind !== 'go_test_json')
          throw new Error(`go_test codec received ${parsed.kind}`);
        return buildGoLocalId(parsed.pkg, parsed.testName);
      },
      validateLocalId(localId: string) {
        return GO_LOCAL_ID_RE.test(localId);
      },
    },
  },
};
