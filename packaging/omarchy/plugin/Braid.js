.pragma library

// Formatting and small derivations shared by the bar widget and the panel.

function fmtBytes(bytes) {
  var value = Number(bytes) || 0
  if (value < 1000) return Math.round(value) + " B"
  var units = ["kB", "MB", "GB", "TB"]
  var index = -1
  while (value >= 1000 && index < units.length - 1) {
    value = value / 1000
    index++
  }
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index]
}

function fmtSpeed(bytesPerSecond) {
  var value = Number(bytesPerSecond) || 0
  if (value <= 0) return ""
  return fmtBytes(value) + "/s"
}

function fmtTime(seconds) {
  var value = Math.round(Number(seconds) || 0)
  if (value <= 0) return ""
  if (value < 60) return value + "s left"
  if (value < 3600) return Math.round(value / 60) + "m left"
  return (value / 3600).toFixed(1) + "h left"
}

function percent(download) {
  if (!download || !download.totalBytes) return 0
  return Math.max(0, Math.min(1, download.bytesDownloaded / download.totalBytes))
}

// A download's status as the panel shows it.
function statusLabel(download) {
  if (!download) return ""
  if (download.status === "downloading") {
    var parts = [fmtSpeed(download.speedBytesPerSec) || "connecting"]
    var left = fmtTime(download.timeLeftSeconds)
    if (left) parts.push(left)
    return parts.join(" · ")
  }
  if (download.status === "queued") return "queued"
  if (download.status === "paused") return "paused"
  if (download.status === "failed") return download.error ? "failed · " + download.error : "failed"
  return download.status
}

function kindGlyph(kind) {
  if (kind === "wifi") return "󰤨"
  if (kind === "ethernet") return "󰈀"
  if (kind === "usb") return "󰕒"
  if (kind === "bridge") return "󰛳"
  return "󰖟"
}

// The daemon's link list as one line for the hero's meta text.
function linksLine(networks) {
  if (!networks || networks.length === 0) return "NO NETWORK"
  var names = []
  for (var i = 0; i < networks.length; i++) {
    var network = networks[i]
    names.push(String(network.displayName || network.device || network.id))
  }
  return names.join(" + ").toUpperCase()
}
