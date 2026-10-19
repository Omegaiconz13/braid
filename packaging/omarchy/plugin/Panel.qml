pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Braid.js" as Fmt

// The Braid panel: what the daemon is doing and the controls for it. It reads
// live state from its bar widget (hostWidget), which owns the watch process.
Panel {
  id: root
  moduleName: "omega.braid"
  ipcTarget: "omega.braid"
  // The bar widget owns the plugin's single IpcHandler.
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property var host: hostWidget

  // The host bar is injected just after the panel loads, so it can be null for
  // a moment: colors and fonts fall back to the theme's defaults.
  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string ff: bar ? bar.fontFamily : Style.font.family
  readonly property bool connected: host ? host.connected === true : false
  readonly property var downloads: host ? (host.activeDownloads || []) : []
  readonly property var networks: host ? (host.networks || []) : []
  readonly property var preferences: host ? (host.networkPreferences || {}) : ({})
  readonly property real totalSpeed: host ? (host.speed || 0) : 0
  readonly property var systemWide: host ? (host.systemWide || null) : null
  readonly property bool systemWideOn: systemWide ? systemWide.on === true : false
  readonly property var systemWideLinks: systemWide && systemWide.links ? systemWide.links : []

  property string linkText: ""
  property string notice: ""

  // Panel actions go through `plexo-ctl` one at a time, and a refusal (bad
  // link, daemon gone, helper missing) becomes `notice` instead of being
  // dropped: a fire-and-forget call would leave the user guessing.
  property var actionQueue: []
  property bool actionBusy: false

  function call(method, params) {
    if (!host) return
    notice = ""
    actionQueue = actionQueue.concat([{ method: method, params: params || {} }])
    pumpActions()
  }

  function pumpActions() {
    if (actionBusy || actionQueue.length === 0 || !host) return
    actionBusy = true
    var job = actionQueue[0]
    actionProcess.command = host.ctlCommand(job.method, job.params)
    actionProcess.running = true
  }

  function finishAction(code) {
    var job = actionQueue.length > 0 ? actionQueue[0] : null
    if (code !== 0) {
      var message = String(actionErr.text || "").trim()
      notice = message !== "" ? message : "The daemon refused the call (plexo-ctl exited with " + code + ")."
    } else if (job && job.method === "start") {
      // A good start means the link is taken; a refusal leaves it in the
      // field so it can be fixed and retried.
      linkText = ""
    }
    actionQueue = actionQueue.length > 0 ? actionQueue.slice(1) : []
    actionBusy = false
    pumpActions()
  }

  function startDownload() {
    var url = String(linkText || "").trim()
    if (url === "") return
    // The daemon probes the link, picks every network that is on, and starts;
    // the bar's next status tick shows it. Nothing is echoed optimistically,
    // and the field keeps the link until the daemon has taken it.
    call("start", { url: url })
  }

  // Switching a network off here is the same setting the app's New download
  // dialog writes: it keeps the link for later downloads and stops it being
  // picked by default. A running download keeps its own per-network switches.
  function setPreference(networkId, off) {
    var next = {}
    for (var key in preferences) next[key] = preferences[key]
    var entry = {}
    var existing = next[networkId]
    if (existing) for (var field in existing) entry[field] = existing[field]
    if (off) entry.off = true
    else delete entry.off
    if (Object.keys(entry).length > 0) next[networkId] = entry
    else delete next[networkId]
    call("updateSettings", { networkPreferences: next })
  }

  onOpenedChanged: if (opened) notice = ""

  // Runs one queued `plexo-ctl` call; see call()/pumpActions() above.
  Process {
    id: actionProcess
    stderr: StdioCollector {
      id: actionErr
      waitForEnd: true
    }
    onExited: function (code) {
      Qt.callLater(function () { root.finishAction(code) })
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: linkField
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(560))

    ScrollView {
      id: scroll
      anchors.fill: parent
      clip: true
      ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
      ScrollBar.vertical.policy: content.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
      Binding {
        target: scroll.contentItem
        property: "interactive"
        value: content.implicitHeight > scroll.height
      }

      Column {
        id: content
        width: scroll.availableWidth
        spacing: Style.space(12)

        // ---------- hero ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            text: "󰇚"
            color: root.totalSpeed > 0 ? Color.accent : root.fg
            font.family: root.ff
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Braid"
              color: root.fg
              font.family: root.ff
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              text: root.connected
                ? (Fmt.linksLine(root.networks) + (root.totalSpeed > 0 ? " · " + Fmt.fmtSpeed(root.totalSpeed) : " · IDLE"))
                : "DAEMON NOT RUNNING"
              color: root.connected ? Qt.darker(root.fg, 1.4) : Color.urgent
              font.family: root.ff
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        // A refusal from the daemon (bad link, helper missing, daemon gone):
        // shown up here, where the eye lands when the panel opens.
        Text {
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          visible: root.notice !== ""
          text: root.notice
          color: Color.urgent
          font.family: root.ff
          font.pixelSize: Style.font.caption
        }

        // The daemon isn't up: offer to start it and stop there.
        Column {
          visible: !root.connected
          width: parent.width
          spacing: Style.space(8)

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: "The Plexo daemon downloads on this machine without the app window. Start it once, and it stays up in the background."
            color: Qt.darker(root.fg, 1.3)
            font.family: root.ff
            font.pixelSize: Style.font.body
          }

          Button {
            text: "Start the Plexo daemon"
            bordered: true
            foreground: root.fg
            accent: Color.accent
            onClicked: if (host) host.startDaemon()
          }
        }

        // ---------- networks ----------
        PanelSeparator { visible: root.connected; foreground: root.fg }

        Column {
          visible: root.connected
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            text: "NETWORKS"
            foreground: root.fg
            fontFamily: root.ff
          }

          Repeater {
            model: root.networks

            Item {
              required property var modelData
              width: content.width
              implicitHeight: networkRow.implicitHeight + Style.space(6)

              RowLayout {
                id: networkRow
                width: parent.width
                spacing: Style.space(10)

                Text {
                  textFormat: Text.PlainText
                  text: Fmt.kindGlyph(modelData.kind)
                  color: root.fg
                  font.family: root.ff
                  font.pixelSize: Style.font.icon
                }

                Column {
                  Layout.fillWidth: true
                  spacing: Style.space(1)

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: modelData.displayName || modelData.device
                    color: root.fg
                    font.family: root.ff
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: (modelData.addresses || []).map(function (a) { return a.address }).join(", ")
                    color: Qt.darker(root.fg, 1.5)
                    font.family: root.ff
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                ToggleSwitch {
                  checked: {
                    var entry = root.preferences[modelData.id]
                    return !(entry && entry.off === true)
                  }
                  foreground: root.fg
                  accent: Color.accent
                  // Same no-value signal: `checked` is the state before the
                  // click, so passing it as the "off" request is the flip.
                  onToggled: root.setPreference(modelData.id, checked)
                }
              }
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: root.networks.length > 1
            text: "Downloads use every network that is on, together — each one's own internet connection adds to the total."
            color: Qt.darker(root.fg, 1.5)
            font.family: root.ff
            font.pixelSize: Style.font.caption
          }
        }

        // ---------- system-wide ----------
        PanelSeparator { visible: root.connected && !!root.systemWide; foreground: root.fg }

        Column {
          visible: root.connected && !!root.systemWide
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            text: "SYSTEM-WIDE INTERNET"
            foreground: root.fg
            fontFamily: root.ff
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(8)

            Column {
              Layout.fillWidth: true
              spacing: Style.space(1)

              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: "Send every app across all networks"
                color: root.fg
                font.family: root.ff
                font.pixelSize: Style.font.body
              }

              Text {
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: {
                  var state = root.systemWide
                  if (!state) return ""
                  if (state.available !== true) {
                    return "One-time setup needed: run packaging/omarchy/install.sh once (it asks for sudo), then toggle again."
                  }
                  if (state.error) return state.error
                  if (state.on !== true) return "Off — every app shares one network at a time"
                  var names = root.systemWideLinks.map(function (link) { return link.dev }).join(" + ")
                  var pins = Number(state.pins) > 0 ? " · " + state.pins + " open connections pinned to their network" : ""
                  return "On — " + (names || "live networks") + " share the load" + pins
                }
                color: {
                  var state = root.systemWide
                  return state && state.error ? Color.urgent : Qt.darker(root.fg, 1.5)
                }
                font.family: root.ff
                font.pixelSize: Style.font.caption
              }
            }

            ToggleSwitch {
              // ToggleSwitch.toggled() carries no value (the caller owns
              // `checked`): a click means "flip what is showing".
              checked: root.systemWideOn
              enabled: root.systemWide ? root.systemWide.available === true : false
              foreground: root.fg
              accent: Color.accent
              onToggled: root.call("multipath", { action: root.systemWideOn ? "off" : "on" })
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Parallel connections spread over the networks, so their speeds add up. A single stream still uses one network — bonding one stream would need a relay server somewhere."
            color: Qt.darker(root.fg, 1.5)
            font.family: root.ff
            font.pixelSize: Style.font.caption
          }
        }

        // ---------- downloads ----------
        PanelSeparator { visible: root.connected && root.downloads.length > 0; foreground: root.fg }

        Column {
          visible: root.connected && root.downloads.length > 0
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            text: "DOWNLOADS"
            foreground: root.fg
            fontFamily: root.ff
          }

          Repeater {
            model: root.downloads

            Column {
              id: downloadRow
              required property var modelData
              width: content.width
              spacing: Style.space(5)

              RowLayout {
                width: parent.width
                spacing: Style.space(8)

                Text {
                  textFormat: Text.PlainText
                  text: downloadRow.modelData.kind === "torrent" ? "󰈈" : "󰈔"
                  color: root.fg
                  font.family: root.ff
                  font.pixelSize: Style.font.icon
                }

                Column {
                  Layout.fillWidth: true
                  spacing: Style.space(1)

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: downloadRow.modelData.fileName
                    color: root.fg
                    font.family: root.ff
                    font.pixelSize: Style.font.body
                    elide: Text.ElideMiddle
                  }

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: {
                      var download = downloadRow.modelData
                      var size = Fmt.fmtBytes(download.bytesDownloaded) + " / " + (download.totalBytes > 0 ? Fmt.fmtBytes(download.totalBytes) : "?")
                      var label = Fmt.statusLabel(download)
                      return label ? size + " · " + label : size
                    }
                    color: downloadRow.modelData.status === "failed" ? Color.urgent : Qt.darker(root.fg, 1.5)
                    font.family: root.ff
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                PanelActionButton {
                  visible: downloadRow.modelData.status === "downloading" || downloadRow.modelData.status === "queued"
                  iconText: "󰏤"
                  tooltipText: "Pause"
                  foreground: root.fg
                  onClicked: root.call("pause", { id: downloadRow.modelData.id })
                }

                PanelActionButton {
                  visible: downloadRow.modelData.status === "paused"
                  iconText: "󰐊"
                  tooltipText: "Resume"
                  foreground: root.fg
                  onClicked: root.call("resume", { id: downloadRow.modelData.id })
                }

                PanelActionButton {
                  iconText: "󰉋"
                  tooltipText: "Show in folder"
                  foreground: root.fg
                  onClicked: root.call("reveal", { id: downloadRow.modelData.id })
                }

                PanelActionButton {
                  iconText: "󰅖"
                  tooltipText: "Cancel"
                  foreground: root.fg
                  onClicked: root.call("cancel", { id: downloadRow.modelData.id })
                }

                PanelActionButton {
                  visible: downloadRow.modelData.status === "failed"
                  iconText: "󰆴"
                  tooltipText: "Remove"
                  foreground: root.fg
                  onClicked: root.call("remove", { id: downloadRow.modelData.id, trashFile: false })
                }
              }

              // Progress, and one chip per network with what it is delivering.
              Item {
                width: parent.width
                implicitHeight: Math.max(bar_rect.implicitHeight, chips.implicitHeight)

                Rectangle {
                  id: bar_rect
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  width: Math.max(Style.space(70), parent.width - chips.width - Style.space(12))
                  height: Style.space(4)
                  radius: height / 2
                  color: Qt.darker(root.fg, 1.8)

                  Rectangle {
                    width: parent.width * Fmt.percent(downloadRow.modelData)
                    height: parent.height
                    radius: parent.radius
                    color: downloadRow.modelData.status === "failed" ? Color.urgent : Color.accent
                  }
                }

                Row {
                  id: chips
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(5)

                  Repeater {
                    model: downloadRow.modelData.networks

                    Rectangle {
                      required property var modelData
                      visible: true
                      implicitWidth: chipLabel.implicitWidth + Style.space(10)
                      implicitHeight: chipLabel.implicitHeight + Style.space(4)
                      radius: Style.cornerRadius > 0 ? height / 2 : 0
                      color: modelData.enabled ? Style.selectionFillFor(root.fg, Color.accent) : "transparent"
                      border.width: modelData.enabled ? 0 : 1
                      border.color: Qt.darker(root.fg, 2.1)
                      opacity: modelData.enabled ? 1.0 : 0.55

                      Text {
                        id: chipLabel
                        anchors.centerIn: parent
                        textFormat: Text.PlainText
                        text: (modelData.label || modelData.id) + (modelData.speedBytesPerSec > 0 ? " " + Fmt.fmtSpeed(modelData.speedBytesPerSec) : "")
                        color: root.fg
                        font.family: root.ff
                        font.pixelSize: Style.font.caption
                      }

                      MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.call("setNetwork", {
                          id: downloadRow.modelData.id,
                          networkId: modelData.id,
                          enabled: !modelData.enabled
                        })
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // ---------- new download ----------
        PanelSeparator { visible: root.connected; foreground: root.fg }

        Column {
          visible: root.connected
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            text: "NEW DOWNLOAD"
            foreground: root.fg
            fontFamily: root.ff
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(8)

            TextField {
              id: linkField
              Layout.fillWidth: true
              // The field owns the typed text; the panel keeps a copy so
              // startDownload() and the Enter key reach the same value.
              text: root.linkText
              onTextEdited: root.linkText = text
              placeholderText: "Paste a link or magnet"
              foreground: root.fg
              accent: Color.accent
              onAccepted: root.startDownload()
            }

            Button {
              text: "Start"
              bordered: true
              foreground: root.fg
              accent: Color.accent
              enabled: String(linkField.text || "").trim() !== ""
              onClicked: root.startDownload()
            }
          }
        }
      }
    }
  }
}
