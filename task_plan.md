# Pi with ChatGPT 改造任务计划

## 1. 改造目标

将当前从 `codex-with-chatgpt` fork 而来的项目，改造成以 **Pi 作为本地执行 Agent、ChatGPT Web 作为规划与独立 Review 层** 的 `pi-with-chatgpt`。

目标原则：

- **ChatGPT thinks. Pi works.**
- ChatGPT 只通过只读 MCP 查看工作区，不拥有写文件、Shell、提交代码等能力。
- Pi 负责本地代码读取、修改、命令执行、测试、git 操作和修复。
- 编排状态机由 Pi Extension 管理，不再依赖超长 Skill 文本让 Agent “自觉”维持流程。
- 保留现有 Bridge / MCP / OAuth / Pairing / Workspace / Tunnel 安全架构。
- 优先最小改动跑通闭环，再逐步完成命名迁移和产品化。

目标闭环：

```text
User
  ↓
Pi with ChatGPT Extension
  ↓
ChatGPT PLAN
  ↓
Pi EXECUTE
  ↓
ChatGPT REVIEW
  ↓
Pi FIX（如需要）
  ↓
ChatGPT DONE
```

---

## 2. 当前仓库现状

当前 fork 已经不是最早版本，现有代码已经包含：

- Cloudflare Quick Tunnel
- 可选 Cloudflare Named Tunnel / 固定域名
- OAuth 2.1 + PKCE
- 一次性配对码
- Workspace 级权限隔离
- 只读 MCP 工具
- git diff / test status / execution summary
- ChatGPT session 记录
- doctor / setup / tunnel / record 等 CLI 命令

目前最强的 Codex 绑定集中在：

1. `skill/SKILL.md`
   - Codex 身份描述
   - Codex in-app browser (`iab`)
   - Codex sandbox writable_roots
   - Codex 自动更新流程
   - Codex 负责状态机推进

2. `src/config/sandbox-allow.ts`
   - 直接读取/修改 `~/.codex/config.toml`
   - 使用 `CODEX_HOME`

3. `src/cli/index.ts`
   - CLI 名称仍为 `c2c`
   - 产品文案仍为 `Codex with ChatGPT`
   - `doctor` 强制检查 Codex sandbox
   - `record` 描述为 Codex execution

4. `src/version.ts`
   - `PRODUCT_NAME = "Codex with ChatGPT"`
   - `SERVICE_NAME = "c2c-bridge"`

5. `src/config/paths.ts`
   - state dir 仍为 `codex-with-chatgpt`
   - 环境变量仍为 `C2C_STATE_DIR`

6. `src/config/endpoint.ts`
   - 默认 connector 名称仍为 `Codex with ChatGPT`

---

## 3. 总体架构设计

### 3.1 Core 层继续复用

以下模块应尽可能保持 Agent-neutral，不做大改：

```text
src/auth/
src/bridge/
src/mcp/
src/pairing/
src/workspace/
src/tunnel/
src/process/
src/logger/
```

这些模块本质上与 Codex / Pi 无关，应作为 `Pi with ChatGPT Core` 保留。

### 3.2 新增 Pi Adapter 层

建议新增：

```text
extensions/
└── pi-with-chatgpt/
    ├── index.ts
    ├── orchestrator.ts
    ├── state.ts
    ├── execution-collector.ts
    ├── security-gate.ts
    └── ui.ts

skills/
└── pi-with-chatgpt/
    └── SKILL.md

src/control/
├── types.ts
├── chatgpt-session.ts
└── transports/
    ├── manual.ts
    └── playwright.ts
```

职责划分：

- `Extension`：真正的编排器和状态机。
- `Skill`：只负责触发条件和行为说明，不承担状态机。
- `Control Transport`：负责 Pi 与 ChatGPT Web 的控制消息通道。
- `Core Bridge`：继续负责只读 MCP、安全、OAuth、workspace、tunnel。

---

## 4. 状态机设计

不继续完全照搬：

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN/DONE
```

建议 Pi 版内部状态：

```text
IDLE
  ↓
PREPARING
  ↓
PLANNING
  ↓
PLAN_READY
  ↓
EXECUTING
  ↓
REVIEWING
  ├── DONE
  └── FIXING
        ↓
      REVIEWING
```

### 状态权限

| 状态 | Pi 可读 | Pi 可写/edit | Pi 可 bash | ChatGPT MCP |
|---|---:|---:|---:|---:|
| PREPARING | ✓ | ✗ | ✗ | 可选 |
| PLANNING | ✓ | ✗ | ✗ | ✓ |
| PLAN_READY | ✓ | ✗ | ✗ | ✓ |
| EXECUTING | ✓ | ✓ | ✓ | ✓ |
| REVIEWING | ✓ | ✗ | ✗ | ✓ |
| FIXING | ✓ | ✓ | ✓ | ✓ |
| DONE | ✓ | ✗ | ✗ | ✓ |

Pi Extension 应通过 `tool_call` gate 阻止不合时机的 `write` / `edit` / `bash`。

---

## 5. ChatGPT 控制层抽象

当前 Codex 版依赖 Codex App 的 in-app browser，Pi 没有该能力，因此必须抽象浏览器传输层。

接口建议：

```ts
export interface ChatGptTransport {
  initialize(): Promise<void>;
  ensureConnected(workspace: WorkspaceConnection): Promise<void>;
  openSession(session: ChatGptSession): Promise<void>;
  send(message: ControlMessage): Promise<void>;
  waitForReply(taskId: string, expected: ControlState[]): Promise<ControlMessage>;
  close(): Promise<void>;
}
```

### V0：ManualTransport

用于最早期打通闭环：

- Extension 生成控制消息。
- 用户手动粘贴到 ChatGPT。
- 用户把 ChatGPT 返回内容粘贴回 Pi。

目的不是最终 UX，而是快速验证：

```text
PLAN → EXECUTE → REVIEW → FIX → DONE
```

### V1：PlaywrightTransport

正式自动化：

- 使用独立浏览器 profile。
- 不接管用户日常 Chrome / Edge / Safari。
- profile 存放在系统状态目录，不进入 workspace。
- 复用一个 ChatGPT conversation / workspace。
- 仅通过浏览器发送小型结构化控制消息。

建议 profile：

```text
~/.pi-with-chatgpt/browser-profile/
```

---

## 6. 协议设计

控制面继续保持“小消息”，禁止发送源码、diff、日志正文。

建议从 `[C2C]` 逐步迁移到 `[P2C]`：

```text
[P2C]
STATE: INIT
TASK_ID: p2c_ab12
ITERATION: 0

GOAL:
...
```

ChatGPT 获取代码仍通过 MCP：

```text
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
test_status
execution_summary
```

### 兼容策略

V0/V1 可以同时接受：

```text
[C2C]
[P2C]
```

完成稳定迁移后再删除 C2C 兼容。

---

## 7. Plan Approval

新增配置：

```json
{
  "approvalMode": "auto"
}
```

或：

```json
{
  "approvalMode": "plan"
}
```

### auto

```text
ChatGPT PLAN
  ↓
Pi 自动执行
```

### plan

```text
ChatGPT PLAN
  ↓
展示给用户
  ↓
用户确认
  ↓
Pi 执行
```

默认建议 V1 使用 `plan`，稳定后再考虑默认 `auto`。

---

## 8. Execution Record 去 Codex 化

当前 `ExecutionRecord` 结构可以兼容保留，但应增加 agent 信息。

目标结构：

```ts
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  agent?: {
    kind: "pi" | "codex" | string;
    model?: string;
  };
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
}
```

现有 MCP：

```text
execution_summary
test_status
```

保持兼容。

CLI `record` 文案改为：

```text
Record an agent execution summary
```

而不是：

```text
Record a Codex execution summary
```

---

## 9. Sandbox 改造

### 当前问题

`src/config/sandbox-allow.ts` 完全绑定 Codex：

- `CODEX_HOME`
- `~/.codex/config.toml`
- `[sandbox_workspace_write].writable_roots`

Pi 版不应该继续自动修改 Codex 配置。

### V0 方案

- `doctor` 中去掉 Codex sandbox 作为 hard gate。
- `sandbox-allow` 标记为 legacy / Codex-only。
- Pi 运行所需 state dir 直接按普通用户权限创建。

### V1 方案

增加 Pi 安全策略层：

```text
security-gate.ts
```

负责：

- planning/review 状态禁止写和 shell
- 可选 protected paths
- 可选 dangerous command confirmation
- 可选外部 sandbox / container 模式

不要假设 Pi 自带 Codex 同等级 sandbox。

---

## 10. 配置迁移

### 新配置名

建议：

```text
.p2c.json
.p2cignore
P2C_STATE_DIR
```

### 兼容期读取优先级

```text
.p2c.json
  ↓
.c2c.json
  ↓
defaults
```

Ignore：

```text
.p2cignore
  +
.c2cignore（兼容）
```

环境变量：

```text
P2C_STATE_DIR
  ↓ fallback
C2C_STATE_DIR
```

### State Directory

新安装使用：

```text
macOS:
~/Library/Application Support/pi-with-chatgpt

Windows:
%LOCALAPPDATA%\pi-with-chatgpt

Linux:
$XDG_STATE_HOME/pi-with-chatgpt
```

旧状态目录支持迁移/读取：

```text
codex-with-chatgpt
```

不要第一版直接破坏旧状态。

---

## 11. CLI 改造

### 目标命令

```text
p2c setup
p2c start
p2c stop
p2c restart
p2c status
p2c doctor
p2c pair
p2c unpair
p2c session
p2c record
p2c tunnel
p2c logs
p2c workspace
```

### 兼容 alias

第一阶段 package.json：

```json
{
  "bin": {
    "p2c": "./bin/p2c.js",
    "c2c": "./bin/p2c.js"
  }
}
```

这样旧命令暂时不会立即失效。

### 产品文案

```text
Codex with ChatGPT
→ Pi with ChatGPT

ChatGPT thinks. Codex works.
→ ChatGPT thinks. Pi works.
```

`SERVICE_NAME` 可以第一阶段暂时继续 `c2c-bridge`，避免一次迁移太多状态；稳定后再切 `p2c-bridge`。

---

## 12. Connector 命名迁移

新 workspace：

```text
Pi with ChatGPT · <workspace>
```

已有 endpoint：

- 如果已有 connectorName，继续沿用旧名称，避免强制重建。
- 用户主动 migrate 或重新配对时，再切换到 Pi 名称。

不要因为产品 rename 自动删除现有 ChatGPT connector。

---

## 13. Skill 重写

当前 `skill/SKILL.md` 约 2 万多字，包含大量 Codex 专属浏览器和状态机操作。

Pi 版不要照抄。

目标 `skills/pi-with-chatgpt/SKILL.md` 应只承担：

- 什么时候使用 Pi with ChatGPT。
- ChatGPT 是 planning / review 层。
- Pi 是 execution 层。
- 不允许把源码/diff/log 直接粘贴到 ChatGPT。
- 如果 Extension 已加载，应调用 Extension 工作流，不手工模拟状态机。

真正状态管理必须放在 TypeScript Extension。

---

## 14. Pi Extension API 设计

第一版建议注册：

```text
/p2c <goal>
/p2c-setup
/p2c-status
/p2c-stop
```

内部组件：

### `index.ts`

- 注册 commands
- 注册 lifecycle hooks
- 初始化 orchestrator

### `state.ts`

保存：

```ts
interface WorkflowState {
  workspaceId: string;
  taskId: string;
  iteration: number;
  state:
    | "IDLE"
    | "PREPARING"
    | "PLANNING"
    | "PLAN_READY"
    | "EXECUTING"
    | "REVIEWING"
    | "FIXING"
    | "DONE"
    | "BLOCKED"
    | "ERROR";
}
```

### `orchestrator.ts`

负责：

```text
prepare
requestPlan
approvePlan
execute
collectExecution
requestReview
loop
finish
```

### `security-gate.ts`

监听 Pi tool calls：

- 非 EXECUTING/FIXING 状态阻止 `write/edit/bash`
- 可扩展危险命令检查

### `execution-collector.ts`

执行结束后收集：

- changed files
- git status
- tests summary
- exit status

写入现有 execution records。

### `ui.ts`

只处理人类友好的状态：

```text
Planning…
Plan ready
Executing…
Reviewing…
2 issues found
Fixing…
Review passed
```

不要向普通用户暴露 OAuth/PKCE/端口等内部细节。

---

## 15. 第一阶段不做的事情

为了避免 fork 一开始就失控，以下内容不要放进第一阶段：

- 不重写 OAuth。
- 不重写 MCP。
- 不重写 Workspace path security。
- 不删除 Quick Tunnel。
- 不删除已经实现的 Named Tunnel。
- 不一次性迁移全部 state directory。
- 不立即删除 `c2c` CLI alias。
- 不把 browser automation 和 orchestrator 写死耦合。
- 不做多 ChatGPT 会话并行控制。
- 不做多个 workspace 同时共享同一个浏览器 tab。

---

## 16. 分阶段实施计划

# Phase 0 — Fork 基线与命名层

目标：不破坏现有功能的前提下建立 Pi 产品身份。

任务：

- [ ] `package.json` name 改为 `pi-with-chatgpt`
- [ ] description 改为 Pi 文案
- [ ] 新增 `bin/p2c.js`
- [ ] 保留 `c2c` alias
- [ ] `src/version.ts` 产品名改为 `Pi with ChatGPT`
- [ ] endpoint 新 workspace 默认 connector 改为 `Pi with ChatGPT · <workspace>`
- [ ] 保持已有 connectorName 兼容
- [ ] README 增加 Pi 改造状态说明
- [ ] 所有测试继续通过

验收：

```text
p2c --version
p2c workspace
p2c setup --no-tunnel
```

可正常运行。

---

# Phase 1 — 去除 Codex Hard Dependency

目标：Core 可以在完全没有 Codex 的机器上运行。

任务：

- [ ] `doctor` 不再把 Codex sandbox 作为硬性健康条件
- [ ] `setup` 不自动调用 Codex sandbox allow
- [ ] `sandbox-allow` 标记 legacy
- [ ] 去除 CLI 对 `~/.codex/config.toml` 的默认依赖
- [ ] execution 文案去 Codex 化
- [ ] `src/config/paths.ts` 支持 `P2C_STATE_DIR`
- [ ] 增加新 state dir，兼容旧 state dir
- [ ] 测试覆盖“没有 ~/.codex 也能 setup/doctor”

验收：

全新环境仅安装 Node + cloudflared，也能：

```text
p2c setup
p2c doctor
```

---

# Phase 2 — Pi Package 骨架

目标：Pi 可以直接加载本项目。

任务：

- [ ] 新增 `extensions/pi-with-chatgpt/index.ts`
- [ ] 新增 `skills/pi-with-chatgpt/SKILL.md`
- [ ] 配置 package metadata 供 Pi 安装
- [ ] 注册 `/p2c-status`
- [ ] 注册 `/p2c-setup`
- [ ] 能从 Extension 调用本地 p2c core
- [ ] Pi 启动后能识别当前 workspace

验收：

```text
pi install git:github.com/lionelzz2025/pi-with-chatgpt
```

安装后可以执行：

```text
/p2c-status
```

---

# Phase 3 — ManualTransport 闭环

目标：先证明 Pi + ChatGPT 双 Agent 工作流可行。

任务：

- [ ] 实现 WorkflowState
- [ ] 实现 Orchestrator
- [ ] 实现 ManualTransport
- [ ] `/p2c <goal>` 请求 ChatGPT PLAN
- [ ] PLAN 注入 Pi 当前执行上下文
- [ ] Pi 执行
- [ ] execution collector 写 record
- [ ] 请求 ChatGPT REVIEW
- [ ] REVIEW=PLAN 时进入 FIXING
- [ ] REVIEW=DONE 时结束
- [ ] maxIterations 生效

验收场景：

```text
/p2c 给一个小型 TypeScript 项目增加参数校验和测试
```

能够至少完成：

```text
PLAN → EXECUTE → REVIEW → DONE
```

---

# Phase 4 — Execution Gate

目标：Pi 不得绕过编排层。

任务：

- [ ] 注册 `tool_call` hook
- [ ] PLANNING/REVIEWING 时禁止 write/edit/bash
- [ ] EXECUTING/FIXING 时恢复权限
- [ ] 状态异常 fail closed
- [ ] 增加 protected paths 基础策略
- [ ] 增加相关单元测试

验收：

在 REVIEWING 状态手工诱导 Pi 修改文件时，Extension 必须阻止。

---

# Phase 5 — Plan Approval

目标：支持复杂任务人工批准计划。

任务：

- [ ] 增加 `approvalMode`
- [ ] `auto`
- [ ] `plan`
- [ ] PLAN_READY UI
- [ ] approve / reject / revise
- [ ] approved plan 持久化 task/session 信息

验收：

`approvalMode=plan` 时没有用户批准，Pi 无法 edit/write/bash。

---

# Phase 6 — PlaywrightTransport

目标：去掉人工复制粘贴，实现完整自动化。

任务：

- [ ] 加入 Playwright 依赖或独立 browser package
- [ ] 独立 browser profile
- [ ] ChatGPT 登录复用
- [ ] Developer mode / connector setup 自动化
- [ ] Pairing code 自动输入
- [ ] conversation URL 持久化
- [ ] INIT/EXECUTED 消息自动发送
- [ ] PLAN/DONE/BLOCKED 回复解析
- [ ] timeout/retry/reconnect 策略
- [ ] connector 地址变化时 Delete + recreate
- [ ] Named Tunnel 固定域名时禁止无意义重建 connector

验收：

用户首次登录 ChatGPT 后，后续 `/p2c` 不再要求复制粘贴。

---

# Phase 7 — Pi 产品化迁移

目标：用户看到的项目完全变成 Pi with ChatGPT。

任务：

- [ ] README 全面改写
- [ ] README.zh-CN 全面改写
- [ ] docs/architecture.md
- [ ] docs/protocol.md
- [ ] docs/security.md
- [ ] docs/troubleshooting.md
- [ ] `.p2c.json`
- [ ] `.p2cignore`
- [ ] `[P2C]` protocol 默认启用
- [ ] `P2C_STATE_DIR`
- [ ] state migration command
- [ ] legacy `c2c` 发 deprecation warning
- [ ] 发布首个 tag/release

---

## 17. 安全要求

### ChatGPT 侧

必须继续保证：

- 只读 MCP
- 不提供 write/delete/shell/commit/install 工具
- workspace root 是权限边界
- 敏感文件规则继续生效
- git diff 同样走敏感文件过滤
- token 按 workspace 绑定

### Pi 侧

新增要求：

- 只有 EXECUTING/FIXING 状态允许 mutation tools
- review 阶段冻结 Pi 写操作
- browser profile 不进入 workspace
- ChatGPT cookie/token 不进入 workspace
- tunnel credentials 继续只存在 OS state dir
- 不自动 `git pull + pnpm install + build` 更新自身

### 更新策略

取消原 Codex Skill 的“每天自动更新并自动执行安装”。

推荐：

- 用户显式执行更新
- Pi package 固定 tag / commit
- release 后再升级

---

## 18. 测试策略

现有测试优先全部保留。

新增测试分类：

```text
tests/pi-extension/
  state.test.ts
  orchestrator.test.ts
  security-gate.test.ts
  execution-collector.test.ts
  manual-transport.test.ts
  protocol.test.ts
```

浏览器测试：

```text
tests/browser/
  connector-setup.test.ts
  session-reuse.test.ts
  reply-parser.test.ts
```

必须重点覆盖：

- 不安装 Codex 时 core 正常运行
- planning/review 时 Pi mutation tool 被拒绝
- iteration 超限
- ChatGPT BLOCKED
- ChatGPT 回复格式错误
- Quick Tunnel URL 变化
- Named Tunnel URL 不变化
- old connector name 兼容
- `.c2c.json` → `.p2c.json` 兼容
- old state dir migration

---

## 19. 建议的第一个开发分支

第一批代码不要直接在 main 大改，建议：

```text
feat/pi-adapter-foundation
```

该分支只完成：

1. Phase 0
2. Phase 1
3. Phase 2 骨架

第一 PR 不做浏览器自动化。

这样可以先得到一个明确的 checkpoint：

> Core 已去 Codex 化，并且 Pi 能加载扩展。

之后再开：

```text
feat/p2c-orchestrator
feat/p2c-browser-transport
feat/p2c-product-migration
```

---

## 20. 最终 V1 用户体验

安装：

```bash
pi install git:github.com/lionelzz2025/pi-with-chatgpt@v1.0.0
```

首次配置：

```text
/p2c-setup
```

编码任务：

```text
/p2c 重构这个认证模块，保持 API 兼容并补齐测试
```

预期 UI：

```text
Pi with ChatGPT

✓ Workspace connected
✓ ChatGPT planner ready

Planning…
✓ Plan received

Executing with Pi…
✓ Implementation finished

Reviewing with ChatGPT…
! 2 issues found

Fixing with Pi…
✓ Fix applied

Reviewing with ChatGPT…
✓ Review passed
✓ Tests passed

Done.
```

---

## 21. 最优先结论

第一原则不是：

```text
Codex Skill → Pi Skill
```

而是：

```text
Codex Skill 驱动
        ↓
Pi Extension 驱动
```

原项目最应该保留的是：

- Bridge
- MCP
- OAuth / Pairing
- Workspace 安全边界
- Tunnel（包括现有 Named Tunnel）
- 独立 Review 协议

最应该替换的是：

- Codex in-app browser 依赖
- Codex sandbox 配置修改
- 超长 Skill 状态机
- Codex execution 命名
- 自动拉取更新行为

第一里程碑应是：

> **完全不安装 Codex，也能启动 Core；Pi Extension 能加载；ManualTransport 能跑通一次完整 PLAN → EXECUTE → REVIEW → DONE。**
