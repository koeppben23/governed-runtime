/**
 * @module providers/registry-validation
 * @description Pure validation for AssertionProviderExtension registrations.
 * @version v1
 */

import type { AssertionProviderExtension } from './contract.js';

export interface ValidationError {
  readonly kind: string;
  readonly message: string;
}

export function validateProviderExtensions(
  extensions: readonly AssertionProviderExtension[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const providerIds = new Set<string>();
  const profileIds = new Set<string>();
  const detectionIds = new Set<string>();
  const formatParsers = new Map<string, unknown>();
  const profilesByProvider = new Map<string, Set<string>>();
  const scriptSigs: { providerId: string; executionProfileId: string; candidateKind: string }[] =
    [];
  const profileKindById = new Map<string, string>();
  const assertionFormatsByProvider = new Map<string, Set<string>>();

  for (const ext of extensions) {
    const pid = ext.manifest.providerId;

    if (providerIds.has(pid))
      errors.push({ kind: 'duplicate_provider_id', message: `Duplicate: ${pid}` });
    providerIds.add(pid);

    for (const detId of ext.discovery.detectionIds) {
      if (detectionIds.has(detId))
        errors.push({ kind: 'duplicate_detection_id', message: `Duplicate: ${detId}` });
      detectionIds.add(detId);
    }

    const provAssertionFormats = new Set<string>();
    for (const fmt of ext.verification.formats) {
      const existing = formatParsers.get(fmt.format);
      if (existing !== undefined && existing !== fmt.parser) {
        errors.push({
          kind: 'conflicting_format_parser',
          message: `Format '${fmt.format}' has conflicting parsers`,
        });
      }
      formatParsers.set(fmt.format, fmt.parser);
      if (fmt.bindingCapability === 'assertion') {
        provAssertionFormats.add(fmt.format);
      }
    }
    assertionFormatsByProvider.set(pid, provAssertionFormats);

    if (ext.verification.identityCodec) {
      if (ext.verification.identityCodec.providerId !== pid)
        errors.push({ kind: 'codec_provider_mismatch', message: `Codec != ${pid}` });

      for (const fmt of ext.verification.formats) {
        const inCodec = ext.verification.identityCodec.assertionBindingFormats.has(fmt.format);
        const isAssertion = fmt.bindingCapability === 'assertion';
        if (isAssertion !== inCodec) {
          errors.push({
            kind: 'codec_binding_mismatch',
            message: `Format '${fmt.format}' binding inconsistent with codec`,
          });
        }
      }
    }

    for (const fmt of ext.verification.formats) {
      if (fmt.bindingCapability === 'assertion' && !ext.verification.identityCodec) {
        errors.push({
          kind: 'assertion_format_without_codec',
          message: `Format '${fmt.format}' is assertion-binding but no codec for '${pid}'`,
        });
      }
    }

    for (const profile of ext.discovery.executionProfiles) {
      if (profileIds.has(profile.profileId))
        errors.push({ kind: 'duplicate_profile_id', message: `Duplicate: ${profile.profileId}` });
      profileIds.add(profile.profileId);

      if (profile.providerId !== pid)
        errors.push({
          kind: 'profile_provider_mismatch',
          message: `Profile ${profile.profileId} != ${pid}`,
        });

      if (!ext.verification.formats.some((f) => f.format === profile.format))
        errors.push({
          kind: 'profile_format_not_registered',
          message: `Profile '${profile.profileId}' format '${profile.format}' not registered`,
        });

      const provProfiles = profilesByProvider.get(pid) ?? new Set();
      provProfiles.add(profile.profileId);
      profilesByProvider.set(pid, provProfiles);

      profileKindById.set(profile.profileId, profile.kind);

      // Report integrity: assertionReport must reference the owning provider and format
      const report = profile.assertionReport;
      if (report.providerId !== profile.providerId) {
        errors.push({
          kind: 'profile_report_provider_mismatch',
          message: `Profile '${profile.profileId}' assertionReport.providerId='${report.providerId}' != profile.providerId='${profile.providerId}'`,
        });
      }
      if (report.format !== profile.format) {
        errors.push({
          kind: 'profile_report_format_mismatch',
          message: `Profile '${profile.profileId}' assertionReport.format='${report.format}' != profile.format='${profile.format}'`,
        });
      }
      const reportFormat = ext.verification.formats.find(
        (format) => format.format === report.format,
      );
      if (reportFormat?.bindingCapability === 'aggregate' && !profile.attestFullCheckScope) {
        errors.push({
          kind: 'aggregate_profile_missing_scope_attestation',
          message: `Aggregate profile '${profile.profileId}' must attest its full check scope`,
        });
      }
      if (
        reportFormat?.bindingCapability !== 'assertion' &&
        reportFormat?.bindingCapability !== 'aggregate'
      ) {
        errors.push({
          kind: 'profile_report_format_not_assertion_capable',
          message: `Profile '${profile.profileId}' assertionReport.format='${report.format}' is not assertion-binding capable for provider '${pid}'`,
        });
      }
    }

    if (
      ext.discovery.assertionReportTemplate &&
      ext.discovery.assertionReportTemplate.providerId !== pid
    ) {
      errors.push({ kind: 'report_template_provider_mismatch', message: `Template != ${pid}` });
    }

    for (const req of [
      ...(ext.discovery.runtimeRequirements ?? []),
      ...ext.discovery.executionProfiles.flatMap((p) => p.runtimeRequirements ?? []),
    ]) {
      if (
        req.probe.kind === 'exec' &&
        /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|go\s+install)\b/i.test(
          req.probe.command,
        )
      ) {
        errors.push({
          kind: 'unsafe_probe_command',
          message: `Provider '${pid}' has unsafe probe: ${req.probe.command}`,
        });
      }
    }

    if (ext.discovery.scriptSignatures) {
      for (const sig of ext.discovery.scriptSignatures) {
        scriptSigs.push({
          providerId: pid,
          executionProfileId: sig.executionProfileId,
          candidateKind: sig.candidateKind,
        });
      }
    }
  }

  // Cross-provider: script-signature → profile referential integrity
  for (const sig of scriptSigs) {
    const kind = profileKindById.get(sig.executionProfileId);
    if (kind === undefined) {
      errors.push({
        kind: 'signature_profile_missing',
        message: `Provider '${sig.providerId}': script signature references unknown profile '${sig.executionProfileId}'`,
      });
      continue;
    }
    const provProfiles = profilesByProvider.get(sig.providerId);
    if (!provProfiles?.has(sig.executionProfileId)) {
      errors.push({
        kind: 'signature_profile_cross_provider',
        message: `Provider '${sig.providerId}': script signature references profile '${sig.executionProfileId}' from a different provider`,
      });
    }
    if (kind !== sig.candidateKind) {
      errors.push({
        kind: 'signature_kind_mismatch',
        message: `Provider '${sig.providerId}': script signature candidateKind='${sig.candidateKind}' but profile '${sig.executionProfileId}' has kind='${kind}'`,
      });
    }
  }

  return errors;
}
