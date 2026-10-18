/**
 * System-wide mode: what the plugin's "Route every app across all networks" switch drives.
 *
 * The actual work is done by the root-owned helper installed by packaging/omarchy/install.sh
 * (`plexo-multipath`): it pins open connections and then installs a multipath default route
 * over every live uplink. This class is the daemon's side of that contract — it shells out,
 * parses the helper's single JSON line, and keeps a short cache so a one-second status tick
 * never becomes a one-second subprocess. Mutations go through `sudo -n`, allowed for exactly
 * this script by /etc/sudoers.d/plexo-multipath.
 *
 * Nothing here throws: every failure comes back as state with `error` set, which the panel
 * shows as-is. If the helper is missing, `available` is false and the panel says what to run.
 */
import { execFile } from 'node:child_process'

/** Overridable so tests (and the repository's own runs) can point at a stub. */
export const HELPER_PATH =
  process.env['PLEXO_MULTIPATH_HELPER'] ?? '/usr/local/libexec/plexo-multipath'

const STATUS_TIMEOUT_MS = 8000
const MUTATION_TIMEOUT_MS = 25000
const CACHE_MS = 4000

const SETUP_HINT =
  'System-wide mode needs its helper installed: run packaging/omarchy/install.sh once (it asks for sudo).'

export interface MultipathLink {
  dev: string
  via?: string
  src?: string
  weight?: number | string
}

export interface MultipathState {
  /** The privileged helper is installed. */
  available: boolean
  /** This script's multipath default route is live right now. */
  on: boolean
  links: MultipathLink[]
  /** /32 pins for connections that were open when it was enabled. */
  pins: number
  /** Set when the last enable/disable failed; a sentence the panel can show. */
  error?: string
}

interface HelperOutput {
  ok?: boolean
  up?: boolean
  pins?: number
  error?: string
  links?: MultipathLink[]
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, killSignal: 'SIGTERM' },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as NodeJS.ErrnoException).code === 'number'
              ? ((error as unknown as { code: number }).code as number)
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 127
                : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** The helper always ends with exactly one JSON line; anything before it is diagnostics. */
function lastJsonLine(text: string): HelperOutput | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i] ?? '')
      if (value && typeof value === 'object') return value as HelperOutput
    } catch {
      // Keep walking up: the JSON line is the last one that parses.
    }
  }
  return null
}

export class Multipath {
  private cached: { at: number; value: MultipathState } | null = null
  private inFlight: Promise<MultipathState> | null = null

  /** Current state, at most one helper call every few seconds. */
  async state(force = false): Promise<MultipathState> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value
    if (this.inFlight) return this.inFlight
    this.inFlight = this.queryStatus().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  async up(): Promise<MultipathState> {
    return this.mutate('up')
  }

  async down(): Promise<MultipathState> {
    return this.mutate('down')
  }

  /** Daemon stop: put the machine back on NetworkManager's own routes. */
  async shutdown(): Promise<void> {
    try {
      const current = await this.state()
      if (current.available && current.on) await this.down()
    } catch {
      // Stopping must never fail on this.
    }
  }

  private remember(value: MultipathState): MultipathState {
    this.cached = { at: Date.now(), value }
    return value
  }

  private async queryStatus(): Promise<MultipathState> {
    const result = await run(HELPER_PATH, ['status'], STATUS_TIMEOUT_MS)
    if (result.code === 127) {
      return this.remember({ available: false, on: false, links: [], pins: 0 })
    }
    const output = lastJsonLine(result.stdout)
    if (result.code !== 0 || !output) {
      return this.remember({
        available: true,
        on: false,
        links: [],
        pins: 0,
        error: output?.error || result.stderr.trim() || 'the system-wide helper did not answer'
      })
    }
    return this.remember({
      available: true,
      on: output.up === true,
      links: Array.isArray(output.links) ? output.links : [],
      pins: Number(output.pins) || 0,
      error: output.error || undefined
    })
  }

  private async mutate(action: 'up' | 'down'): Promise<MultipathState> {
    // `sudo -n` never prompts: without the sudoers rule this fails immediately, and the
    // error below is what the panel shows.
    const result = await run('sudo', ['-n', HELPER_PATH, action], MUTATION_TIMEOUT_MS)
    if (result.code === 127) {
      // No sudo, or no helper at that path: both mean "not installed".
      return this.remember({
        available: false,
        on: false,
        links: [],
        pins: 0,
        error: SETUP_HINT
      })
    }

    const output = lastJsonLine(result.stdout)
    const stderr = result.stderr.trim()
    if (result.code !== 0 || !output || output.ok === false) {
      const refuses =
        /password is required|no tty|a terminal is required|not allowed/i.test(stderr) ||
        /password is required|not allowed/i.test(output?.error ?? '')
      return this.remember({
        available: true,
        on: false,
        links: output?.links ?? this.cached?.value.links ?? [],
        pins: output?.pins ?? 0,
        error: refuses
          ? SETUP_HINT
          : output?.error || stderr || `the helper failed (${result.code})`
      })
    }

    return this.remember({
      available: true,
      on: output.up === true,
      links: Array.isArray(output.links) ? output.links : [],
      pins: Number(output.pins) || 0,
      error: output.error || undefined
    })
  }
}
