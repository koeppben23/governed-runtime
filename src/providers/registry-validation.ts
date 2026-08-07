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

  for (const ext of extensions) {
    const pid = ext.manifest.providerId;

    if (providerIds.has(pid)) {
      errors.push({ kind: 'duplicate_provider_id', message: `Duplicate providerId: ${pid}` });
    }
    providerIds.add(pid);

    // Codec provider match
    if (ext.verification.identityCodec) {
      if (ext.verification.identityCodec.providerId !== pid) {
        errors.push({
          kind: 'codec_provider_mismatch',
          message: `Codec providerId '${ext.verification.identityCodec.providerId}' != manifest '${pid}'`,
        });
      }
    }

    // Assertion-binding format has codec
    for (const fmt of ext.verification.formats) {
      if (fmt.bindingCapability === 'assertion' && !ext.verification.identityCodec) {
        errors.push({
          kind: 'assertion_format_without_codec',
          message: `Provider '${pid}': format '${fmt.format}' is assertion-binding but no codec`,
        });
      }
    }

    // Profile validation
    for (const profile of ext.discovery.executionProfiles) {
      if (profileIds.has(profile.profileId)) {
        errors.push({
          kind: 'duplicate_profile_id',
          message: `Duplicate profileId: ${profile.profileId}`,
        });
      }
      profileIds.add(profile.profileId);

      if (profile.providerId !== pid) {
        errors.push({
          kind: 'profile_provider_mismatch',
          message: `Profile '${profile.profileId}' providerId != manifest '${pid}'`,
        });
      }

      const fmtRegistered = ext.verification.formats.some((f) => f.format === profile.format);
      if (!fmtRegistered) {
        errors.push({
          kind: 'profile_format_not_registered',
          message: `Profile '${profile.profileId}' format '${profile.format}' not registered`,
        });
      }
    }

    // Report template provider match
    if (ext.discovery.assertionReportTemplate) {
      if (ext.discovery.assertionReportTemplate.providerId !== pid) {
        errors.push({
          kind: 'report_template_provider_mismatch',
          message: `Template providerId != manifest '${pid}'`,
        });
      }
    }

    // Unsafe probe commands
    for (const req of ext.discovery.runtimeRequirements ?? []) {
      if (
        req.probe.kind === 'exec' &&
        /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|go\s+install)\b/i.test(
          req.probe.command,
        )
      ) {
        errors.push({
          kind: 'unsafe_probe_command',
          message: `Provider '${pid}' requirement '${req.id}' has install probe`,
        });
      }
    }
  }

  return errors;
}
