/**
 * The `electron` module as the daemon sees it: the small surface the download engine touches,
 * re-implemented on plain Node. The daemon build drops a copy of this file where `require`
 * will find it as `electron` (see scripts/build-daemon.mjs), so DownloadManager, settings,
 * history and the network limits run with no Electron at all — and keep running when the
 * window isn't open.
 *
 * The pieces that mean something on a headless machine:
 * - `app.getPath` points at the same files the windowed app uses (userData: ~/.config/Plexo),
 *   so the daemon and the app see the same settings, history and saved downloads.
 * - `safeStorage` reports no keychain, so a download started from the browser extension is
 *   saved without its sign-in rather than refusing to save.
 * - `powerSaveBlocker` becomes a systemd-inhibit sleep hold: a running download still keeps the
 *   machine awake.
 * - `Notification` becomes notify-send, `shell` becomes xdg-open / gio trash.
 *
 * Everything else is an inert stub. `app.isPackaged` is false on purpose: the PLEXO_* test
 * knobs stay live, which is how the daemon is tested and how PLEXO_USER_DATA can move its
 * files aside.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const noop = (): void => {}

function xdgDownloadDir(): string {
  try {
    const text = readFileSync(join(homedir(), '.config', 'user-dirs.dirs'), 'utf8')
    const match = /^XDG_DOWNLOAD_DIR="(.*)"$/m.exec(text)
    if (match) return match[1].replace(/^\$HOME/, homedir())
  } catch {
    // No user-dirs.dirs: the conventional folder below is what Electron would use too.
  }
  return join(homedir(), 'Downloads')
}

const daemonUserData = (): string =>
  process.env['PLEXO_USER_DATA'] ?? join(homedir(), '.config', 'Plexo')

const paths: Record<string, () => string> = {
  userData: daemonUserData,
  appData: daemonUserData,
  home: () => homedir(),
  downloads: xdgDownloadDir,
  temp: () => process.env['XDG_RUNTIME_DIR'] ?? '/tmp',
  logs: () => join(daemonUserData(), 'logs'),
  crashDumps: () => join(daemonUserData(), 'Crashpad')
}

export const app = {
  name: 'Plexo',
  /** False keeps the PLEXO_* knobs live (see the file header). */
  isPackaged: false,
  getPath: (name: string): string => paths[name]?.() ?? join(daemonUserData(), name),
  setName: noop,
  setAppUserModelId: noop,
  setAboutPanelOptions: noop,
  setAsDefaultProtocolClient: (): boolean => false,
  on: () => app,
  once: () => app,
  off: () => app,
  emit: (): boolean => false,
  whenReady: (): Promise<void> => Promise.resolve(),
  isReady: (): boolean => true,
  getVersion: (): string => 'daemon',
  quit: (): void => process.exit(0),
  exit: (code = 0): void => process.exit(code),
  requestSingleInstanceLock: (): boolean => true,
  releaseSingleInstanceLock: noop,
  dock: { hide: noop, show: noop }
}

export const nativeTheme = {
  themeSource: 'dark',
  shouldUseDarkColors: true,
  on: noop,
  off: noop
}

/** No keychain here: the engine then neither writes nor reads sealed browser sign-ins. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  getSelectedStorageBackend: (): string => 'basic_text',
  encryptString: (): never => {
    throw new Error('safeStorage is unavailable in the Plexo daemon')
  },
  decryptString: (): never => {
    throw new Error('safeStorage is unavailable in the Plexo daemon')
  }
}

let inhibitor: ReturnType<typeof spawn> | null = null

/** `prevent-app-suspension` while a download runs, through systemd-inhibit so it holds even
 * with no window open. Failure to inhibit never stops a download. */
export const powerSaveBlocker = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keeps Electron's signature
  start: (_type: string): number => {
    if (!inhibitor) {
      try {
        inhibitor = spawn(
          'systemd-inhibit',
          [
            '--what=sleep',
            '--why=Plexo: a download is running',
            '--mode=block',
            'sleep',
            'infinity'
          ],
          { stdio: 'ignore' }
        )
        inhibitor.on('error', () => {
          inhibitor = null
        })
      } catch {
        inhibitor = null
      }
    }
    return 1
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keeps Electron's signature
  stop: (_id: number): void => {
    inhibitor?.kill()
    inhibitor = null
  },
  isStarted: (): boolean => inhibitor !== null
}

function fireAndForget(command: string, args: string[]): void {
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', noop).unref()
  } catch {
    // No opener/browser: the action is simply a no-op.
  }
}

export const shell = {
  openExternal: async (target: string): Promise<string> => {
    fireAndForget('xdg-open', [target])
    return ''
  },
  openPath: async (path: string): Promise<string> => {
    fireAndForget('xdg-open', [path])
    return ''
  },
  showItemInFolder: (path: string): void => fireAndForget('xdg-open', [dirname(path)]),
  trashItem: async (path: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      spawn('gio', ['trash', path], { stdio: 'ignore' })
        .on('error', reject)
        .on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`gio trash exited with ${code}`))
        )
    })
  }
}

export class Notification {
  static isSupported(): boolean {
    return true
  }

  constructor(private readonly options: { title?: string; body?: string }) {}

  on(): this {
    return this
  }

  once(): this {
    return this
  }

  show(): void {
    const args = ['--app-name=Plexo', this.options.title ?? 'Plexo']
    if (this.options.body) args.push(this.options.body)
    fireAndForget('notify-send', args)
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- nothing to release headless
  close(): void {}
}

/** Not reached by the daemon's own wiring; here so an accidental import of the windowed
 * modules doesn't crash on a missing export. */
export const clipboard = { readText: (): string => '', writeText: noop }
export const dialog = {}
export const ipcMain = { on: noop, handle: noop, removeHandler: noop }
export const powerMonitor = { on: noop, off: noop }
export const Menu = { buildFromTemplate: () => ({ popup: noop }) }
export const Tray = class {}
export const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) }
export const BrowserWindow = class {}
