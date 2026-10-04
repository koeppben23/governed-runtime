/**
 * @module providers/registry-validation
 * @description Pure validation for AssertionProviderExtension registrations.
 * @version v2
 */

import type { AssertionProviderExtension } from './contract.js';

export interface ValidationError {
  readonly kind: string;
  readonly message: string;
}

type ExecutionProfile = AssertionProviderExtension['discovery']['executionProfiles'][number];

interface ScriptSignatureRef {
  readonly providerId: string;
  readonly executionProfileId: string;
  readonly candidateKind: string;
}

interface ValidationContext {
  readonly errors: ValidationError[];
  readonly providerIds: Set<string>;
  readonly profileIds: Set<string>;
  readonly detectionIds: Set<string>;
  readonly formatParsers: Map<string, unknown>;
  readonly profilesByProvider: Map<string, Set<string>>;
  readonly scriptSigs: ScriptSignatureRef[];
  readonly profileKindById: Map<string, string>;
}

function invalid(context: ValidationContext, kind: string, message: string): void {
  context.errors.push({ kind, message });
}

function validateProviderIdentity(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  if (context.providerIds.has(pid)) invalid(context, 'duplicate_provider_id', `Duplicate: ${pid}`);
  context.providerIds.add(pid);

  for (const detId of ext.discovery.detectionIds) {
    if (context.detectionIds.has(detId)) {
      invalid(context, 'duplicate_detection_id', `Duplicate: ${detId}`);
    }
    context.detectionIds.add(detId);
  }
}

function validateFormatsAndCodec(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  for (const fmt of ext.verification.formats) {
    const existing = context.formatParsers.get(fmt.format);
    if (existing !== undefined && existing !== fmt.parser) {
      invalid(
        context,
        'conflicting_format_parser',
        `Format '${fmt.format}' has conflicting parsers`,
      );
    }
    context.formatParsers.set(fmt.format, fmt.parser);
  }

  const codec = ext.verification.identityCodec;
  if (codec) {
    if (codec.providerId !== pid) invalid(context, 'codec_provider_mismatch', `Codec != ${pid}`);
    for (const fmt of ext.verification.formats) {
      const inCodec = codec.assertionBindingFormats.has(fmt.format);
      const isAssertion = fmt.bindingCapability === 'assertion';
      if (isAssertion !== inCodec) {
        invalid(
          context,
          'codec_binding_mismatch',
          `Format '${fmt.format}' binding inconsistent with codec`,
        );
      }
    }
  }

  for (const fmt of ext.verification.formats) {
    if (fmt.bindingCapability === 'assertion' && !codec) {
      invalid(
        context,
        'assertion_format_without_codec',
        `Format '${fmt.format}' is assertion-binding but no codec for '${pid}'`,
      );
    }
  }
}

function validateProfileReport(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
  profile: ExecutionProfile,
): void {
  // Report integrity: assertionReport must reference the owning provider and format
  const report = profile.assertionReport;
  if (report.providerId !== profile.providerId) {
    invalid(
      context,
      'profile_report_provider_mismatch',
      `Profile '${profile.profileId}' assertionReport.providerId='${report.providerId}' != profile.providerId='${profile.providerId}'`,
    );
  }
  if (report.format !== profile.format) {
    invalid(
      context,
      'profile_report_format_mismatch',
      `Profile '${profile.profileId}' assertionReport.format='${report.format}' != profile.format='${profile.format}'`,
    );
  }
  const reportFormat = ext.verification.formats.find((format) => format.format === report.format);
  if (reportFormat?.bindingCapability === 'aggregate' && !profile.attestFullCheckScope) {
    invalid(
      context,
      'aggregate_profile_missing_scope_attestation',
      `Aggregate profile '${profile.profileId}' must attest its full check scope`,
    );
  }
  if (
    reportFormat?.bindingCapability !== 'assertion' &&
    reportFormat?.bindingCapability !== 'aggregate'
  ) {
    invalid(
      context,
      'profile_report_format_not_assertion_capable',
      `Profile '${profile.profileId}' assertionReport.format='${report.format}' is not assertion-binding capable for provider '${pid}'`,
    );
  }
}

function validateProfiles(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  for (const profile of ext.discovery.executionProfiles) {
    if (context.profileIds.has(profile.profileId)) {
      invalid(context, 'duplicate_profile_id', `Duplicate: ${profile.profileId}`);
    }
    context.profileIds.add(profile.profileId);

    if (profile.providerId !== pid) {
      invalid(context, 'profile_provider_mismatch', `Profile ${profile.profileId} != ${pid}`);
    }

    if (!ext.verification.formats.some((f) => f.format === profile.format)) {
      invalid(
        context,
        'profile_format_not_registered',
        `Profile '${profile.profileId}' format '${profile.format}' not registered`,
      );
    }

    const provProfiles = context.profilesByProvider.get(pid) ?? new Set();
    provProfiles.add(profile.profileId);
    context.profilesByProvider.set(pid, provProfiles);
    context.profileKindById.set(profile.profileId, profile.kind);

    validateProfileReport(context, ext, pid, profile);
  }
}

function validateReportTemplate(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  const template = ext.discovery.assertionReportTemplate;
  if (template && template.providerId !== pid) {
    invalid(context, 'report_template_provider_mismatch', `Template != ${pid}`);
  }
}

function validateRuntimeRequirements(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  const requirements = [
    ...(ext.discovery.runtimeRequirements ?? []),
    ...ext.discovery.executionProfiles.flatMap((p) => p.runtimeRequirements ?? []),
  ];
  for (const req of requirements) {
    const installsDependencies =
      req.probe.kind === 'exec' &&
      /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|go\s+install)\b/i.test(
        req.probe.command,
      );
    if (installsDependencies) {
      invalid(
        context,
        'unsafe_probe_command',
        `Provider '${pid}' has unsafe probe: ${req.probe.command}`,
      );
    }
  }
}

function collectScriptSignatures(
  context: ValidationContext,
  ext: AssertionProviderExtension,
  pid: string,
): void {
  for (const sig of ext.discovery.scriptSignatures ?? []) {
    context.scriptSigs.push({
      providerId: pid,
      executionProfileId: sig.executionProfileId,
      candidateKind: sig.candidateKind,
    });
  }
}

function validateExtension(context: ValidationContext, ext: AssertionProviderExtension): void {
  const pid = ext.manifest.providerId;
  validateProviderIdentity(context, ext, pid);
  validateFormatsAndCodec(context, ext, pid);
  validateProfiles(context, ext, pid);
  validateReportTemplate(context, ext, pid);
  validateRuntimeRequirements(context, ext, pid);
  collectScriptSignatures(context, ext, pid);
}

function validateScriptSignature(context: ValidationContext, sig: ScriptSignatureRef): void {
  const kind = context.profileKindById.get(sig.executionProfileId);
  if (kind === undefined) {
    invalid(
      context,
      'signature_profile_missing',
      `Provider '${sig.providerId}': script signature references unknown profile '${sig.executionProfileId}'`,
    );
    return;
  }
  if (!context.profilesByProvider.get(sig.providerId)?.has(sig.executionProfileId)) {
    invalid(
      context,
      'signature_profile_cross_provider',
      `Provider '${sig.providerId}': script signature references profile '${sig.executionProfileId}' from a different provider`,
    );
  }
  if (kind !== sig.candidateKind) {
    invalid(
      context,
      'signature_kind_mismatch',
      `Provider '${sig.providerId}': script signature candidateKind='${sig.candidateKind}' but profile '${sig.executionProfileId}' has kind='${kind}'`,
    );
  }
}

export function validateProviderExtensions(
  extensions: readonly AssertionProviderExtension[],
): ValidationError[] {
  const context: ValidationContext = {
    errors: [],
    providerIds: new Set(),
    profileIds: new Set(),
    detectionIds: new Set(),
    formatParsers: new Map(),
    profilesByProvider: new Map(),
    scriptSigs: [],
    profileKindById: new Map(),
  };

  for (const ext of extensions) validateExtension(context, ext);
  for (const sig of context.scriptSigs) validateScriptSignature(context, sig);

  return context.errors;
}
