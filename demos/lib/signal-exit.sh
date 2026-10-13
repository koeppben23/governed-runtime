#!/usr/bin/env bash
# Signal/exit contract for the demo wrapper (unit-tested via demo-signal-exit.test.ts).
#
# The EXIT trap owns cleanup (lease release). INT/TERM are converted into a
# defined termination: in-flight children are signalled first, the signal traps
# are reset to avoid recursion, and the script exits with the conventional
# 128+signal code (130 for INT, 143 for TERM).
#
# Callers MUST run long children in the background and `wait` for them; bash
# defers traps while a foreground child is executing.
#
# Usage:
#   source demos/lib/signal-exit.sh
#   install_exit_traps release_lease

install_exit_traps() {
  local cleanup="$1"
  # shellcheck disable=SC2064
  trap "$cleanup" EXIT
  # shellcheck disable=SC2064
  trap 'trap - INT TERM; pkill -TERM -P $$ 2>/dev/null || true; exit 130' INT
  # shellcheck disable=SC2064
  trap 'trap - INT TERM; pkill -TERM -P $$ 2>/dev/null || true; exit 143' TERM
}
