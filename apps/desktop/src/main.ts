/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import { createPortStore, isPortFree, type PortStore } from './host-port.ts'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { createWorkingDirectoryStore, resolveWorkingDirectory, type WorkingDirectoryStore } from './working-directory.ts'
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'

const APP_NAME = 'DeepSeek Harness'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..')
const GLOBAL_SHORTCUT = 'CommandOrControl+Shift+D'
const RESTART_BASE_DELAY_MS = 1_000
const RESTART_MAX_DELAY_MS = 30_000
const HOST_LOG_MAX_BYTES = 1_000_000

/** Supervised Host lifecycle state shown in the tray menu. */
type HostState = 'starting' | 'running' | 'restarting' | 'stopped'

const HOST_STATE_LABELS: Readonly<Record<HostState, string>> = {
  starting: '后端状态：启动中…',
  running: '后端状态：运行中',
  restarting: '后端状态：重连中…',
  stopped: '后端状态：已停止',
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let host: HostSupervisor | undefined
let lifecycle: DesktopLifecycle | undefined
let hostOrigin: string | undefined
let hostCwd: string | undefined
let hostState: HostState = 'stopped'
let bootQuitPromise: Promise<void> | undefined
let quitReleased = false
let restartTimer: ReturnType<typeof setTimeout> | undefined
let restartDelayMs = RESTART_BASE_DELAY_MS
let autoRestart = false
let portStore: PortStore | undefined
let workingDirStore: WorkingDirectoryStore | undefined
let hostLogger: (chunk: string) => void = chunk => process.stderr.write(chunk)

/** The working-directory preference store, created on first use. */
function hostWorkingDirectoryStore(): WorkingDirectoryStore {
  workingDirStore ??= createWorkingDirectoryStore(app.getPath('userData'))
  return workingDirStore
}

/** Resolve artifacts from the checkout in development and resourcesPath when packaged. */
function hostPaths(): { nodeExecutable: string; cliEntry: string; cwd: string; electronRunAsNode: boolean } {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(REPOSITORY_ROOT, 'apps/cli/lib/bin.js'),
      cwd: resolveWorkingDirectory(hostWorkingDirectoryStore(), process.cwd()),
      electronRunAsNode: false,
    }
  }
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(process.resourcesPath, 'host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    cwd: resolveWorkingDirectory(hostWorkingDirectoryStore(), app.getPath('home')),
    electronRunAsNode: true,
  }
}

function assertHostArtifacts(paths: ReturnType<typeof hostPaths>): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`desktop Host entry is missing: ${paths.cliEntry}; run pnpm run build first`)
  }
}

/** Load the app-local tray template, with an empty fallback for incomplete staging. */
function trayImage(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'desktop-resources/trayTemplate.png')]
    : [join(DESKTOP_DIR, 'resources/trayTemplate.png')]
  const path = candidates.find(candidate => existsSync(candidate))
  const image = path === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(path)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

/** Environment for the Host process, restoring tool PATHs when launched as a GUI app. */
function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP: '1' }
  // GUI-launched apps inherit a minimal PATH, and a user npm prefix lives
  // outside it. Restore both before the inherited entries so the Host's bash
  // tools and the marketplace's `dsh plugin` invocations can find them.
  const toolPathEntries = [
    join(homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/local/bin',
  ]
  const currentEntries = (env.PATH ?? '').split(':').filter(entry => entry !== '')
  env.PATH = [...new Set([...toolPathEntries, ...currentEntries])].join(':')
  return env
}

/** Sink Host output to a per-run log file plus the process stderr. */
function createHostLogger(): (chunk: string) => void {
  const file = join(app.getPath('userData'), 'host.log')
  try {
    // Each application run starts a fresh log; restarts within the run append.
    writeFileSync(file, '')
  } catch {
    // Unwritable log file degrades to stderr-only diagnostics.
    return chunk => process.stderr.write(chunk)
  }
  return (chunk) => {
    try {
      appendFileSync(file, chunk)
      // Past the cap, drop the oldest output: keep the trailing window only.
      if (statSync(file).size > HOST_LOG_MAX_BYTES) writeFileSync(file, '')
    } catch {
      // Logging must never disturb the Host; stderr still carries the chunk.
    }
    process.stderr.write(chunk)
  }
}

function isExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hasOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Install navigation and permission policy before the first renderer loads. */
function hardenSession(): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
}

async function createMainWindow(): Promise<BrowserWindow> {
  const origin = hostOrigin
  if (origin === undefined) throw new Error('desktop Host is not ready')
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: 44,
      },
    }),
    ...(process.platform === 'darwin' ? {
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
    } : {}),
    ...(process.platform === 'win32' ? {
      backgroundMaterial: 'acrylic' as const,
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    } : {
      transparent: true,
      backgroundColor: '#00000000',
    }),
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow = window
  window.on('close', (event) => { lifecycle?.onWindowClose(event) })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (hostOrigin !== undefined && hasOrigin(url, hostOrigin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const rendererUrl = new URL(origin)
  rendererUrl.searchParams.set('dsh-desktop-platform', process.platform)
  await window.loadURL(rendererUrl.href)
  if (!lifecycle?.isQuitting) window.show()
  return window
}

/** Reload the renderer onto a changed Host origin after a restart. */
async function navigateToHost(origin: string): Promise<void> {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  const rendererUrl = new URL(origin)
  rendererUrl.searchParams.set('dsh-desktop-platform', process.platform)
  await window.loadURL(rendererUrl.href)
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip(APP_NAME)
  tray.on('click', () => { void lifecycle?.showWindow() })
  rebuildTrayMenu()
}

/** Rebuild the tray menu for the current Host state and login-item setting. */
function rebuildTrayMenu(): void {
  if (tray === undefined) return
  const template: MenuItemConstructorOptions[] = [
    { label: '打开主窗口', click: () => { void lifecycle?.showWindow() } },
    { type: 'separator' },
    { label: HOST_STATE_LABELS[hostState], enabled: false },
    {
      label: '重启后端',
      enabled: hostState === 'running' || hostState === 'restarting',
      click: () => { void manualRestartHost() },
    },
    {
      label: '在浏览器打开',
      enabled: hostState === 'running' && hostOrigin !== undefined,
      click: () => { if (hostOrigin !== undefined) void shell.openExternal(hostOrigin) },
    },
    { type: 'separator' },
    {
      label: hostCwd === undefined ? '工作目录' : `工作目录：${hostCwd}`,
      enabled: false,
    },
    {
      label: '切换工作目录…',
      enabled: hostState === 'running' || hostState === 'restarting',
      click: () => { void chooseWorkingDirectory() },
    },
    { label: '打开日志目录', click: () => { void shell.openPath(app.getPath('userData')) } },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }) },
    },
    { type: 'separator' },
    { label: '退出', click: () => { void requestAppQuit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

/** Publish a Host state transition to the tray menu. */
function setHostState(state: HostState): void {
  if (hostState === state) return
  hostState = state
  rebuildTrayMenu()
}

/**
 * Persist a tray-chosen Host working directory and restart the Host on it.
 * The persisted choice becomes the default for every later launch; an
 * unchanged directory leaves the running Host untouched.
 */
async function chooseWorkingDirectory(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: '选择工作目录',
    ...(hostCwd === undefined ? {} : { defaultPath: hostCwd }),
    properties: ['openDirectory', 'createDirectory'],
  })
  const picked = result.filePaths[0]
  if (result.canceled || picked === undefined || picked === hostCwd) return
  hostWorkingDirectoryStore().write(picked)
  await manualRestartHost()
}

/**
 * Start one supervised Host generation on a loopback port.
 * @returns The readiness origin the supervisor parsed from the Host.
 */
async function startHost(): Promise<string> {
  const paths = hostPaths()
  const savedPort = portStore?.read()
  const port = savedPort !== undefined && await isPortFree(savedPort) ? savedPort : undefined
  hostCwd = paths.cwd
  host = createHostSupervisor({
    spawnHost: () => spawnDshWeb({ ...paths, ...(port === undefined ? {} : { port }), env: hostEnv() }),
    log: hostLogger,
    onUnexpectedExit: (detail) => {
      if (!autoRestart) return
      console.error(`desktop Host exited unexpectedly (code ${String(detail.code)}, signal ${String(detail.signal)})`)
      scheduleRestart()
    },
  })
  const origin = await host.start()
  portStore?.write(Number(new URL(origin).port))
  return origin
}

/** Schedule one supervised restart with exponential backoff. */
function scheduleRestart(): void {
  if (restartTimer !== undefined) return
  setHostState('restarting')
  restartTimer = setTimeout(() => {
    restartTimer = undefined
    void restartHost()
  }, restartDelayMs)
  restartDelayMs = Math.min(restartDelayMs * 2, RESTART_MAX_DELAY_MS)
}

/** Restart the Host after an unexpected exit; recoveries reset the backoff. */
async function restartHost(): Promise<void> {
  if (!autoRestart) return
  try {
    const origin = await startHost()
    restartDelayMs = RESTART_BASE_DELAY_MS
    setHostState('running')
    if (origin !== hostOrigin) {
      hostOrigin = origin
      await navigateToHost(origin)
    }
  } catch (error) {
    console.error('desktop Host restart failed:', error)
    scheduleRestart()
  }
}

/** Gracefully replace the running Host on tray request. */
async function manualRestartHost(): Promise<void> {
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer)
    restartTimer = undefined
  }
  setHostState('starting')
  const current = host
  try {
    if (current !== undefined) await current.shutdown()
    const origin = await startHost()
    restartDelayMs = RESTART_BASE_DELAY_MS
    setHostState('running')
    if (origin !== hostOrigin) {
      hostOrigin = origin
      await navigateToHost(origin)
    }
  } catch (error) {
    console.error('desktop Host manual restart failed:', error)
    if (autoRestart) scheduleRestart()
  }
}

/** Register the global show-window accelerator once after boot. */
function registerGlobalShortcut(): void {
  const registered = globalShortcut.register(GLOBAL_SHORTCUT, () => { void lifecycle?.showWindow() })
  if (!registered) console.error(`failed to register global shortcut ${GLOBAL_SHORTCUT}`)
}

function releaseAppQuit(): void {
  quitReleased = true
  tray?.destroy()
  tray = undefined
  app.quit()
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('desktop shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  const paths = hostPaths()
  assertHostArtifacts(paths)
  portStore = createPortStore(app.getPath('userData'))
  hostLogger = createHostLogger()
  autoRestart = true
  hardenSession()
  lifecycle = createDesktopLifecycle({
    getWindow: () => mainWindow,
    createWindow: createMainWindow,
    disposeHost: async () => {
      autoRestart = false
      if (restartTimer !== undefined) clearTimeout(restartTimer)
      setHostState('stopped')
      await host?.shutdown()
    },
    quit: releaseAppQuit,
    reportError: (error) => { console.error('desktop shutdown failed:', error) },
  })
  createTray()
  setHostState('starting')
  hostOrigin = await startHost()
  setHostState('running')
  registerGlobalShortcut()
  await lifecycle.showWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { void lifecycle?.showWindow() })
  app.on('activate', () => { void lifecycle?.showWindow() })
  app.on('window-all-closed', () => {
    // Tray and Host own application lifetime on every platform.
  })
  app.on('will-quit', () => { globalShortcut.unregisterAll() })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    console.error('desktop startup failed:', error)
    if (bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await requestAppQuit()
  })
}
