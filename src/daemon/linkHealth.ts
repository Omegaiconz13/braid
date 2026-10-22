/**
 * Link health: is each uplink actually carrying TCP right now?
 *
 * ICMP lies. The campus Wi-Fi that started this project answered pings in 2 ms and still
 * dropped half of the packets under load; a bulk TCP flow over it collapsed while `ping`
 * looked perfect. These probes are therefore TCP handshakes — connect to a public anycast
 * address, then close — bound to the network's own IPv4 address, the same way the engine
 * binds its chunk connections. A completed handshake proves the path can carry a TCP flow
 * in both directions, and its duration is the round trip the engine's next connection sees.
 *
 * The monitor keeps a short sliding window per network and classifies it:
 *
 *   good      no recent failures, round trip under 400 ms
 *   degraded  some failures, or a slow path — usable, but not trusted with more
 *   dead      three failures in a row, or no success in the window
 *   unknown   not enough probes yet (the first seconds after a link appears)
 *
 * System-wide mode uses the classification as weights: good links get three shares of new
 * flows, degraded one, dead none. `plexo-ctl testLinks` runs a burst on demand for the
 * panel's "Test links" button.
 */
import { connect } from 'node:net'

/** Anycast addresses with a TCP listener on 443. Overridable for tests
 * (PLEXO_PROBE_HOSTS="10.0.0.1,10.0.0.2"). */
export function probeHosts(): string[] {
  const override = process.env['PLEXO_PROBE_HOSTS']
  const hosts = (override ? override.split(',') : ['1.1.1.1', '8.8.8.8'])
    .map((host) => host.trim())
    .filter((host) => host !== '')
  return hosts.length > 0 ? hosts : ['1.1.1.1']
}

export const PROBE_PORT = 443
export const PROBE_TIMEOUT_MS = 2500
/** One round (every host, every network) this often. */
export const PROBE_INTERVAL_MS = 10_000
/** Attempts kept per network: six is three rounds, enough to see a streak. */
export const WINDOW_ATTEMPTS = 6
/** A handshake slower than this reads as a degraded path even without loss. */
export const SLOW_RTT_MS = 400

export type LinkState = 'good' | 'degraded' | 'dead' | 'unknown'

export interface LinkAttempt {
  ok: boolean
  /** TCP handshake time in ms; null when the attempt failed. */
  rttMs: number | null
  at: number
}

export interface LinkHealth {
  id: string
  state: LinkState
  /** Median handshake time of the successful attempts in the window. */
  rttMs: number | null
  /** Failed attempts / all attempts, 0..100. */
  lossPct: number
  /** 0..100: success rate with a latency penalty. Shown, and used to weigh links. */
  score: number
  attempts: number
  checkedAt: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** The pure part: one window of attempts -> what the panel shows and the router uses. */
export function classifyAttempts(
  attempts: LinkAttempt[],
  now = Date.now()
): Omit<LinkHealth, 'id'> {
  const ok = attempts.filter((attempt) => attempt.ok && attempt.rttMs !== null)
  const lossPct =
    attempts.length === 0 ? 0 : Math.round(((attempts.length - ok.length) / attempts.length) * 100)
  const rttMs = median(ok.map((attempt) => attempt.rttMs as number))
  let streak = 0
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i]!.ok) break
    streak += 1
  }
  const state: LinkState =
    attempts.length === 0
      ? 'unknown'
      : streak >= 3 || (attempts.length >= 3 && ok.length === 0)
        ? 'dead'
        : lossPct >= 15 || (rttMs !== null && rttMs > SLOW_RTT_MS)
          ? 'degraded'
          : 'good'
  const latency =
    rttMs === null ? 0 : Math.max(0.15, Math.min(1, 1 - (rttMs - 40) / (SLOW_RTT_MS * 1.9)))
  const score =
    attempts.length === 0 ? 100 : Math.round((ok.length / attempts.length) * latency * 100)
  return { state, rttMs, lossPct, score, attempts: attempts.length, checkedAt: now }
}

/** How many shares of new flows a link gets. Dead links leave the route entirely;
 * unknown ones start neutral instead of being punished. */
export function weightFor(health: Pick<LinkHealth, 'state'>): number {
  if (health.state === 'dead') return 0
  if (health.state === 'good') return 3
  return 1
}

/** The shares to install, or null when the route should be left alone: fewer than
 * two links (weights cannot matter), no verdict yet, or every link dead (excluding
 * all of them would blackhole the machine; the helper's own fallback keeps them). */
export function weightsFor(links: LinkHealth[]): Map<string, number> | null {
  if (links.length < 2) return null
  if (links.every((link) => link.state === 'unknown')) return null
  const desired = new Map(links.map((link) => [link.id, weightFor(link)] as const))
  if ([...desired.values()].every((weight) => weight === 0)) return null
  return desired
}

function probeTcp(
  localAddress: string,
  host: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    let settled = false
    const socket = connect({ host, port: PROBE_PORT, localAddress })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok ? Math.max(1, Math.round(performance.now() - started)) : null)
    }
    // A connect that has not answered in one handshake's worth of time is not a
    // working path for the engine's next connection either.
    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export interface ProbeNetwork {
  id: string
  /** The network's IPv4 address; probes bind it, as the engine's connections do. */
  address: string | null
}

export class LinkHealthMonitor {
  private attempts = new Map<string, LinkAttempt[]>()
  private networks: ProbeNetwork[] = []
  private timer: NodeJS.Timeout | null = null
  private busy = new Set<string>()

  /** Links came or went: forget the ones that are gone, so a re-plugged device
   * starts from a clean window instead of inheriting its old verdict. */
  setNetworks(networks: ProbeNetwork[]): void {
    this.networks = networks
    for (const id of [...this.attempts.keys()]) {
      if (!networks.some((network) => network.id === id)) this.attempts.delete(id)
    }
  }

  start(): void {
    if (this.timer) return
    void this.round()
    this.timer = setInterval(() => void this.round(), PROBE_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One round: every probe host on every network, in parallel. */
  async round(): Promise<void> {
    await Promise.all(this.networks.map((network) => this.probeNetwork(network)))
  }

  /** Three rounds back to back: enough for the panel to say good/degraded/dead now. */
  async testNow(): Promise<LinkHealth[]> {
    for (let i = 0; i < 3; i++) await this.round()
    return this.snapshot()
  }

  snapshot(): LinkHealth[] {
    return this.networks.map((network) => this.healthOf(network.id))
  }

  healthOf(id: string): LinkHealth {
    return { id, ...classifyAttempts(this.attempts.get(id) ?? []) }
  }

  private async probeNetwork(network: ProbeNetwork): Promise<void> {
    if (!network.address || this.busy.has(network.id)) return
    this.busy.add(network.id)
    const at = Date.now()
    try {
      const results = await Promise.all(
        probeHosts().map((host) => probeTcp(network.address as string, host))
      )
      const window = this.attempts.get(network.id) ?? []
      for (const rttMs of results) window.push({ ok: rttMs !== null, rttMs, at })
      while (window.length > WINDOW_ATTEMPTS) window.shift()
      this.attempts.set(network.id, window)
    } finally {
      this.busy.delete(network.id)
    }
  }
}
