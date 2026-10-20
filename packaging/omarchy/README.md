# oma-plexo — Plexo's engine, as an Omarchy plugin

oma-plexo puts **[Plexo](https://github.com/anmolkapil/plexo)**'s download engine on
the Omarchy bar, with no window open. Two pieces:

| Piece                 | What it is                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`plexo-daemon`**    | The download engine from `src/main/`, running under plain Node as a systemd **user** service. No Electron, no window — this is what downloads while the app is closed. |
| **`omega.oma-plexo`** | The Quickshell plugin: a bar widget with the machine's live internet speed (all apps, every network) and a panel for networks, per-link speeds, and download controls. |

```
plexo-ctl ──┐
            ├── unix socket ($XDG_RUNTIME_DIR/plexo-daemon-<uid>.sock, 0600)
bar plugin ─┘        │
                     ▼
              plexo-daemon ── DownloadManager ── sockets bound per interface
                     │                          (SO_BINDTODEVICE)
                     ▼
        ~/.config/Plexo  (the app's own settings, history, saved progress)
```

## Credit

oma-plexo is built on **[Plexo](https://github.com/anmolkapil/plexo)** — the app, the
download engine in `src/main/`, and the bulk of this repository are **Anmol
Kapil**'s work, MIT licensed. All upstream credit belongs to him; this packaging
only adds the Omarchy plugin, the headless daemon scaffolding and the
system-wide multipath helper. The original readme is kept as
[README.plexo.md](../../README.plexo.md); if you like what this does, star the
upstream project too.

## Install

```bash
git clone https://github.com/Omegaiconz13/oma-plexo
cd oma-plexo
npm ci --ignore-scripts && npx patch-package   # once; the patches teach the
                                               # torrent engine to pin peers
./packaging/omarchy/install.sh
```

The installer builds the daemon (`npm run build:daemon`), installs `plexo-ctl`
into `~/.local/bin`, writes and starts `plexo-daemon.service` as a user unit,
copies the plugin to `~/.config/omarchy/plugins/omega.oma-plexo/`, and enables it in
the bar (it also cleans up older `omega.plexo` and `omega.braid` installs, if
there are any). Re-run it after `git pull`. Undo everything with
`./packaging/omarchy/uninstall.sh` (downloads and settings stay).

Its last step offers to install one root-owned helper (it asks for `sudo` once)
for the panel's **SYSTEM-WIDE INTERNET** switch — a script plus a sudoers rule
that lets the daemon switch the mode on and off through that script, and run
nothing else. Skipping it is fine: the rest of the plugin does not need root.

Useful commands:

```bash
systemctl --user status plexo-daemon
journalctl --user -u plexo-daemon -f
plexo-ctl status                  # the JSON the bar widget lives on
plexo-ctl start '{"url":"https://…/big.iso"}'
plexo-ctl multipath '{"action":"on"}'   # system-wide mode on/off/status
plexo-ctl watch                   # live stream: status ticks + download events
```

## "Works even when the app isn't open"

The daemon _is_ the engine, so downloads started from the bar (or from
`plexo-ctl`) keep running with the app closed — including resuming after a
restart, because it uses the app's own saved-progress files.

The daemon and the app share `~/.config/Plexo`. Because both restore the same
saved downloads, only one may run at a time, and they take turns automatically:

- the daemon **stands down** while the Plexo app is open (it sees Electron's
  `SingletonLock` and exits cleanly);
- `Restart=always`/`RestartSec=15` in the unit brings it back within 15s of the
  app closing.

Browser sign-in cookies need Electron's `safeStorage` (a keychain); the daemon
has none, so a link started from the browser extension is saved **without** its
cookies rather than refusing to save. Start those from the app instead.

## Many networks at once

Nothing needs enabling in NetworkManager: unlike Windows, Linux keeps Wi-Fi and
Ethernet (and a tethered phone) connected simultaneously. What matters is:

1. **Independent uplinks.** Wi-Fi from your router plus a phone over USB adds
   bandwidth; Wi-Fi and Ethernet from the same router don't — they share one
   line. (Same as the app's own documentation.)
2. **One network that binds and one that doesn't** is fine: `plexo-ctl status`
   reports `deviceBinding: true` when the kernel lets Plexo pin sockets per
   interface (Linux ≥ 5.7, no root needed). If it were ever `false`, the engine
   falls back to source-address routing, which is weaker.
3. **Which link ordinary traffic uses** — optional, for browsing quality:
   `packaging/omarchy/network/tune-multi-link.sh` pins route metrics
   (ethernet < wi-fi < tether) and can turn Wi-Fi power saving off. It prints
   what it would do; `--apply` makes the changes (root, via `sudo`).

Aggregation itself is the daemon's job, not the system's: it binds sockets to
each interface and fetches different byte ranges of one file over different
links at once. The bar panel shows the per-link split live.

## System-wide internet (all apps)

The panel's **SYSTEM-WIDE INTERNET** switch extends multi-network use past
Plexo's own downloads: it sends the whole machine's traffic over every live
uplink at once, so apps like `apt`, a browser, `git` or a game launcher stop
being limited to a single link.

What it does (through the root helper `plexo-multipath`):

- installs a multipath default route with one nexthop per live uplink (equal
  weights; a link that NetworkManager rates below `full` is left out);
- raises `net.ipv4.fib_multipath_hash_policy` to L4, so the kernel spreads
  **parallel connections** — many tabs, package downloads, torrents, containers
  — across the links, and their bandwidths add up system-wide;
- first pins every _already-open_ connection to the uplink it was using, so SSH
  sessions, video calls and live streams keep their network and their IP when
  the mode flips on;
- everything it installs is tagged (route protocols 88 and 89) and removed in
  one step — `off`, daemon stop, or `sudo plexo-multipath down` — after which
  NetworkManager's own routes are the default again.

Honest limits:

- A **single connection** (one video stream, one big single-threaded download)
  still uses one network. Spreading one connection over several links needs a
  relay server on the internet side — that is a different project, not
  something a client-side plugin can do.
- A link that is up but barely passing traffic can slow some connections until
  the engine's per-link stream logic moves the work to the healthy link (oma-plexo
  probes and retires crawling streams automatically; Plexo's own downloads are
  bound per interface, so each link carries only its own streams).
- IPv6 keeps using its own default route; only IPv4 is balanced.
- Route changes are system-wide by nature: if the helper is installed the switch
  works, but the first time you toggle it on, expect a one-second blip on
  brand-new connections while the route is replaced.

## The panel

Click the download mark in the bar:

- **Networks** — every link the daemon can see; the switch writes the same
  "off" preference the app's New download dialog does.
- **Downloads** — the active ones: progress, per-network chips (click a chip to
  switch that network off the download, or back on), pause/resume, show in
  folder, cancel.
- **New download** — paste a link or magnet and Start; it probes the URL, then
  starts over every network that's on.
- **System-wide internet** — one switch that sends every app's traffic over all
  live networks (see above); while it's on, the widget's mark shows
  `󰇚×N`, the number of networks sharing the load.

If the daemon isn't running, the panel says so and offers to start it.

## Troubleshooting

| Symptom                                             | What to check                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bar shows the mark but no speed                     | `plexo-ctl status` — `downloads` should list the download; the speed line appears once bytes move.                                                             |
| "DAEMON NOT RUNNING"                                | `systemctl --user start plexo-daemon`, then `journalctl --user -u plexo-daemon -n 50`.                                                                         |
| Daemon exits seconds after starting                 | The Plexo app is open (that's the stand-down). Close it; the unit restarts the daemon.                                                                         |
| A second network isn't used                         | `plexo-ctl status` → both links must have addresses; in the panel, both chips must be lit. A server that refuses byte ranges gets a single stream on one link. |
| Plugin missing from the bar                         | `omarchy plugin list`, then `omarchy plugin enable omega.oma-plexo --section right`.                                                                           |
| System-wide switch says setup is needed             | The root helper isn't installed yet — re-run `./packaging/omarchy/install.sh` and accept the one `sudo` step.                                                  |
| System-wide switch went off by itself after a while | The daemon re-applies it on restarts and link changes; if a link drops, the mode stays up with the remaining links. Check `plexo-ctl status` → `systemWide`.   |
| Nothing downloads                                   | Check disk space (`plexo-ctl freeSpace '{"dir":"/home"}'`) and that the destination folder exists.                                                             |

## Limits (v1)

- No browser-extension link capture in the daemon (the app still has it).
- No cookie/sign-in persistence (see above).
- System-wide mode balances IPv4 connections, not single streams and not IPv6
  (see "System-wide internet" above for both).
- The panel controls active downloads; queueing schedules and data limits are
  read from the app's settings but not edited here.
