/** Loopback port persistence and availability probing for the desktop Host. */

import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const PORT_STORE_FILE = 'desktop-host-port.json'

/** Durable record of the loopback port a ready Host last bound. */
export interface PortStore {
  /** Read the last known Host port, when a valid one was persisted. */
  read(): number | undefined
  /** Persist the port a ready Host bound. */
  write(port: number): void
}

/**
 * Create the Host port store rooted at one user-data directory.
 * @param userDataDir - Electron's per-app user data directory.
 * @returns A store that silently treats any unreadable state as absent.
 */
export function createPortStore(userDataDir: string): PortStore {
  const file = join(userDataDir, PORT_STORE_FILE)
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const port = (parsed as { port?: unknown }).port
        return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
      } catch {
        // Missing, unreadable, or malformed store means no known port: the caller falls back to an OS-assigned one.
        return undefined
      }
    },
    write(port) {
      writeFileSync(file, `${JSON.stringify({ port }, null, 2)}\n`)
    },
  }
}

/**
 * Whether a TCP port is currently free to bind on the loopback interface.
 * @param port - Candidate port, previously validated as 1-65535.
 * @returns True when a transient probe server bound the port and released it.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => {
      // The bind raced another listener: the port is taken.
      resolve(false)
    })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}
