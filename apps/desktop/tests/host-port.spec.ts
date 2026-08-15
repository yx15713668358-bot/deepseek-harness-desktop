import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPortStore, isPortFree, PORT_STORE_FILE } from '../src/host-port.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-port-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Bind a probe listener and report its OS-assigned port. */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('probe server returned no port'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise((accept) => { server.close(() => accept()) }),
      })
    })
  })
}

describe('desktop Host port store', () => {
  it('reads nothing when no store file exists', () => {
    const store = createPortStore(makeTempDir())
    expect(store.read()).toBeUndefined()
  })

  it('round-trips a written port', () => {
    const dir = makeTempDir()
    const store = createPortStore(dir)
    store.write(42_637)
    expect(store.read()).toBe(42_637)
  })

  it('treats malformed JSON as absent', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, PORT_STORE_FILE), 'not json')
    expect(createPortStore(dir).read()).toBeUndefined()
  })

  it.each([
    '{"port":"42637"}',
    '{"port":0}',
    '{"port":65536}',
    '{"port":42.5}',
    '{}',
    'null',
  ])('treats an invalid stored value as absent: %s', (contents) => {
    const dir = makeTempDir()
    writeFileSync(join(dir, PORT_STORE_FILE), contents)
    expect(createPortStore(dir).read()).toBeUndefined()
  })
})

describe('desktop Host port probing', () => {
  it('reports a free port as free', async () => {
    const probe = await occupyPort()
    const port = probe.port
    await probe.close()
    await expect(isPortFree(port)).resolves.toBe(true)
  })

  it('reports an occupied port as taken', async () => {
    const probe = await occupyPort()
    try {
      await expect(isPortFree(probe.port)).resolves.toBe(false)
    } finally {
      await probe.close()
    }
  })
})
