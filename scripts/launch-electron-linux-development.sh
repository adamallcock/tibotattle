#!/usr/bin/env bash

# Launch the downloaded Linux x64 development distribution without requiring a
# separate Node.js installation. The packaged Electron executable interprets
# the sidecar .mjs launcher in Node mode, then the launcher starts the ordinary
# GUI with its strict child environment and Chromium sandbox requirements.
set -euo pipefail

sidecar_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
app="$sidecar_dir/linux-unpacked/tibotattle-dev"
launcher="$sidecar_dir/TiboTattle-Linux-Development-Launcher.mjs"

if [[ ! -f "$app" || ! -x "$app" || ! -f "$launcher" ]]; then
  printf '%s\n' 'TIBOTATTLE_LINUX_DEVELOPMENT_HANDOFF_INVALID' >&2
  exit 1
fi

if [[ -n "${TIBOTATTLE_LINUX_DEVELOPMENT_PROFILE:-}" ]]; then
  profile="$TIBOTATTLE_LINUX_DEVELOPMENT_PROFILE"
elif [[ -n "${XDG_STATE_HOME:-}" ]]; then
  profile="$XDG_STATE_HOME/tibotattle/linux-x64-development"
elif [[ -n "${HOME:-}" ]]; then
  profile="$HOME/.local/state/tibotattle/linux-x64-development"
else
  printf '%s\n' 'TIBOTATTLE_LINUX_DEVELOPMENT_HOME_REQUIRED' >&2
  exit 1
fi

# The launcher receives all user arguments after the fixed app/profile pair;
# its parser rejects unknown or duplicate options. Keep this runner's input to
# display/runtime locale variables as well: credentials, hosted origins, Node
# options, and smoke controls never enter the packaged Electron process. The
# launcher's own fixed child allowlist applies again before the GUI starts.
exec env -i \
  ELECTRON_RUN_AS_NODE=1 \
  "PATH=${PATH:-}" \
  "LANG=${LANG:-}" \
  "LC_ALL=${LC_ALL:-}" \
  "TZ=${TZ:-}" \
  "DISPLAY=${DISPLAY:-}" \
  "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}" \
  "XAUTHORITY=${XAUTHORITY:-}" \
  "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}" \
  "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}" \
  "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}" \
  "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}" \
  "$app" "$launcher" \
  --app "$app" \
  --profile "$profile" \
  "$@"
