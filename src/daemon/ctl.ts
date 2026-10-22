#!/usr/bin/env node
/**
 * `plexo-ctl` — the command-line face of the daemon. One-shot calls print the JSON result;
 * `plexo-ctl watch` streams status ticks and download updates, one JSON object per line, which
 * is what the Omarchy bar widget reads.
 *
 *   plexo-ctl status
 *   plexo-ctl start '{"url":"https://example.com/big.iso"}'
 *   plexo-ctl pause '{"id":"…"}'
 *   plexo-ctl watch
 */
import { connect } from 'node:net'
import { LineBuffer, encodeLine, socketPath, type DaemonResponse } from './protocol'

const HELP = `plexo-ctl — talk to the Plexo daemon

Usage:
  plexo-ctl status                 Everything the bar shows, as one JSON object
  plexo-ctl <method> [json]        Call a daemon method and print its JSON result
  plexo-ctl watch                  Stream status ticks and events (one JSON per line)
  plexo-ctl --help

Methods: status, networks, downloadList, history, clearHistory, settings, updateSettings,
         probe, start, pause, resume, cancel, remove, setNetwork, relink, reveal, openDownload,
         torrentFiles, chooseTorrentFiles, networkUsage, resetNetworkUsage, freeSpace,
         multipath, testLinks, shutdown

Examples:
  plexo-ctl start '{"url":"https://example.com/ubuntu.iso"}'
  plexo-ctl updateSettings '{"speedLimit":5000000}'
  plexo-ctl setNetwork '{"id":"…","networkId":"wlp1s0","enabled":false}'
  plexo-ctl multipath '{"action":"on"}'    # all apps across every live uplink (needs the
                                           # root helper from packaging/omarchy/install.sh)
`

function noDaemon(): never {
  process.stderr.write(
    `The Plexo daemon is not running (no socket at ${socketPath()}).\n` +
      'Start it with: systemctl --user start plexo-daemon\n'
  )
  process.exit(1)
}

function call(method: string, params: unknown): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath())
    const lines = new LineBuffer()
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(encodeLine({ id: 1, method, params })))
    socket.on('data', (chunk: string) => {
      for (const value of lines.push(chunk)) {
        const response = value as DaemonResponse
        if (response.id !== 1) continue
        socket.end()
        resolve(response)
      }
    })
  })
}

function watch(): void {
  const socket = connect(socketPath())
  const lines = new LineBuffer()
  socket.setEncoding('utf8')
  socket.on('error', () => noDaemon())
  socket.on('connect', () => socket.write(encodeLine({ id: 0, method: 'status' })))
  socket.on('data', (chunk: string) => {
    for (const value of lines.push(chunk)) {
      // The one-off answer to the priming call and its event twin are both printed; clients
      // key off `event`, scripts can ignore it.
      process.stdout.write(`${JSON.stringify(value)}\n`)
    }
  })
  // Print nothing else: output is a stream of JSON lines and nothing more.
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (command === 'watch') return watch()

  let params: unknown
  if (rest[0] !== undefined) {
    try {
      params = JSON.parse(rest[0])
    } catch (error) {
      process.stderr.write(`Parameters must be JSON: ${String(error)}\n`)
      process.exit(2)
    }
  }
  const timeout = setTimeout(() => {
    process.stderr.write('The daemon did not answer in time.\n')
    process.exit(1)
  }, 15_000)
  timeout.unref()
  const response = await call(command, params).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') noDaemon()
    throw error
  })
  clearTimeout(timeout)
  if (!response.ok) {
    process.stderr.write(`${response.error ?? 'The daemon refused the call'}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(response.result ?? null)}\n`)
}

// A reader that closes early (a widget restart, a consumer that stopped
// reading) is not an error worth a stack trace: stop writing and exit quietly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
