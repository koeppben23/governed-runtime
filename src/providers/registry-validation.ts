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

    for (const fmt of ext.verification.formats) {
      const existing = formatParsers.get(fmt.format);
      if (existing !== undefined && existing !== fmt.parser) {
        errors.push({
          kind: 'conflicting_format_parser',
          message: `Format '${fmt.format}' has conflicting parsers`,
        });
      }
      formatParsers.set(fmt.format, fmt.parser);
    }

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
  }

  return errors;
}
