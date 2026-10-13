/**
 * @module audit/iso27001/control-catalog
 * @description Closed catalog of candidate ISO/IEC 27001:2022 Annex A controls.
 *
 * The catalog is edition-specific and intentionally tiny: it contains only the
 * controls this projection has evidence selectors for. It carries short control
 * names for orientation — never normative control text (ISO licensing).
 *
 * @version v1
 */

/** Framework identifier; the edition is part of the identity, never implied. */
export const ISO27001_FRAMEWORK_ID = 'ISO/IEC 27001:2022' as const;

/** Namespace for Annex A control references in mappings and reports. */
export const ISO27001_ANNEX_A_NAMESPACE = 'iso27001:2022/annexA' as const;

/**
 * Candidate Annex A controls. "Candidate" means these controls MAY be mapped
 * by an organization; it never means they are applicable or satisfied. SoA
 * applicability remains an organizational authority under clause 6.1.3.
 */
export const ISO27001_2022_ANNEX_A_CONTROLS = [
  { controlId: 'A.8.15', name: 'Logging' },
  { controlId: 'A.8.25', name: 'Secure development life cycle' },
  { controlId: 'A.8.26', name: 'Application security requirements' },
  { controlId: 'A.8.27', name: 'Secure system architecture and engineering principles' },
  { controlId: 'A.8.28', name: 'Secure coding' },
  { controlId: 'A.8.29', name: 'Security testing in development and acceptance' },
  { controlId: 'A.8.32', name: 'Change management' },
] as const;

export type AnnexAControlId = (typeof ISO27001_2022_ANNEX_A_CONTROLS)[number]['controlId'];

/** Closed set of Annex A control ids the v1 mapping may reference. */
export const ANNEX_A_CONTROL_IDS = ISO27001_2022_ANNEX_A_CONTROLS.map(
  (control) => control.controlId,
) as readonly AnnexAControlId[];

/** Short control name by id (orientation only — no normative text). */
export const ANNEX_A_CONTROL_NAMES: Readonly<Record<AnnexAControlId, string>> = Object.freeze(
  Object.fromEntries(
    ISO27001_2022_ANNEX_A_CONTROLS.map((control) => [control.controlId, control.name]),
  ) as Record<AnnexAControlId, string>,
);
