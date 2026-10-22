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
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Overridable so tests (and the repository's own runs) can point at a stub. */
export const HELPER_PATH =
  process.env['PLEXO_MULTIPATH_HELPER'] ?? '/usr/local/libexec/plexo-multipath'

const STATUS_TIMEOUT_MS = 8000
const MUTATION_TIMEOUT_MS = 25000
const CACHE_MS = 4000
/** Without the sudoers rule, do not ask again for this long after a refusal. */
const REFUSED_RETRY_MS = 5 * 60_000

/** Where the daemon writes the link-health weights the helper's `weights` verb reads.
 * The helper runs as root and finds the calling user's home through SUDO_USER, so
 * the path is fixed relative to the home directory. */
export function weightsFilePath(): string {
  return join(homedir(), '.cache', 'plexo', 'multipath-weights')
}

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

/** First non-empty error message in the text, or a fallback. */
function errorMessage(text: string, fallback: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .pop() ?? fallback
  )
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
  private weightsRefusedUntil = 0

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

  /** The uplinks `up` would install right now, without privileges. Null when the
   * helper cannot answer (missing, or no uplink found): callers should then
   * proceed with `up` anyway so the refusal surfaces as state the panel shows. */
  async plan(): Promise<MultipathLink[] | null> {
    const result = await run(HELPER_PATH, ['plan'], STATUS_TIMEOUT_MS)
    if (result.code !== 0) return null
    const output = lastJsonLine(result.stdout)
    return Array.isArray(output?.links) ? output.links : null
  }

  /** True when these are the same links, gateway for gateway, as the other list:
   * device set and each device's via. Weight is not compared — `up` always
   * installs equal weights, and the health pass re-weights separately. */
  static sameLinks(a: MultipathLink[], b: MultipathLink[]): boolean {
    const key = (links: MultipathLink[]): Map<string, string> =>
      new Map(links.map((link) => [link.dev, String(link.via ?? '')]))
    const first = key(a)
    const second = key(b)
    if (first.size !== second.size) return false
    for (const [dev, via] of first) {
      if (!second.has(dev) || second.get(dev) !== via) return false
    }
    return true
  }

  /** Write the desired per-device shares for the `weights` verb. Written first,
   * then applied: the helper never reads a half-written file. */
  async writeWeights(weights: Map<string, number>): Promise<void> {
    const file = weightsFilePath()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const lines = [...weights.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dev, weight]) => `${dev} ${weight}\n`)
    await writeFile(tmp, lines.join(''), { mode: 0o644 })
    await rename(tmp, file)
  }

  /** Re-weight the live multipath default without disturbing pinned connections. */
  async applyWeights(): Promise<MultipathState> {
    if (Date.now() < this.weightsRefusedUntil) {
      return this.cached?.value ?? { available: true, on: false, links: [], pins: 0 }
    }
    const state = await this.mutate('weights')
    if (state.error === SETUP_HINT) this.weightsRefusedUntil = Date.now() + REFUSED_RETRY_MS
    return state
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
      // A failed read must not read as "the mode is off": the route may well be
      // live, and callers act on `on` (the panel toggles, the daemon decides
      // whether to re-`up`). Keep the last known state and attach the error.
      const previous = this.cached?.value
      return this.remember({
        available: true,
        on: previous?.on ?? false,
        links: previous?.links ?? [],
        pins: previous?.pins ?? 0,
        error: output?.error || errorMessage(result.stderr, 'the system-wide helper did not answer')
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

  private async mutate(action: 'up' | 'down' | 'weights'): Promise<MultipathState> {
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
    const stderr = errorMessage(result.stderr, '')
    if (result.code !== 0 || !output || output.ok === false) {
      const refuses =
        /password is required|no tty|a terminal is required|not allowed/i.test(result.stderr) ||
        /password is required|not allowed/i.test(output?.error ?? '')
      return this.remember({
        available: true,
        // A refused call must not read as a mode change: the route is whatever
        // it was, and the panel's switch follows real state, not the attempt.
        on: output?.up === true ? true : (this.cached?.value.on ?? false),
        links: output?.links ?? this.cached?.value.links ?? [],
        pins: output?.pins ?? this.cached?.value.pins ?? 0,
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
