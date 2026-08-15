# DSH 桌面端自我迭代指令

本文件是给 DSH agent 会话的迭代任务书。工作目录必须是本仓库根
`/Users/yuxuan/Documents/dsh`。每轮迭代按下面的规约执行。

## 硬性规约（每次都必须遵守）

1. **在独立分支上干活**：从最新 `master` 切 `iterate/<简短功能名>` 分支，禁止直接改 master。
2. **测试必须全过**：`pnpm --filter @deepseek-ai/dsh-desktop exec vitest run apps/desktop/tests`，任何改动都必须保持 56+ 全绿并补充新测试。
3. **类型检查必须过**：`pnpm --filter @deepseek-ai/dsh-desktop run typecheck`。
4. **遵循仓库 AGENTS.md 规范**：ESM、JSDoc、精确类型（exactOptionalPropertyTypes）、双语 README 同步。
5. **提交并推送**：完成一个功能后 commit（conventional commits，如 `feat(desktop): ...`），推送到 `origin master`（origin = https://github.com/yx15713668358-bot/deepseek-harness-desktop.git）。推送需要 `PATH="$HOME/bin:$PATH"`（pnpm shim）并带代理环境变量 `HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890`。
6. **改动范围**：优先只动 `apps/desktop/`；动 `apps/web/` 或 `packages/` 前先停下来向用户确认。
7. **不要动签名/公证相关配置**（用户无 Developer ID）。
8. **不装未经审查的第三方插件**；要装先读源码（网络走 127.0.0.1:7890 代理）。

## 当前架构速览

- `apps/desktop/src/main.ts`：Electron 主进程（托盘、重启调度、窗口、快捷键、自启、PATH、日志）。
- `apps/desktop/src/host-supervisor.ts`：Host 子进程监管（就绪解析、超时、SIGTERM→SIGKILL、进程组）。
- `apps/desktop/src/host-port.ts`：端口持久化与探测。
- `apps/desktop/src/window-lifecycle.ts`：窗口/退出生命周期。
- `apps/desktop/scripts/stage-runtime.ts`：打包时暂存 Host 生产依赖（deploy 前会临时摘除 dev-only patch 行）。
- Host 数据在 `~/.dsh`，与网页版共享；插件市场已装（`github:AwesomeHou/dsh-plugin-marketplace`）。

## 迭代候选池（按优先级，可自主选择或由用户指定）

1. 打包版工作目录改为可配置：默认从 `app.getPath('home')` 改为上次使用的工作目录（持久化到 userData），并在托盘菜单提供切换入口。
2. 托盘菜单"重启后端"后窗口无缝恢复验证与完善（当前端口不变则 UI 自动重连，端口变则整页导航）。
3. 桌面通知：Host 事件（长任务完成）通过 Electron Notification 提示（需要先调研 dsh 的 events 流如何暴露到主进程，可能走 /api/events.host WebSocket）。
4. 应用内"关于"面板：显示版本、Host 端口、日志路径、数据目录。
5. 崩溃报告：Host 连续 5 次拉起失败时，弹窗询问"重试/打开日志/退出"，而非无限静默重试。
6. 窗口尺寸/位置记忆（electron-window-state 或自实现 userData JSON）。
7. 全局快捷键可配置（托盘菜单或设置页）。
8. 首次启动向导：检测工作目录、推荐配置（连接现有 ~/.dsh、装插件市场）。
9. 性能：Host 日志写入从同步 IO 改异步批处理（防高频输出卡主进程）。
10. 与上游同步：`git fetch upstream && git merge upstream/master` 时解决冲突并跑全量测试。

## 每轮结束的汇报格式

- 做了什么（功能/修复 + commit hash）
- 测试与 typecheck 结果
- 剩余候选池状态
- 是否需要用户决策（是则停下提问）
