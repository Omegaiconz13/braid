/**
 * The daemon's control wire: one JSON object per line over a Unix socket, so the Omarchy
 * plugin, `plexo-ctl` and anything scriptable talk to the same running engine.
 *
 *   request  {"id":1,"method":"status"}
 *   response {"id":1,"ok":true,"result":{…}}
 *   event    {"event":"downloadUpdated","data":{…}}
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface DaemonRequest {
  id?: number | string
  method: string
  params?: unknown
}

export interface DaemonResponse {
  id?: number | string
  ok: boolean
  result?: unknown
  error?: string
}

export type DaemonEventName =
  'status' | 'downloadUpdated' | 'networksChanged' | 'historyChanged' | 'hello'

export interface DaemonEvent {
  event: DaemonEventName
  data?: unknown
}

/** One download as the bar and panel need it: the fields a status tick carries, without the
 * per-block detail a full DownloadUpdate has. */
export interface DownloadSummary {
  id: string
  kind: 'http' | 'torrent'
  fileName: string
  status: string
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  timeLeftSeconds?: number
  queuedAt?: number
  error?: string
  resumable?: boolean
  destinationPath: string
  folder?: boolean
  networks: {
    id: string
    label: string
    kind: string
    enabled: boolean
    status: string
    speedBytesPerSec: number
    bytesDownloaded: number
  }[]
}

export interface DaemonStatus {
  daemon: { pid: number; uptimeMs: number; socket: string; clients: number }
  deviceBinding: boolean
  networks: {
    id: string
    device: string
    displayName: string
    kind: string
    addresses: { address: string; family: number }[]
  }[]
  /** Per-network choices kept in the app's settings (custom name, off, limits), so the panel
   * can toggle a network without keeping a second copy. */
  networkPreferences: Record<string, unknown>
  /** System-wide mode (all apps' traffic across every live uplink); see daemon/systemWide.ts. */
  systemWide: {
    available: boolean
    on: boolean
    links: { dev: string; via?: string; src?: string; weight?: number | string }[]
    pins: number
    error?: string
  }
  /** Per-network TCP health from the daemon's own probes (daemon/linkHealth.ts):
   * what the panel's dot shows and what system-wide weights are derived from. */
  health: {
    id: string
    state: 'good' | 'degraded' | 'dead' | 'unknown'
    /** Median TCP handshake time in ms; null until a probe succeeds. */
    rttMs: number | null
    /** Failed probes / all probes in the window, 0..100. */
    lossPct: number
    /** 0..100: success rate with a latency penalty. */
    score: number
    attempts: number
    checkedAt: number
  }[]
  downloads: DownloadSummary[]
  /** Download here means the daemon: bytes a second over every running download. */
  speedBytesPerSec: number
  /** The whole machine this second: live traffic over every connected network — all apps, not
   * only oma-plexo's downloads — with the same reading split per network. */
  throughput: {
    rxBytesPerSec: number
    txBytesPerSec: number
    networks: { id: string; rxBytesPerSec: number; txBytesPerSec: number }[]
  }
}

/** `$XDG_RUNTIME_DIR/plexo-daemon-<uid>.sock`, or PLEXO_SOCKET when set (tests use a private
 * path so a real daemon is never disturbed). */
export function socketPath(): string {
  const override = process.env['PLEXO_SOCKET']
  if (override) return override
  const runtime = process.env['XDG_RUNTIME_DIR'] ?? tmpdir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join(runtime, `plexo-daemon-${uid}.sock`)
}

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** Splits a byte stream into the JSON values in it; one instance per connection. */
export class LineBuffer {
  private rest = ''
  /** A line longer than this is no client of ours; drop it rather than grow. */
  private static readonly MAX_LINE = 1024 * 1024

  push(chunk: string): unknown[] {
    this.rest += chunk
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    if (this.rest.length > LineBuffer.MAX_LINE) this.rest = ''
    const values: unknown[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        values.push(JSON.parse(trimmed))
      } catch {
        // A malformed line is dropped rather than killing the connection.
      }
    }
    return values
  }
}
