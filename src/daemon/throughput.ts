/**
 * The machine's live internet speed: per-network byte counters from sysfs, turned into rates.
 *
 * The daemon samples this on its status tick and the bar widget shows the total, so "the speed
 * of the internet" is real traffic over every connected network — Braid's downloads, browsers,
 * updates, everything — whether one link is up or five.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface NetworkThroughput {
  id: string
  rxBytesPerSec: number
  txBytesPerSec: number
}

export interface ThroughputSnapshot {
  rxBytesPerSec: number
  txBytesPerSec: number
  networks: NetworkThroughput[]
}

interface Counters {
  rx: number
  tx: number
}

export class ThroughputMeter {
  private readonly previous = new Map<string, Counters & { at: number }>()

  /** `/sys/class/net` on a real machine; tests point it at a fixture directory. */
  constructor(private readonly root = '/sys/class/net') {}

  /**
   * One reading: rates since the last call, per network and summed. A network seen for the
   * first time (or one whose counters were reset — a replug, a driver reload) reads 0; there
   * is nothing to measure the delta against yet.
   */
  sample(ids: readonly string[], now = Date.now()): ThroughputSnapshot {
    const networks: NetworkThroughput[] = []
    for (const id of ids) {
      // The ids come from our own monitor, but this path touches the filesystem: keep it
      // honest anyway.
      if (!/^[\w.-]+$/.test(id)) continue
      const counters = this.read(id)
      if (!counters) continue
      const before = this.previous.get(id)
      this.previous.set(id, { ...counters, at: now })
      const fresh =
        !before || now <= before.at || counters.rx < before.rx || counters.tx < before.tx
      if (fresh) {
        networks.push({ id, rxBytesPerSec: 0, txBytesPerSec: 0 })
        continue
      }
      const seconds = (now - before.at) / 1000
      networks.push({
        id,
        rxBytesPerSec: (counters.rx - before.rx) / seconds,
        txBytesPerSec: (counters.tx - before.tx) / seconds
      })
    }
    const wanted = new Set(ids)
    for (const id of this.previous.keys()) if (!wanted.has(id)) this.previous.delete(id)
    return {
      rxBytesPerSec: networks.reduce((sum, network) => sum + network.rxBytesPerSec, 0),
      txBytesPerSec: networks.reduce((sum, network) => sum + network.txBytesPerSec, 0),
      networks
    }
  }

  private read(id: string): Counters | null {
    try {
      return {
        rx: Number(readFileSync(join(this.root, id, 'statistics', 'rx_bytes'), 'utf8')),
        tx: Number(readFileSync(join(this.root, id, 'statistics', 'tx_bytes'), 'utf8'))
      }
    } catch {
      // A network that vanished between the monitor's list and this read: nothing to report.
      return null
    }
  }
}
