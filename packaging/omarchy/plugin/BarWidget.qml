import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Braid.js" as Fmt

// The Braid bar widget: one mark plus the machine's live internet speed — all
// traffic over every connected network, not just Braid's own downloads. Click
// opens the panel. The widget owns the single long-lived `plexo-ctl watch`
// process; the panel reads its state through hostWidget.
BarWidget {
  id: root
  moduleName: "omega.braid"

  // ---------- daemon connection ----------

  // `plexo-ctl` is installed by packaging/omarchy/install.sh; the absolute
  // path keeps the widget working whatever PATH the shell was started with.
  readonly property string ctl: (Quickshell.env("HOME") || "") + "/.local/bin/plexo-ctl"

  property bool connected: false
  property var status: null
  readonly property var downloads: status ? (status.downloads || []) : []
  readonly property var networks: status ? (status.networks || []) : []
  readonly property var networkPreferences: status ? (status.networkPreferences || {}) : ({})
  readonly property real speed: status ? (status.speedBytesPerSec || 0) : 0
  // The whole machine this second: live traffic over every connected network.
  readonly property var throughput: status ? (status.throughput || null) : null
  readonly property real internetRx: throughput ? (throughput.rxBytesPerSec || 0) : 0
  readonly property real internetTx: throughput ? (throughput.txBytesPerSec || 0) : 0
  /** Under this, the bar number is hidden so idle background chatter doesn't flicker it. */
  readonly property real speedFloor: 10 * 1024
  /** This link's live traffic from the daemon's meter, or null before the first tick. */
  function linkRate(id) {
    var list = throughput && throughput.networks ? throughput.networks : []
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }
  readonly property var systemWide: status ? (status.systemWide || null) : null
  readonly property bool systemWideOn: systemWide ? systemWide.on === true : false
  readonly property var systemWideLinks: systemWide && systemWide.links ? systemWide.links : []
  // The downloads worth showing: live ones plus failures, which stay until the
  // panel's Remove button dismisses them.
  readonly property var activeDownloads: downloads.filter(function (d) {
    return d.status === "downloading" || d.status === "queued" || d.status === "paused" ||
           d.status === "failed"
  })
  readonly property bool busy: activeDownloads.some(function (d) { return d.status === "downloading" })

  // The argv a request to the daemon's socket becomes; the panel runs it
  // itself when it wants to read the reply.
  function ctlCommand(method, params) {
    return [root.ctl, method, JSON.stringify(params || {})]
  }

  // Fire-and-forget request, for actions whose outcome shows up in the next
  // watch line (once a second).
  function call(method, params) {
    Util.execArgv(root.ctlCommand(method, params))
  }

  function startDaemon() {
    Util.execDetached("systemctl --user start plexo-daemon")
  }

  function applyLine(line) {
    var value
    try {
      value = JSON.parse(String(line))
    } catch (e) {
      return
    }
    if (!value) return
    // Replies to the priming call come as {"id":0,…}; events carry `event`.
    if (value.event === "status" || (value.id === 0 && value.ok === true)) {
      var payload = value.event ? value.data : value.result
      if (payload && payload.daemon) {
        root.status = payload
        root.connected = true
        stale.restart()
      }
    } else if (value.event === "networksChanged" || value.event === "historyChanged") {
      // The next status tick carries the change; nothing to do.
    }
  }

  Process {
    id: watch
    command: [root.ctl, "watch"]
    // Quickshell does not start a Process on its own; the restart timer below
    // takes over from here if the daemon goes away.
    running: true
    stdout: SplitParser {
      onRead: function (line) { root.applyLine(line) }
    }
    onExited: restart.restart()
  }

  // A daemon that is starting, stopping or absent: try again shortly.
  Timer {
    id: restart
    interval: 2000
    onTriggered: if (!watch.running) watch.running = true
  }

  // No status line for six seconds means the daemon stopped.
  Timer {
    id: stale
    interval: 6000
    onTriggered: root.connected = false
  }

  // ---------- panel wiring (the stock bar-widget contract) ----------

  readonly property bool opened: panelItem ? panelItem.opened === true : false
  property var panelItem: null

  function open() { if (panelItem) panelItem.open() }
  function close() { if (panelItem) panelItem.close() }
  function togglePanel() { if (panelItem) panelItem.toggle() }

  readonly property bool popoutSwitchClosing: panelItem ? panelItem.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelItem) panelItem.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    panelItem = target
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    // `button` exists only once the widget is fully built; the Loader can
    // finish before that, and Qt.callLater(injectPanel) comes back for it.
    if ("anchorItem" in target && button) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "omega.braid"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  // ---------- the bar button ----------

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The mark carries the machine's live internet speed — everything, not only Braid's own
  // downloads. Below a low floor the number stays hidden so background chatter doesn't
  // flicker the label; a running download too quiet for a number shows "…" instead.
  readonly property string label: {
    if (!connected) return "󰇚"
    var mark = "󰇚" + (systemWideOn && systemWideLinks.length > 1 ? "×" + systemWideLinks.length : "")
    if (internetRx >= speedFloor) return mark + " " + Fmt.fmtSpeed(internetRx)
    if (busy) return mark + " …"
    return mark
  }

  readonly property string tooltip: {
    if (!connected) return "Braid · daemon not running"
    var lines = ["Braid · internet ↓ " + (Fmt.fmtSpeed(internetRx) || "0 B/s") + " ↑ " +
                 (Fmt.fmtSpeed(internetTx) || "0 B/s")]
    lines.push(networks.length === 1 ? "1 network" : networks.length + " networks")
    for (var i = 0; i < networks.length; i++) {
      var network = networks[i]
      var rate = linkRate(network.id)
      var speeds = ""
      if (rate) {
        var down = Fmt.fmtSpeed(rate.rxBytesPerSec)
        var up = Fmt.fmtSpeed(rate.txBytesPerSec)
        if (down || up) speeds = " " + (down ? "↓ " + down : "") + (up ? (down ? " " : "") + "↑ " + up : "")
      }
      lines.push("  " + (network.displayName || network.device) + speeds + " · " + network.addresses.map(function (a) {
        return a.address
      }).join(", "))
    }
    if (systemWide && systemWide.available === true) {
      if (systemWideOn) {
        var names = systemWideLinks.map(function (link) { return link.dev }).join(" + ")
        lines.push("System-wide: on — " + (names || "live networks") + " share the load")
      } else {
        lines.push("System-wide: off")
      }
    }
    if (activeDownloads.length === 0) {
      lines.push("No downloads")
    } else {
      for (var j = 0; j < activeDownloads.length; j++) {
        var download = activeDownloads[j]
        lines.push("  " + download.fileName + " · " + (Fmt.statusLabel(download) || download.status))
      }
    }
    return lines.join("\n")
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.label
    active: root.busy
    useActiveColor: root.busy
    tooltipText: root.tooltip
    onPressed: function (mouseButton) {
      if (mouseButton === Qt.LeftButton) root.togglePanel()
    }
  }
}
