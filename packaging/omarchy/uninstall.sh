#!/usr/bin/env bash
# Removes everything install.sh put in place. Downloads, history and settings
# in ~/.config/Plexo are left alone.
set -euo pipefail

PLUGIN_ID="omega.plexo"
UNIT_NAME="plexo-daemon.service"

systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$UNIT_NAME"
systemctl --user daemon-reload || true
rm -f "$HOME/.local/bin/plexo-ctl"

if command -v omarchy >/dev/null 2>&1; then
  omarchy plugin disable "$PLUGIN_ID" 2>/dev/null || true
fi
rm -rf "$HOME/.config/omarchy/plugins/$PLUGIN_ID"

# The optional system-wide helper (root-owned, from install.sh's last step).
# `sudo` can only run the helper itself, so removing root-owned files may need
# an interactive password; without a terminal, say what to run instead.
HELPER_DST="/usr/local/libexec/plexo-multipath"
SUDOERS_FILE="/etc/sudoers.d/plexo-multipath"
if [[ -x "$HELPER_DST" ]]; then
  sudo -n "$HELPER_DST" down >/dev/null 2>&1 || true
fi
HELPER_REMOVED=0
if [[ -x "$HELPER_DST" || -e "$SUDOERS_FILE" ]]; then
  if sudo -n rm -f "$SUDOERS_FILE" "$HELPER_DST" 2>/dev/null; then
    HELPER_REMOVED=1
  elif [[ -t 0 ]] && sudo rm -f "$SUDOERS_FILE" "$HELPER_DST"; then
    HELPER_REMOVED=1
  fi
fi
if [[ "$HELPER_REMOVED" == 0 ]] && [[ -x "$HELPER_DST" || -e "$SUDOERS_FILE" ]]; then
  printf 'To remove the system-wide helper as well: sudo rm -f %s %s\n' "$SUDOERS_FILE" "$HELPER_DST"
fi

printf 'Plexo plugin removed. The daemon build stays in the source tree; ~/.config/Plexo was not touched.\n'
