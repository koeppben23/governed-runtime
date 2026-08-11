/** Test predicates for source-tagged standalone review report findings. */

export function hasMaterialFinding(
  findings: Array<Record<string, unknown>>,
  message: string,
  category?: string,
  reportSeverity?: string,
): boolean {
  return findings.some((finding) => {
    if (finding.source !== 'material_finding') return false;
    const material = finding.finding as Record<string, unknown>;
    return (
      material.message === message &&
      (category === undefined || material.category === category) &&
      (reportSeverity === undefined || finding.reportSeverity === reportSeverity)
    );
  });
}
