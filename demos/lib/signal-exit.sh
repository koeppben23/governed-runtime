#!/usr/bin/env bash
# Signal/exit contract for the demo wrapper (unit-tested via demo-signal-exit.test.ts).
#
# The EXIT trap owns cleanup (lease release). INT/TERM terminate the WHOLE
# active process group first (npx -> node runner -> opencode host all share the
# background job's process group when job control is enabled), then reset the
# traps and exit with 130/143. Cleanup must not run before the process tree has
# actually exited, otherwise the lease could be released while a demo child is
# still running.
#
# Requirements for callers:
#   - run `set -m` before launching children (job control gives every
#     background job its own process group);
#   - expose the active child PID/PGID as ACTIVE_CHILD_PGID while waiting;
#   - run children in the background and `wait` for them (bash defers traps
#     while a foreground child is executing).
#
# Usage:
#   source demos/lib/signal-exit.sh
#   install_exit_traps release_lease

terminate_active_child() {
  [[ -n "${ACTIVE_CHILD_PGID:-}" ]] || return 0
  # Signal the entire process group (Linux and macOS both support kill -PGID).
  kill -TERM -- "-${ACTIVE_CHILD_PGID}" 2>/dev/null ||
    kill -TERM "${ACTIVE_CHILD_PGID}" 2>/dev/null ||
    true
  local waited=0
  while kill -0 "${ACTIVE_CHILD_PGID}" 2>/dev/null && [[ "${waited}" -lt 50 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "${ACTIVE_CHILD_PGID}" 2>/dev/null; then
    kill -KILL -- "-${ACTIVE_CHILD_PGID}" 2>/dev/null ||
      kill -KILL "${ACTIVE_CHILD_PGID}" 2>/dev/null ||
      true
    sleep 0.2
  fi
}

install_exit_traps() {
  local cleanup="$1"
  # shellcheck disable=SC2064
  trap "$cleanup" EXIT
  # shellcheck disable=SC2064
  trap 'terminate_active_child; trap - INT TERM; exit 130' INT
  # shellcheck disable=SC2064
  trap 'terminate_active_child; trap - INT TERM; exit 143' TERM
}
