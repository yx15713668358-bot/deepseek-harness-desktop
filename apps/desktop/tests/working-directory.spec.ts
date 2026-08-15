import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkingDirectoryStore,
  resolveWorkingDirectory,
  WORKING_DIRECTORY_STORE_FILE,
} from '../src/working-directory.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-working-directory-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('desktop working-directory store', () => {
  it('reads nothing when no store file exists', () => {
    const store = createWorkingDirectoryStore(makeTempDir())
    expect(store.read()).toBeUndefined()
  })

  it('round-trips a written directory', () => {
    const dir = makeTempDir()
    const store = createWorkingDirectoryStore(dir)
    const chosen = makeTempDir()
    store.write(chosen)
    expect(store.read()).toBe(chosen)
  })

  it('treats malformed JSON as absent', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, WORKING_DIRECTORY_STORE_FILE), 'not json')
    expect(createWorkingDirectoryStore(dir).read()).toBeUndefined()
  })

  it.each([
    '{"directory":42}',
    '{"directory":""}',
    '{"directory":null}',
    '{}',
    'null',
  ])('treats an invalid stored value as absent: %s', (contents) => {
    const dir = makeTempDir()
    writeFileSync(join(dir, WORKING_DIRECTORY_STORE_FILE), contents)
    expect(createWorkingDirectoryStore(dir).read()).toBeUndefined()
  })
})

describe('desktop working-directory resolution', () => {
  it('returns the persisted directory while it still exists', () => {
    const store = createWorkingDirectoryStore(makeTempDir())
    const chosen = makeTempDir()
    store.write(chosen)
    expect(resolveWorkingDirectory(store, '/fallback')).toBe(chosen)
  })

  it('falls back when no directory was persisted', () => {
    const store = createWorkingDirectoryStore(makeTempDir())
    expect(resolveWorkingDirectory(store, '/fallback')).toBe('/fallback')
  })

  it('falls back when the persisted directory no longer exists', () => {
    const store = createWorkingDirectoryStore(makeTempDir())
    const removed = makeTempDir()
    store.write(removed)
    rmSync(removed, { recursive: true, force: true })
    expect(resolveWorkingDirectory(store, '/fallback')).toBe('/fallback')
  })

  it('falls back when the persisted path names a regular file', () => {
    const dir = makeTempDir()
    const file = join(dir, 'regular-file')
    writeFileSync(file, '')
    const store = createWorkingDirectoryStore(makeTempDir())
    store.write(file)
    expect(resolveWorkingDirectory(store, '/fallback')).toBe('/fallback')
  })

  it('accepts a persisted nested directory that exists', () => {
    const dir = makeTempDir()
    const nested = join(dir, 'nested')
    mkdirSync(nested)
    const store = createWorkingDirectoryStore(makeTempDir())
    store.write(nested)
    expect(resolveWorkingDirectory(store, '/fallback')).toBe(nested)
  })
})
