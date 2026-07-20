FlowGuard blocked this action.

⚠ **Blocked:** `PLUGIN_ENFORCEMENT_UNAVAILABLE` — Required evidence is missing.

**Root cause:** Required evidence slots are missing.

## Required

• readable FlowGuard session state
• active plugin enforcement context

## Next

• Run flowguard doctor to verify the installation and plugin activation.
• Inspect session directory and session-state.json permissions.
• Re-run /hydrate after fixing workspace or session state issues.