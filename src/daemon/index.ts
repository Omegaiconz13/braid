/**
 * The Plexo daemon: the download engine from the windowed app, running under plain Node with no
 * window. This is what makes the Omarchy plugin (and any other client) work while the Plexo app
 * is closed — start, watch, pause and finish downloads from the bar, a keybind or a script.
 *
 * It shares the app's files (~/.config/Plexo: settings, history, saved downloads), so the two
 * are two faces of the same downloads. Because the engine saves and restores from those files,
 * only one of them may run at a time; the daemon stands down while the app is open and systemd
 * brings it back when the app closes (see packaging/omarchy/README.md).
 */
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, statfs } from 'node:fs/promises'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { DownloadManager } from '../main/download/downloadManager'
import { listHistory } from '../main/download/history'
import { getDefaultDownloadsDir } from '../main/download/paths'
import { probeUrl } from '../main/download/probe'
import { deviceBindingSupported } from '../main/network/deviceBinding'
import { NetworkMonitor } from '../main/network/interfaces'
import { loadSettings, saveSettings } from '../main/settings'
import { IpcChannels } from '../shared/ipc-channels'
import { socketPath, type DaemonStatus, type DownloadSummary } from './protocol'
import { ControlServer, type DaemonHandler } from './server'
import { Multipath } from './systemWide'

const STATUS_TICK_MS = 1000
const startedAt = Date.now()

/** One download as the bar and panel need it (see protocol.ts). The engine's own update carries
 * per-block arrays that would dwarf a status tick. */
function summarize(update: unknown): DownloadSummary {
  const state = (update as { state: DownloadSummary & Record<string, unknown> }).state
  const networks = Array.isArray(state.networks) ? state.networks : []
  return {
    id: String(state.id),
    kind: state.kind === 'torrent' ? 'torrent' : 'http',
    fileName: String(state.fileName),
    status: String(state.status),
    totalBytes: Number(state.totalBytes) || 0,
    bytesDownloaded: Number(state.bytesDownloaded) || 0,
    speedBytesPerSec: Number(state.speedBytesPerSec) || 0,
    timeLeftSeconds: typeof state.timeLeftSeconds === 'number' ? state.timeLeftSeconds : undefined,
    queuedAt: typeof state.queuedAt === 'number' ? state.queuedAt : undefined,
    error: typeof state.error === 'string' ? state.error : undefined,
    resumable: typeof state.resumable === 'boolean' ? state.resumable : undefined,
    destinationPath: String(state.destinationPath ?? ''),
    folder: state.folder === true,
    networks: networks.map((entry) => {
      const network = entry as Record<string, unknown>
      return {
        id: String(network.id),
        label: String(network.label ?? network.id),
        kind: String(network.kind ?? 'other'),
        enabled: network.enabled !== false,
        status: String(network.status ?? 'unknown'),
        speedBytesPerSec: Number(network.speedBytesPerSec) || 0,
        bytesDownloaded: Number(network.bytesDownloaded) || 0
      }
    })
  }
}

/** Is the windowed app (or another daemon) running against this userData folder? Electron keeps
 * a `SingletonLock` symlink holding "<host>-<pid>" while it runs. */
function singletonOwner(userData: string): number | null {
  const lock = join(userData, 'SingletonLock')
  if (!existsSync(lock)) return null
  try {
    const target = readlinkSync(lock)
    const pid = Number(target.slice(target.lastIndexOf('-') + 1))
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    // Stale lock: no such process, or the entry isn't a symlink any more.
    return null
  }
}

function takeDaemonLock(userData: string): (() => void) | null {
  const path = join(userData, 'daemon.lock')
  try {
    const existing = Number(readFileSync(path, 'utf8').trim())
    if (Number.isInteger(existing) && existing > 0) {
      try {
        process.kill(existing, 0)
        return null
      } catch {
        // The daemon that wrote it is gone.
      }
    }
  } catch {
    // No lock file yet.
  }
  writeFileSync(path, `${process.pid}\n`)
  try {
    // Two daemons racing to start would both read "no lock" above; the last
    // writer wins and everyone else stands down.
    if (Number(readFileSync(path, 'utf8').trim()) !== process.pid) return null
  } catch {
    return null
  }
  return () => {
    try {
      rmSync(path, { force: true })
    } catch {
      // Nothing to clean up.
    }
  }
}

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

interface StartParams {
  url: string
  destinationDir?: string
  interfaceIds?: string[]
  streamsPerNetwork?: number
}

let manager: DownloadManager
/** Assigned once the handlers exist; the network monitor and the engine stubs are wired before. */
let server: ControlServer | null = null
const multipath = new Multipath()

/** Uplinks came or went: if system-wide mode is on, re-derive its links and pins shortly.
 * The delay lets a reconnect storm (Wi-Fi power save, USB re-enumeration) settle first. */
let multipathRefresh: NodeJS.Timeout | null = null
function scheduleMultipathRefresh(): void {
  if (multipathRefresh) return
  multipathRefresh = setTimeout(() => {
    multipathRefresh = null
    // The saved preference, not the current route: a start-up that found no
    // uplink yet must come up as soon as one connects. `up` is idempotent.
    void loadSettings()
      .then((settings) => (settings.multipathEnabled === true ? multipath.up() : null))
      .catch(() => {})
  }, 15000)
  multipathRefresh.unref()
}

/** A link into a start request, the way the app's New download dialog builds one: probe first,
 * then hand the engine everything it needs to plan the download. */
async function startFromUrl(params: StartParams, networks: NetworkMonitor): Promise<string> {
  if (typeof params?.url !== 'string' || params.url.trim() === '') {
    throw new Error('A url is required')
  }
  const settings = await loadSettings()
  const probe = await probeUrl(params.url)
  const list = (await networks.refresh()) ?? []
  const enabled = list
    .filter((network) => !settings.networkPreferences?.[network.id]?.off)
    .map((network) => network.id)
  const interfaceIds =
    Array.isArray(params.interfaceIds) && params.interfaceIds.length > 0
      ? params.interfaceIds
      : enabled
  if (interfaceIds.length === 0) throw new Error('No network is available to download over')
  const common = {
    url: probe.finalUrl,
    destinationDir: params.destinationDir ?? settings.destinationDir ?? getDefaultDownloadsDir(),
    suggestedFileName: probe.suggestedFileName,
    totalBytes: probe.totalBytes ?? 0,
    supportsRanges: probe.supportsRanges,
    interfaceIds,
    etag: probe.etag,
    lastModified: probe.lastModified
  }
  return manager.start(
    probe.kind === 'torrent'
      ? { ...common, kind: 'torrent', infoHash: probe.torrent.infoHash }
      : { ...common, kind: 'http', streamsPerNetwork: params.streamsPerNetwork }
  )
}

async function main(): Promise<void> {
  // Node's Happy-Eyeballs races a host's address families with a 500 ms cut-off per attempt,
  // shorter than one TCP handshake over a slow link (a congested Wi-Fi round trip runs past
  // 600 ms). The probe that starts every download connects through the OS route — which, with
  // several links in the default route, may well be that slow one — and would die as ETIMEDOUT
  // before ever connecting. Three seconds still falls over quickly when a family truly hangs.
  // The engine's chunk connections pin their own device and never take this path.
  setDefaultAutoSelectFamilyAttemptTimeout(3000)

  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })

  const appPid = singletonOwner(userData)
  if (appPid !== null) {
    // The app owns these files while it runs; systemd restarts the daemon after it closes.
    console.log(`[plexo-daemon] the Plexo app (pid ${appPid}) is running; standing down`)
    process.exit(0)
  }
  const releaseLock = takeDaemonLock(userData)
  if (!releaseLock) {
    console.error('[plexo-daemon] another daemon is already running')
    process.exit(1)
  }

  const socket = socketPath()

  // The engine pushes through a BrowserWindow in the app; here the same calls fan out to every
  // socket client instead.
  const windowStub = {
    isDestroyed: (): boolean => false,
    isMinimized: (): boolean => false,
    restore: (): void => {},
    show: (): void => {},
    focus: (): void => {},
    webContents: {
      send: (channel: string, payload?: unknown): void => {
        if (channel === IpcChannels.downloadUpdated) {
          server?.broadcast('downloadUpdated', payload)
        } else if (channel === IpcChannels.historyChanged) {
          server?.broadcast('historyChanged')
        } else if (channel === IpcChannels.networksChanged) {
          server?.broadcast('networksChanged', payload)
        }
      }
    }
  } as unknown as BrowserWindow

  const networks = new NetworkMonitor((list) => {
    manager.networksChanged()
    server?.broadcast('networksChanged', list)
    scheduleMultipathRefresh()
  })
  manager = new DownloadManager(() => windowStub, networks)
  await manager.applySettings(await loadSettings())
  const bindingSupport = await deviceBindingSupported()

  const statusNow = async (): Promise<DaemonStatus> => {
    const downloads = (await manager.listDownloads()).map(summarize)
    const list = networks.current ?? []
    const settings = await loadSettings()
    return {
      daemon: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        socket,
        clients: server?.clientCount ?? 0
      },
      deviceBinding: bindingSupport,
      networks: list.map((network) => ({
        id: network.id,
        device: network.device,
        displayName: network.displayName,
        kind: network.kind,
        addresses: network.addresses.map((address) => ({
          address: address.address,
          family: address.family
        }))
      })),
      networkPreferences: settings.networkPreferences ?? {},
      systemWide: await multipath.state(),
      downloads,
      speedBytesPerSec: downloads.reduce((sum, download) => sum + download.speedBytesPerSec, 0)
    }
  }

  const handlers: Record<string, DaemonHandler> = {
    ping: () => 'pong',
    status: () => statusNow(),
    networks: () => networks.refresh(),
    downloadList: () => manager.listDownloads(),
    history: () => listHistory(),
    clearHistory: () => manager.clearHistory(),
    settings: () => loadSettings(),
    updateSettings: async (params: unknown) => {
      await saveSettings(params)
      await manager.applySettings(await loadSettings())
      return loadSettings()
    },
    probe: (params: unknown) => probeUrl((params as { url: string }).url),
    start: (params: unknown) => startFromUrl(params as StartParams, networks),
    pause: (params: unknown) => manager.pause((params as { id: string }).id),
    resume: (params: unknown) => manager.resume((params as { id: string }).id),
    cancel: (params: unknown) => manager.cancel((params as { id: string }).id),
    remove: (params: unknown) => {
      const { id, trashFile } = params as { id: string; trashFile?: boolean }
      return manager.remove(id, trashFile === true)
    },
    setNetwork: (params: unknown) => {
      const { id, networkId, enabled } = params as {
        id: string
        networkId: string
        enabled: boolean
      }
      return manager.setNetworkEnabled(id, networkId, enabled)
    },
    relink: (params: unknown) => {
      const { id, url } = params as { id: string; url: string }
      return manager.relink(id, url)
    },
    reveal: (params: unknown) => manager.reveal((params as { id: string }).id),
    openDownload: (params: unknown) => manager.open((params as { id: string }).id),
    torrentFiles: (params: unknown) => manager.torrentFiles((params as { id: string }).id),
    chooseTorrentFiles: (params: unknown) => {
      const { id, selected } = params as { id: string; selected: number[] }
      return manager.chooseTorrentFiles(id, selected)
    },
    networkUsage: () => manager.limits.usedByPeriod(),
    resetNetworkUsage: (params: unknown) =>
      manager.resetNetworkUsage((params as { id: string }).id),
    freeSpace: (params: unknown) => freeSpace((params as { dir: string }).dir),
    multipath: async (params: unknown) => {
      const action = String((params as { action?: string } | undefined)?.action ?? 'status')
      if (action === 'on') {
        const state = await multipath.up()
        // Remembered only once it is really on, so a failed enable retries next start.
        if (state.on) await saveSettings({ multipathEnabled: true })
        return state
      }
      if (action === 'off') {
        const state = await multipath.down()
        if (!state.on) await saveSettings({ multipathEnabled: false })
        return state
      }
      return multipath.state(true)
    },
    shutdown: async () => {
      setImmediate(() => void stop('requested'))
      return 'stopping'
    }
  }

  server = new ControlServer(handlers)
  await server.listen(socket)
  console.log(`[plexo-daemon] listening on ${socket} (pid ${process.pid})`)

  // The switch is remembered in settings: bring the mode back up across restarts.
  if ((await loadSettings()).multipathEnabled === true) {
    const state = await multipath.up()
    console.log(
      `[plexo-daemon] system-wide mode: ${
        state.on ? `on over ${state.links.map((link) => link.dev).join('+')}` : 'off'
      }${state.error ? ` (${state.error})` : ''}`
    )
  }

  const tick = setInterval(() => {
    const active = server
    if (!active || active.clientCount === 0) return
    // A client that goes away mid-tick is not an error.
    statusNow().then(
      (status) => active.broadcast('status', status),
      () => {}
    )
  }, STATUS_TICK_MS)
  tick.unref()

  const bye = (): void => releaseLock()
  process.on('exit', bye)
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

async function stop(reason: string): Promise<void> {
  console.log(`[plexo-daemon] stopping (${reason})`)
  await manager?.suspendAll().catch(() => {})
  // Routing is the daemon's to give back: stop leaves the machine on
  // NetworkManager's own default routes whoever asks for the stop.
  await multipath.shutdown().catch(() => {})
  await server?.close().catch(() => {})
  process.exit(0)
}

void main().catch((error) => {
  console.error('[plexo-daemon] failed to start', error)
  process.exit(1)
})
