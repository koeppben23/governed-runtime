#!/usr/bin/env bash
# Controlled demo process groups only: children that create a separate session
# are outside this contract. Callers enable job control with `set -m`.

demo_group_alive() {
  kill -0 -- "-${ACTIVE_CHILD_PGID}" 2>/dev/null
}

wait_for_demo_group() {
  local waited=0
  while demo_group_alive && [[ "$waited" -lt 50 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  ! demo_group_alive
}

terminate_active_child() {
  [[ -n "${ACTIVE_CHILD_PGID:-}" ]] || return 0
  if [[ ! "$ACTIVE_CHILD_PGID" =~ ^[1-9][0-9]*$ ]]; then
    echo 'Invalid controlled process group; retaining the lease.' >&2
    return 1
  fi
  if demo_group_alive; then
    kill -TERM -- "-${ACTIVE_CHILD_PGID}" 2>/dev/null || true
    if ! wait_for_demo_group; then
      kill -KILL -- "-${ACTIVE_CHILD_PGID}" 2>/dev/null || true
      if ! wait_for_demo_group; then
        echo "Process group $ACTIVE_CHILD_PGID remains present; retaining the lease." >&2
        return 1
      fi
    fi
  fi
  # Reap the direct child as well; its PID disappearing alone is not evidence
  # that the group is gone.
  wait "$ACTIVE_CHILD_PGID" 2>/dev/null || true
  return 0
}

run_controlled_command() {
  "$@" &
  ACTIVE_CHILD_PGID=$!
  local code=0
  wait "$ACTIVE_CHILD_PGID" || code=$?
  # A leader can exit while its descendants keep executing. Keep the lease and
  # clean up that group even on ordinary command completion.
  if ! terminate_active_child; then
    # Do not launch the next stage or overwrite the still-active group ID.
    exit 1
  fi
  ACTIVE_CHILD_PGID=''
  return "$code"
}

demo_exit_cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if terminate_active_child; then
    "$DEMO_EXIT_CLEANUP"
  else
    code=1
  fi
  exit "$code"
}

demo_signal_exit() {
  local code="$1"
  trap '' INT TERM
  # EXIT will check the group again and only release after confirmed absence.
  terminate_active_child || true
  exit "$code"
}

install_exit_traps() {
  DEMO_EXIT_CLEANUP="$1"
  trap demo_exit_cleanup EXIT
  trap 'demo_signal_exit 130' INT
  trap 'demo_signal_exit 143' TERM
}
