#!/usr/bin/env bash
# Keeps several network links up at once, and tells NetworkManager which one
# ordinary traffic should prefer — faster links first, a tethered phone last.
#
# The Plexo daemon is what *combines* links: it binds sockets to each interface
# and downloads one file over all of them at once. This script only puts the
# system in the shape that makes that possible and sensible:
#
#   * every link keeps connecting on its own (autoconnect stays on);
#   * route metrics order the links: ethernet (100) < wi-fi (600) < tether (700),
#     so web browsing and updates use the fastest wired/wireless link while the
#     daemon still uses all of them for its own downloads;
#   * optional: wi-fi power saving off, which removes periodic latency spikes
#     at the cost of a little battery.
#
# Nothing here is required for a Plexo download to work — run it only if you
# want the preference order pinned down.
#
#   packaging/omarchy/network/tune-multi-link.sh            # show what it would do
#   packaging/omarchy/network/tune-multi-link.sh --apply    # make the changes
set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v nmcli >/dev/null 2>&1 || {
  echo "NetworkManager's nmcli is not installed; nothing to tune."
  exit 0
}

# `sudo` only when a password isn't needed; otherwise we print the commands.
nmcli_do() {
  if [[ "$APPLY" == "0" ]]; then
    echo "  would run: nmcli $*"
    return 0
  fi
  if [[ "$(id -u)" == "0" ]]; then
    nmcli "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -n nmcli "$@"
  else
    echo "  needs root (run: sudo nmcli $*)" >&2
    return 1
  fi
}

metric_for() {
  case "$1" in
    wl*) echo 600 ;;                        # wi-fi
    en*|eth*) echo 100 ;;                   # ethernet
    *) echo 700 ;;                          # usb tether, phones, everything else
  esac
}

echo "== Active links =="
mapfile -t active < <(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status |
  awk -F: '$3 == "connected" && $2 != "loopback" && $2 != "bridge" && $4 != ""')
if [[ "${#active[@]}" == 0 ]]; then
  echo "  none"
else
  printf '  %s\n' "${active[@]}"
fi
links=$(printf '%s\n' "${active[@]:-}" | grep -c . || true)
if [[ "$links" -ge 2 ]]; then
  echo "-> $links links are up: the Plexo daemon can download over all of them at once."
else
  echo "-> 1 link up. Plug in ethernet or tether a phone over USB for a second one;"
  echo "   downloads only get faster when each link reaches the internet on its own."
fi

echo
echo "== Route metrics (lower is preferred for ordinary traffic) =="
while IFS=: read -r device type state connection; do
  [[ "$state" == "connected" ]] || continue
  [[ "$type" == "loopback" || "$type" == "bridge" ]] && continue
  [[ -n "$connection" ]] || continue
  metric=$(metric_for "$device")
  current=$(nmcli -t -f ipv4.route-metric connection show "$connection" 2>/dev/null || echo "")
  echo "  $device ($type) · $connection · metric $metric${current:+ (now $current)}"
  nmcli_do connection modify "$connection" connection.autoconnect yes \
    ipv4.route-metric "$metric" ipv6.route-metric "$metric" || true
done < <(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status)

if [[ "$APPLY" == "1" ]]; then
  echo
  echo "Wi-fi power saving:"
  if [[ "$(id -u)" == "0" ]] || sudo -n true 2>/dev/null; then
    printf '[connection]\nwifi.powersave = 2\n' | {
      if [[ "$(id -u)" == "0" ]]; then tee /etc/NetworkManager/conf.d/99-plexo-wifi-powersave.conf >/dev/null
      else sudo -n tee /etc/NetworkManager/conf.d/99-plexo-wifi-powersave.conf >/dev/null
      fi
    }
    echo "  off (applies to wi-fi connections activated from now on; write 3 to re-enable)"
  else
    echo "  skipped — needs root: printf '[connection]\\nwifi.powersave = 2\\n' | sudo tee /etc/NetworkManager/conf.d/99-plexo-wifi-powersave.conf"
  fi
fi

echo
echo "These settings never turn a link off: Plexo still uses every link that is connected."
