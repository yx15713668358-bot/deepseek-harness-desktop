# Agent Note: Configurable desktop Host working directory

Status: implemented

English | [中文](2026-08-15-configurable-desktop-working-directory.zh.md)

## Problem

The desktop application always started its Host child in `app.getPath('home')` when packaged (and `process.cwd()` in development). Users who keep their work outside the home directory got new sessions and shell tools rooted somewhere they did not choose, with no way to change it inside the application: the only path was relaunching the app or editing the spawn logic. A working directory the user picks also needs a visible affordance and must survive application restarts.

## Decision

**A new Electron-independent `working-directory.ts` module owns the durable preference.** `createWorkingDirectoryStore(userDataDir)` persists the chosen directory to `desktop-working-directory.json` in the application data directory and reads it with the same tolerant semantics as the Host port store: missing, unreadable, malformed, or non-string state reads as absent. `resolveWorkingDirectory(store, fallback)` returns the persisted path only while it still names an accessible directory, otherwise the fallback, so a deleted or replaced directory degrades without mutating durable state.

**`hostPaths()` resolves the Host cwd through that resolver.** Development falls back to `process.cwd()`, packaged builds fall back to `app.getPath('home')`; both honor the same persisted preference, so the tray entry behaves identically in dev and packaged runs. The store is created lazily on first use via `hostWorkingDirectoryStore()`, rooted at `app.getPath('userData')`.

**The tray menu shows and switches the directory.** A disabled label displays the effective directory of the current Host generation (`hostCwd`, recorded by `startHost()` at spawn), and an enabled "切换工作目录…" entry opens `dialog.showOpenDialog` with `openDirectory` and `createDirectory`. Picking a different directory persists it and reuses `manualRestartHost()` — the existing supervised restart that keeps the bound port and reconnects or re-navigates the renderer — so the change takes effect immediately. Picking the effective directory again is a no-op. The picker entry is enabled exactly when the restart entry is — running or restarting — since the switch always rides a restart.

## Alternatives considered

**A settings page inside the Web UI.** Not adopted: the desktop shell owns the Host spawn options and the Web client has no channel for them; a tray entry matches the existing tray-owned application lifetime and keeps the change inside `apps/desktop`.

**Prompting for a directory on first launch.** Not adopted: an interrupting wizard adds surface for a preference the fallback default already covers; the tray entry remains discoverable without blocking first start.

**Persisting the choice without restarting the Host.** Not adopted: the Host's working directory is fixed at spawn, and the existing manual-restart path already handles window and renderer recovery; deferring the effect until the next launch would make the switch appear broken.

**Clearing the persisted entry when the path disappears.** Not adopted: read-time validation falls back without touching durable state, so the user's last choice survives a temporarily unmounted or recreated location.

## Consequences

The Host starts where the user last chose and the choice survives relaunches; a stale path falls back to the platform default (home when packaged, the launch directory in development). Switching directories costs one supervised restart that reuses the existing port-persistence and renderer-reconnect behavior from the [loopback Web supervisor](../architecture/2026-08-14-electron-loopback-web-supervisor.md). `desktop-working-directory.json` joins `desktop-host-port.json` as a validated-at-read on-disk record in the application data directory. Unit coverage lives in `apps/desktop/tests/working-directory.spec.ts`.
