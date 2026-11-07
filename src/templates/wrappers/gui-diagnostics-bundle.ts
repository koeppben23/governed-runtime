/** Inline native Desktop diagnostic renderer. No host authority or mutations. */
export const GUI_DIAGNOSTICS_BUNDLE = `\\
function renderDiagnosticsSections(element, line, sessionSection, auditSection, diagnostics) {
  if (!diagnostics) {
    element('p', 'Session lineage NOT_VERIFIED - diagnostic RPC unavailable.', sessionSection);
    element('p', 'Audit chronology NOT_VERIFIED - no verified audit projection.', auditSection);
    return;
  }
  const explorer = diagnostics.explorer;
  const audit = diagnostics.audit;
  line(sessionSection, 'Completeness', explorer.status);
  line(sessionSection, 'Lineage', explorer.lineage);
  line(sessionSection, 'Canonical state', explorer.canonicalState);
  line(sessionSection, 'Sessions', explorer.sessions.length +
    (explorer.sessionsTruncated ? ' (partial)' : ''));
  for (const item of explorer.sessions) {
    const card = element('details', null, sessionSection);
    const heading = element('summary', item.role + ' | ' + item.state + ' | ' + item.lineage, card);
    heading.style.cursor = 'pointer';
    line(card, 'Session', item.sessionID);
    line(card, 'Parent session', item.parentSessionID);
    line(card, 'Phase', item.phase);
    line(card, 'Binding', item.binding);
    if (item.warningCodes.length) line(card, 'Warnings', item.warningCodes.join(', '));
  }
  line(sessionSection, 'Review attempts', explorer.reviewAttempts.length +
    (explorer.reviewAttemptsTruncated ? ' (partial)' : ''));
  for (const attempt of explorer.reviewAttempts) {
    line(sessionSection, 'Attempt ' + attempt.ordinal,
      attempt.status + ' | dispatch ' + attempt.dispatchStatus +
      ' | obligation ' + attempt.obligationStatus +
      ' | child ' + (attempt.childSessionID || 'NOT_VERIFIED'));
  }
  if (explorer.warningCodes.length) {
    line(sessionSection, 'Diagnostic warnings', explorer.warningCodes.join(', '));
  }
  line(auditSection, 'Source', 'Verified audit-chain.v3 (not host transcript)');
  line(auditSection, 'Completeness', audit.status);
  line(auditSection, 'Audit events', audit.totalEvents +
    (audit.eventsTruncated ? ' (partial - newest entries only)' : ''));
  for (const item of audit.sessions) {
    line(auditSection, 'Session ' + item.sessionID + ' integrity',
      item.integrity + (item.reasonCode ? ' | ' + item.reasonCode : ''));
  }
  if (!audit.events.length) {
    element('p', 'No verified audit events available. NOT_VERIFIED is not clearance.', auditSection);
  }
  const entries = element('ol', null, auditSection);
  entries.style.paddingLeft = '20px';
  for (const event of audit.events) {
    const row = element('li', null, entries);
    element('strong', event.phase + ' | ' + event.event, row);
    line(row, 'Occurred', event.at);
    line(row, 'Recorded', event.recordedAt);
    line(row, 'Session / sequence', event.sessionID + ' / ' + event.sequence);
  }
  element('p', audit.note, auditSection);
}
`;
