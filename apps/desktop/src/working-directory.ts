/** Durable Host working-directory preference for the desktop application. */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKING_DIRECTORY_STORE_FILE = 'desktop-working-directory.json'

/** Durable record of the working directory the user last chose for the Host. */
export interface WorkingDirectoryStore {
  /** Read the last chosen working directory, when a valid one was persisted. */
  read(): string | undefined
  /** Persist the working directory chosen for the Host. */
  write(directory: string): void
}

/**
 * Create the Host working-directory store rooted at one user-data directory.
 * @param userDataDir - Electron's per-app user data directory.
 * @returns A store that silently treats any unreadable state as absent.
 */
export function createWorkingDirectoryStore(userDataDir: string): WorkingDirectoryStore {
  const file = join(userDataDir, WORKING_DIRECTORY_STORE_FILE)
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const directory = (parsed as { directory?: unknown }).directory
        return typeof directory === 'string' && directory !== '' ? directory : undefined
      } catch {
        // Missing, unreadable, or malformed store means no preference: the caller falls back to the platform default.
        return undefined
      }
    },
    write(directory) {
      writeFileSync(file, `${JSON.stringify({ directory }, null, 2)}\n`)
    },
  }
}

/** Whether a path currently names an accessible directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the Host working directory: the persisted choice while it still
 * names a directory, otherwise the platform default.
 * @param store - The persisted working-directory preference.
 * @param fallback - Directory used when no usable preference exists.
 * @returns A directory that exists and can host the Host process.
 */
export function resolveWorkingDirectory(store: WorkingDirectoryStore, fallback: string): string {
  const saved = store.read()
  return saved !== undefined && isDirectory(saved) ? saved : fallback
}
