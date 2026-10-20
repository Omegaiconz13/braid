# Omega Plexo

Multi-network downloads for [Omarchy](https://omarchy.org) — from the bar, with
the app closed: every connected link pulls at once, and one switch can put the
whole machine's internet over all of them.

Omega Plexo is the Omarchy face of **[Plexo](https://github.com/anmolkapil/plexo)**'s
download engine: a Quickshell plugin (`omega.plexo`) plus a headless daemon
(`plexo-daemon`) that runs the engine under plain Node as a systemd user
service. No window needed — downloads keep running, resume after a reboot, and
the bar shows the machine's live internet speed across every network.

| Piece                | What it is                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`plexo-daemon`**   | Plexo's engine (HTTP + torrent, sockets bound per interface) under plain Node, as a systemd user service. Downloads while the app is closed.               |
| **`omega.plexo`**    | The Quickshell plugin: a bar widget showing the machine's live internet speed across every link, and a panel with downloads, per-link speeds and controls. |
| **System-wide mode** | Optional: a multipath default route over every live uplink, so all apps' connections spread across links (root helper + narrowed sudoers rule).            |

## Credit

The download engine, the app, and the bulk of this repository are
**[Plexo](https://github.com/anmolkapil/plexo) by Anmol Kapil** (MIT) — this
project would not exist without it. Omega Plexo adds the Omarchy plugin, the headless
daemon scaffolding and the system-wide multipath helper, and is published with
the original license and copyright notices intact (see [LICENSE](LICENSE); the
original readme is kept as [README.plexo.md](README.plexo.md)).

If you like Omega Plexo, please star [Plexo](https://github.com/anmolkapil/plexo) too.

## Install

```bash
git clone https://github.com/Omegaiconz13/omega-plexo
cd omega-plexo
npm ci --ignore-scripts && npx patch-package   # once; the patches teach the
                                               # torrent engine to pin peers
./packaging/omarchy/install.sh
```

That builds the daemon, installs `plexo-ctl`, the user service and the bar
plugin, and — with one `sudo` — the optional system-wide helper. Details,
honest limits and troubleshooting: [packaging/omarchy/README.md](packaging/omarchy/README.md).

Undo everything with `./packaging/omarchy/uninstall.sh` (downloads and settings
stay).

## License

MIT — see [LICENSE](LICENSE). Original work © 2026 Anmol Kapil (Plexo); Omega Plexo
additions © 2026 the Omega Plexo contributors.
