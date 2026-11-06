/**
 * @module cli/doctor-diagnostics
 * @description Doctor projection for the post-cutover diagnostic surface.
 *
 * Doctor cannot prove native Desktop delivery or execute the diagnostic
 * command. It reports that limitation explicitly; file logs remain the
 * baseline and no GUI success is inferred from package presence.
 */

import type { DoctorCheck } from './install-types.js';

const DIAGNOSTIC_DELIVERY_CHECK = 'diagnostics-delivery';

export function checkDiagnosticCapabilities(): DoctorCheck[] {
  return [
    {
      file: 'trust://opencode/diagnostics',
      status: 'info',
      check: DIAGNOSTIC_DELIVERY_CHECK,
      detail:
        'Native /debug-export, /diagnostics and flowguard debug-export are available in this build; doctor does not execute them. Native Desktop panel/notification delivery is NOT_VERIFIED; file logs are the baseline.',
    },
  ];
}
