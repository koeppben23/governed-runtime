/**
 * @module providers/pytest/provider
 * @description pytest assertion provider extension.
 * @version v1
 */

import {
  parsePytestJson,
  buildPytestLocalId,
} from '../../verification/assertion-parsers/pytest-json.js';
import { parseJUnitXml } from '../../verification/assertion-parsers/junit-xml.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

const PYTEST_LOCAL_ID_RE = /^[^:]+(::[^:]+)+$/;

export const pytestProvider: AssertionProviderExtension = {
  manifest: { providerId: 'pytest' as ProviderId, label: 'pytest' },

  discovery: {
    detectionIds: ['testFramework:pytest'],
    scriptSignatures: [
      { executable: 'pytest' },
      { moduleInvocation: { executable: 'python', module: 'pytest' } },
    ],
    runtimeRequirements: [
      {
        id: 'python',
        role: 'runtime' as const,
        probe: { kind: 'exec' as const, command: 'python --version' },
      },
      {
        id: 'pytest',
        role: 'tool' as const,
        probe: { kind: 'exec' as const, command: 'python -c "import pytest"' },
      },
      {
        id: 'pytest-json-report',
        role: 'reporter' as const,
        probe: { kind: 'exec' as const, command: 'python -c "import pytest_jsonreport"' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'pytest_json' as const,
      providerId: 'pytest' as const,
      outputArgumentTemplate:
        '--json-report --json-report-file=.flowguard/reports/{attemptId}/pytest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/pytest.json',
    },
    executionProfiles: [
      {
        profileId: 'pytest-json-fallback',
        providerId: 'pytest' as const,
        format: 'pytest_json' as const,
        kind: 'test' as const,
        priority: 4,
        createCandidate(ctx: { detectedStackIds: ReadonlySet<string> }) {
          if (!ctx.detectedStackIds.has('testFramework:pytest')) return null;
          return {
            assertionCapability: 'structured' as const,
            kind: 'test' as const,
            command: 'python -m pytest',
            source: 'detectedStack:testFramework:pytest',
            confidence: 'medium' as const,
            reason: 'pytest detected; using structured JSON assertion extraction',
            assertionReport: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'pytest_json' as const,
              providerId: 'pytest' as const,
              outputArgumentTemplate:
                '--json-report --json-report-file=.flowguard/reports/{attemptId}/pytest.json',
              resultPatternTemplate: '.flowguard/reports/{attemptId}/pytest.json',
            },
          };
        },
      },
    ],
  },

  verification: {
    formats: [
      {
        format: 'pytest_json' as ReportFormatId,
        parser: {
          format: 'pytest_json' as ReportFormatId,
          parse(content: string, _fileName: string, context: { providerId: string }) {
            return parsePytestJson(content, context);
          },
        },
        bindingCapability: 'assertion' as const,
      },
      {
        format: 'junit_xml' as ReportFormatId,
        parser: {
          format: 'junit_xml' as ReportFormatId,
          parse(content: string, fileName: string, context: { providerId: string }) {
            return parseJUnitXml(content, fileName, context);
          },
        },
        bindingCapability: 'check_only' as const,
      },
    ],
    identityCodec: {
      providerId: 'pytest' as ProviderId,
      assertionBindingFormats: new Set<ReportFormatId>(['pytest_json']),
      buildLocalId(parsed: ParsedAssertion) {
        if (parsed.kind !== 'pytest_json') throw new Error(`pytest codec received ${parsed.kind}`);
        return buildPytestLocalId(parsed.nodeId);
      },
      validateLocalId(localId: string) {
        return PYTEST_LOCAL_ID_RE.test(localId);
      },
    },
  },
};
