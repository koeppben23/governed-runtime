/**
 * @module verification/assertion-parsers/parsers
 * @description Canonical parser instances for shared report formats.
 *
 * Formats like junit_xml are supported by multiple providers (JUnit, pytest).
 * Instead of each provider creating its own parser wrapper, a single canonical
 * parser object is exported here and referenced by all providers.
 *
 * @version v1
 */

import { parseJUnitXml } from './junit-xml.js';
import type { AssertionReportParser } from './types.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

export const junitXmlParser: AssertionReportParser = {
  format: 'junit_xml' as ReportFormatId,
  parse(content, fileName, context) {
    return parseJUnitXml(content, fileName, context);
  },
};
