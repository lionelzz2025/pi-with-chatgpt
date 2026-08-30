# Pi with ChatGPT 改造任务计划

> 最后更新：2026-08-30  
> 当前稳定基线：`main` @ `2024c067`（Phase 0–2 已合并）  
> 当前开发分支：`feat/phase3-manual-transport`（Phase 3 实现中，等待完整验收）

## 1. 项目目标

将从 `codex-with-chatgpt` fork 而来的项目改造成以 **Pi 作为本地执行 Agent、ChatGPT Web 作为规划与独立 Review 层** 的 `pi-with-chatgpt`。

核心原则：

- **ChatGPT thinks. Pi works.**
- ChatGPT 只通过只读 MCP 查看当前 workspace，不拥有写文件、Shell、commit、install 等能力。
- Pi 负责本地读取、修改、命令执行、测试、git 和修复。
- 编排状态机由 Pi Extension 管理，不再依赖超长 Skill prompt 维持流程。
- 保留并复用现有 Bridge / MCP / OAuth / Pairing / Workspace / Tunnel 安全架构。
- 控制面只交换小型 `[P2C]` 状态消息；源码、diff、日志由 ChatGPT 通过 MCP 按需读取。

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
  ├── DONE
  └── PLAN / FIX
        ↓
      Pi FIX
        ↓
      ChatGPT REVIEW
```

---

## 2. 当前进展总览

| Phase | 状态 | 说明 |
|---|---|---|
| Phase 0 — Pi 产品身份 | ✅ 已合并 | PR #1；`p2c`、产品命名、connector 兼容、CI 基线 |
| Phase 1 — 去 Codex Hard Dependency | ✅ 已合并 | PR #2/#3；状态目录迁移兼容、setup/doctor 不再依赖 Codex sandbox |
| Phase 2 — Pi Package 骨架 | ✅ 已合并 | PR #4；Pi manifest、Extension、Skill、`/p2c-status`、`/p2c-setup` |
| Phase 3 — ManualTransport 闭环 | 🟡 实现完成，待验收 | 当前开发分支；协议、状态机、orchestrator、collector、测试已落地 |
| Phase 4 — Execution Gate | ⏳ 未开始 | 用 `tool_call` hook 强制 planning/review 只读 |
| Phase 5 — Plan Approval | ⏳ 未开始 | `auto` / `plan`，批准/拒绝/修改计划 |
| Phase 6 — PlaywrightTransport | ⏳ 未开始 | 自动化 ChatGPT Web 控制面 |
| Phase 7 — 产品化迁移 | ⏳ 部分完成 | Pi/P2C 基础命名已完成，README/config/release 等仍待做 |

详细开发日志见 [`progress.md`](progress.md)。

---

## 3. 当前架构

### Core（Agent-neutral，继续复用）

```text
src/auth/
src/bridge/
src/mcp/
src/pairing/
src/workspace/
src/tunnel/
src/process/
src/logger/
src/execution/
```

这些模块继续承担：

- 只读 MCP
- OAuth 2.1 + PKCE
- 一次性 pairing code
- workspace 权限边界
- sensitive path / git diff 过滤
- Quick Tunnel / Named Tunnel
- execution records

### Pi Adapter

当前目标结构：

```text
extensions/
└── pi-with-chatgpt/
    ├── api.ts
    ├── core.ts
    ├── index.ts
    ├── orchestrator.ts
    ├── state.ts
    ├── manual-transport.ts
    ├── execution-collector.ts
    ├── security-gate.ts        # Phase 4
    └── ui.ts                   # 后续可继续拆分

skills/
└── pi-with-chatgpt/
    └── SKILL.md

src/control/
├── types.ts
└── transports/
    ├── manual.ts
    └── playwright.ts           # Phase 6
```

---

## 4. 状态机

Pi 版内部状态：

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

异常状态：

```text
BLOCKED
ERROR
```

权限目标：

| 状态 | Pi read | Pi write/edit | Pi bash | ChatGPT MCP |
|---|---:|---:|---:|---:|
| PREPARING | ✓ | ✗ | ✗ | 可选 |
| PLANNING | ✓ | ✗ | ✗ | ✓ |
| PLAN_READY | ✓ | ✗ | ✗ | ✓ |
| EXECUTING | ✓ | ✓ | ✓ | ✓ |
| REVIEWING | ✓ | ✗ | ✗ | ✓ |
| FIXING | ✓ | ✓ | ✓ | ✓ |
| DONE | ✓ | ✗ | ✗ | ✓ |

> Phase 3 已实现状态流转；真正的 mutation 强制拦截属于 Phase 4，尚未完成。

---

## 5. 控制协议

默认使用 `[P2C]` 小消息：

```text
[P2C]
STATE: INIT
TASK_ID: p2c_ab12
ITERATION: 0

GOAL:
...
```

兼容期解析：

```text
[P2C]
[C2C]
```

ChatGPT 获取代码仍通过现有 MCP：

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

禁止把源码、完整 diff、测试日志正文塞进控制消息。

---

## 6. 配置与兼容策略

### CLI

主命令：

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

兼容 alias：

```text
c2c → p2c
```

### State Directory

优先级：

```text
P2C_STATE_DIR
  ↓
C2C_STATE_DIR
  ↓
已有 codex-with-chatgpt state dir
  ↓
新 pi-with-chatgpt state dir
```

新安装默认：

```text
macOS:   ~/Library/Application Support/pi-with-chatgpt
Windows: %LOCALAPPDATA%\pi-with-chatgpt
Linux:   $XDG_STATE_HOME/pi-with-chatgpt
```

不会因为产品 rename 自动删除或重建旧 ChatGPT connector。

---

# 7. 分阶段实施计划

## Phase 0 — Fork 基线与 Pi 产品身份 ✅

目标：不破坏原有安全/连接功能的前提下建立 Pi 产品身份。

- [x] `package.json` name 改为 `pi-with-chatgpt`
- [x] description 改为 Pi 文案
- [x] 新增 `bin/p2c.js`
- [x] 保留 `c2c` alias
- [x] `src/version.ts` 产品名改为 `Pi with ChatGPT`
- [x] 新 workspace connector 默认 `Pi with ChatGPT · <workspace>`
- [x] 保持旧 connectorName / legacy endpoint 兼容
- [x] 建立 GitHub Actions CI：test + typecheck + build
- [x] 修复 pnpm 与 Node 20 的版本兼容
- [ ] README 全面 Pi 化（移入 Phase 7）

验收：✅ 已通过并合并 PR #1。

---

## Phase 1 — 去除 Codex Hard Dependency ✅

目标：完全没有 Codex 的机器也可以正常启动 Core。

- [x] `doctor` 不再把 Codex sandbox 作为健康条件
- [x] `setup` 不自动调用 Codex sandbox allow
- [x] `sandbox-allow` 保留为显式 legacy Codex compatibility command
- [x] setup/doctor 默认不读取或创建 `~/.codex/config.toml`
- [x] execution 文案去 Codex 化
- [x] ExecutionRecord 增加 agent metadata
- [x] `P2C_STATE_DIR` 优先，兼容 `C2C_STATE_DIR`
- [x] 新 state dir + 旧 state dir 自动复用策略
- [x] 集成测试覆盖“没有 Codex 也能 setup/doctor”
- [x] 集成测试确认 fake `CODEX_HOME` 下不会创建 `config.toml`

验收：✅ 已通过并合并 PR #2、PR #3。

---

## Phase 2 — Pi Package 骨架 ✅

目标：Pi 可以直接安装并加载本项目。

- [x] Pi package manifest / `pi-package` keyword
- [x] `extensions/pi-with-chatgpt/` Extension 结构
- [x] `skills/pi-with-chatgpt/SKILL.md`
- [x] 注册 `/p2c-status`
- [x] 注册 `/p2c-setup`
- [x] Extension 调用本包 `p2c` core
- [x] Pi 使用当前 `ctx.cwd` 识别 workspace
- [x] git-installed package 下 `tsx` loader 相对本包解析
- [x] detached daemon fallback 同样支持 Git 安装目录
- [x] manifest / command routing 单测

目标安装方式：

```text
pi install git:github.com/lionelzz2025/pi-with-chatgpt
```

验收：✅ CI 全绿并合并 PR #4。

---

## Phase 3 — ManualTransport 闭环 🟡

目标：先证明 Pi + ChatGPT 双 Agent 的完整控制闭环可行，不依赖浏览器自动化。

### 已实现

- [x] `[P2C]` protocol types / parser / serializer
- [x] 兼容解析 `[C2C]`
- [x] `WorkflowStateMachine`
- [x] `Orchestrator`
- [x] `ManualTransport`
- [x] `/p2c <goal>` 入口
- [x] PREPARING / PLANNING / PLAN_READY / EXECUTING / REVIEWING / FIXING / DONE 状态流
- [x] PLAN 通过 `sendUserMessage(..., { deliverAs: "followUp" })` 注入 Pi 执行上下文
- [x] 以 Pi `agent_settled` 作为执行完成的唯一生命周期判据
- [x] execution collector 收集执行元数据
- [x] execution collector 写入现有 execution record（agent=`pi`）
- [x] 自动请求 ChatGPT REVIEW
- [x] REVIEW=`PLAN` → FIXING → 下一轮 REVIEW
- [x] REVIEW=`DONE` → DONE
- [x] `maxIterations` 超限 → BLOCKED
- [x] `/p2c-stop`
- [x] protocol 单测
- [x] workflow state 单测
- [x] orchestrator PLAN → EXECUTE → REVIEW → DONE 单测
- [x] orchestrator REVIEW → PLAN → FIX → REVIEW → DONE 单测

### 待验收

- [ ] 为当前 Phase 3 分支创建 PR
- [ ] 运行完整 CI：install + test + typecheck + build
- [ ] 修复 Phase 3 CI 暴露的问题
- [ ] 在真实 Pi 环境安装当前分支并执行 `/p2c-status`
- [ ] 真实 ChatGPT connector + ManualTransport 跑通一次 PLAN → EXECUTE → REVIEW → DONE
- [ ] 合并 Phase 3 到 `main`

当前分支：

```text
feat/phase3-manual-transport
```

截至本次更新，该分支相对 `main` 前进 **15 commits**。

---

## Phase 4 — Execution Gate ⏳

目标：Pi 不得在编排器禁止 mutation 的状态绕过流程。

- [ ] 新增 `security-gate.ts`
- [ ] 注册 Pi `tool_call` hook
- [ ] PLANNING / PLAN_READY / REVIEWING 阻止 `write` / `edit` / `bash`
- [ ] PREPARING / DONE / BLOCKED / ERROR 默认 fail closed
- [ ] EXECUTING / FIXING 恢复 mutation tools
- [ ] protected paths 基础策略
- [ ] dangerous command 扩展点
- [ ] 单元测试覆盖允许/拒绝矩阵

验收：在 REVIEWING 状态诱导 Pi 修改文件时，Extension 必须阻止。

---

## Phase 5 — Plan Approval ⏳

目标：复杂任务可先让用户批准 ChatGPT PLAN。

- [ ] `.p2c.json` 中增加 `approvalMode`
- [ ] `approvalMode=auto`
- [ ] `approvalMode=plan`
- [ ] PLAN_READY UI
- [ ] approve
- [ ] reject
- [ ] revise
- [ ] approved plan 持久化 task/session 信息
- [ ] 未批准计划时 mutation tools 必须保持关闭

---

## Phase 6 — PlaywrightTransport ⏳

目标：去掉人工复制粘贴，实现 ChatGPT Web 控制面的自动化。

- [ ] Playwright transport
- [ ] 独立 browser profile
- [ ] ChatGPT 登录复用
- [ ] Developer mode / connector setup 自动化
- [ ] Pairing code 自动输入
- [ ] conversation URL 持久化
- [ ] INIT / EXECUTED 自动发送
- [ ] PLAN / DONE / BLOCKED 自动解析
- [ ] timeout / retry / reconnect
- [ ] Quick Tunnel URL 变化时 Delete + recreate connector
- [ ] Named Tunnel 固定 URL 时禁止无意义重建
- [ ] browser profile / cookie 不进入 workspace

---

## Phase 7 — Pi 产品化迁移 ⏳

目标：用户看到的项目完全变成 Pi with ChatGPT。

- [ ] README 全面改写
- [ ] README.zh-CN 全面改写
- [ ] docs/architecture.md 更新 Pi 架构
- [ ] docs/protocol.md 更新 P2C 协议
- [ ] docs/security.md 增加 Pi execution gate 威胁模型
- [ ] docs/troubleshooting.md 更新 Pi 安装/运行问题
- [ ] `.p2c.json`
- [ ] `.p2cignore`
- [x] `P2C_STATE_DIR`
- [x] Pi 产品名 / `p2c` CLI 基础迁移
- [x] 新 workspace 使用 Pi connector 名称
- [x] `[P2C]` protocol 实现（当前 Phase 3 分支；待合并）
- [ ] state migration command
- [ ] legacy `c2c` deprecation warning
- [ ] 清理旧 Codex Skill / 自动更新行为
- [ ] 首个稳定 tag / release

---

## 8. 安全要求

### ChatGPT 侧（必须持续保持）

- 只读 MCP
- 不提供 write/delete/shell/commit/install 工具
- workspace root 是权限边界
- sensitive file 规则继续生效
- git diff 同样经过 sensitive-file filtering
- token 按 workspace 绑定
- 控制消息不携带源码/diff/log body

### Pi 侧

- 只有 EXECUTING / FIXING 状态允许 mutation tools（Phase 4 强制）
- planning/review 阶段冻结 Pi 写操作
- browser profile 不进入 workspace
- ChatGPT cookie/token 不进入 workspace
- tunnel credentials 继续只存在 OS state dir
- 不自动 `git pull + pnpm install + build` 更新自身

---

## 9. 测试策略

现有 core 测试全部保留。

Pi / control 层重点覆盖：

```text
tests/control-protocol.test.ts
tests/pi-workflow-state.test.ts
tests/pi-orchestrator.test.ts
tests/pi-package.test.ts
```

后续新增：

```text
tests/security-gate.test.ts
tests/execution-collector.test.ts
tests/browser/connector-setup.test.ts
tests/browser/session-reuse.test.ts
tests/browser/reply-parser.test.ts
```

必须持续覆盖：

- 不安装 Codex 时 core 正常运行
- setup / doctor 不触碰 Codex config
- planning/review 时 Pi mutation tool 被拒绝
- iteration 超限
- ChatGPT BLOCKED
- ChatGPT 回复格式错误
- Quick Tunnel URL 变化
- Named Tunnel URL 不变化
- old connector name 兼容
- `C2C_STATE_DIR` / old state dir 兼容

---

## 10. 下一步执行顺序

当前不再扩 Phase 3 功能，先完成验收闭环：

1. 给 `feat/phase3-manual-transport` 创建 PR。
2. 运行 CI：`pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck`、`pnpm build`。
3. 修复 CI 问题直到全绿。
4. 做一次真实 Pi + ChatGPT ManualTransport smoke test。
5. 合并 Phase 3。
6. 开始 Phase 4 `security-gate.ts`。

第一里程碑的完成定义：

> **完全不安装 Codex，也能启动 Core；Pi Extension 能加载；ManualTransport 能真实跑通一次完整 PLAN → EXECUTE → REVIEW → DONE。**

第二里程碑：

> **Pi 的 mutation 权限由 Extension 状态机强制控制，而不是依赖 prompt 自律。**
