/**
 * The Unix-socket control server: dispatches requests to the daemon's handlers and pushes
 * events (status ticks, download updates, network changes) to every connected client.
 */
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  encodeLine,
  LineBuffer,
  type DaemonEventName,
  type DaemonRequest,
  type DaemonResponse
} from './protocol'

export type DaemonHandler = (params: unknown) => unknown | Promise<unknown>

export class ControlServer {
  private server: Server | null = null
  private readonly clients = new Set<Socket>()

  constructor(private readonly handlers: Record<string, DaemonHandler>) {}

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // A socket file left by a dead daemon: net will refuse to listen on it otherwise.
      try {
        rmSync(path, { force: true })
      } catch {
        // Force-remove failed: listen's own error reports the real problem.
      }
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        server.on('error', (error) => console.error('[plexo-daemon] control socket error', error))
        try {
          // The socket exposes download control: keep it to this user.
          chmodSync(path, 0o600)
        } catch {
          // Best-effort: XDG_RUNTIME_DIR is already private.
        }
        this.server = server
        resolve()
      })
    })
  }

  get clientCount(): number {
    return this.clients.size
  }

  private accept(socket: Socket): void {
    this.clients.add(socket)
    const lines = new LineBuffer()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const value of lines.push(chunk)) void this.dispatch(socket, value)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.clients.delete(socket))
  }

  private async dispatch(socket: Socket, value: unknown): Promise<void> {
    const request = value as DaemonRequest
    if (!request || typeof request.method !== 'string') return
    const reply = (response: DaemonResponse): void => {
      if (!socket.destroyed) socket.write(encodeLine(response))
    }
    const handler = this.handlers[request.method]
    if (!handler) {
      reply({ id: request.id, ok: false, error: `Unknown method: ${request.method}` })
      return
    }
    try {
      reply({ id: request.id, ok: true, result: await handler(request.params) })
    } catch (error) {
      // Logged with its stack: the wire only carries the message, which some errors leave empty.
      console.error(`[plexo-daemon] ${request.method} failed`, error)
      reply({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  broadcast(event: DaemonEventName, data?: unknown): void {
    if (this.clients.size === 0) return
    const line = encodeLine({ event, data })
    for (const client of this.clients) if (!client.destroyed) client.write(line)
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) client.end()
      this.clients.clear()
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
  }
}
