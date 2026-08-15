# Agent Note: 可配置的桌面端 Host 工作目录

Status: implemented

[English](2026-08-15-configurable-desktop-working-directory.md) | 中文

## 问题

桌面应用在打包模式下总是把 Host 子进程启动在 `app.getPath('home')`（开发模式为 `process.cwd()`）。工作目录不在主目录的用户，新会话与 shell 工具会扎根在一个他们并未选择的位置，应用内也没有任何修改途径：只能靠重启应用或改启动逻辑。用户选择的工作目录还需要一个可见入口，并且必须在应用重启后仍然保留。

## 决策

**新增与 Electron 无关的 `working-directory.ts` 模块持有持久化偏好。** `createWorkingDirectoryStore(userDataDir)` 把所选目录写入应用数据目录的 `desktop-working-directory.json`，读取语义与 Host 端口存储一致：缺失、不可读、格式损坏或非字符串状态一律视为不存在。`resolveWorkingDirectory(store, fallback)` 仅在持久化路径仍指向可访问目录时返回它，否则返回回退值——目录被删除或替换时降级，且不修改持久化状态。

**`hostPaths()` 通过该解析器决定 Host 的 cwd。** 开发模式回退到 `process.cwd()`，打包模式回退到 `app.getPath('home')`；两种模式都遵循同一持久化偏好，因此托盘入口在开发与打包运行中行为一致。存储通过 `hostWorkingDirectoryStore()` 在首次使用时惰性创建，根目录为 `app.getPath('userData')`。

**托盘菜单显示并切换工作目录。** 一个禁用的标签项显示当前 Host 世代实际生效的目录（`hostCwd`，由 `startHost()` 在拉起时记录）；启用的「切换工作目录…」入口调用 `dialog.showOpenDialog`，带 `openDirectory` 与 `createDirectory`。选择不同目录后先持久化，再复用 `manualRestartHost()`——既有的受监管重启会保留已绑定端口并重连或整页导航渲染进程——使切换立即生效。再次选择当前生效目录是空操作。切换入口与重启入口的启用条件完全一致——仅在运行中或重连中可用——因为切换总是经由一次重启生效。

## 曾考虑的替代方案

**在 Web UI 内做设置页。** 不采用：Host 的启动参数归桌面外壳所有，Web 客户端没有传递通道；托盘入口与既有的托盘生命周期一致，并且把改动范围保持在 `apps/desktop` 内。

**首次启动时弹窗询问目录。** 不采用：打断式向导为一个回退默认值已覆盖的偏好增加界面；托盘入口无需打断首次启动也能被发现。

**只持久化选择而不重启 Host。** 不采用：Host 的工作目录在拉起时即固定，既有手动重启路径已处理窗口与渲染进程恢复；推迟到下次启动生效会让切换看起来失效。

**路径消失时清除持久化条目。** 不采用：读取时校验即可回退且不动持久化状态，用户的上次选择在目录临时卸载或重建后仍能保留。

## 后果

Host 启动在用户上次选择的位置，选择跨重启保留；路径失效时回退到平台默认（打包为主目录，开发为启动目录）。切换目录的代价是一次受监管重启，复用[回环 Web supervisor](../architecture/2026-08-14-electron-loopback-web-supervisor.md)既有的端口持久化与渲染进程重连行为。`desktop-working-directory.json` 与 `desktop-host-port.json` 一样，成为应用数据目录中读取时校验的磁盘记录。单元覆盖位于 `apps/desktop/tests/working-directory.spec.ts`。
