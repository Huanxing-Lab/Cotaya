# Continuous 完整测试流程与 E2E

| 项目     | 内容                                                   |
| -------- | ------------------------------------------------------ |
| 状态     | 模块和接缝已实现；核心产品 E2E blocked，本次结果见文末 |
| 规格     | [产品与架构](../specs/continuous.md)                   |
| 实施任务 | [CT-00 至 CT-10](../tickets/continuous.md)             |
| 源码基线 | `7a83710b4ba13427f1c41d29f0ac3b242a7dfc03`             |

本文是实施后的执行手册。当前没有新 runner、fixtures 或测试代码。下面的新增命令必须在对应 ticket 完成后才可运行；不得将文档中的命令存在视为通过。

## 1. 当前已有入口与缺口

已经核对的入口：

| 入口                                                | 当前状态                                                                            | 用途                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`                                    | 已有                                                                                | 根 workspace TS 项目，未覆盖全部 CLI                               |
| `pnpm lint`、`pnpm fmt:check`                       | 已有                                                                                | 根 lint/格式；旧失败需单独记录                                     |
| `pnpm architecture:check --changed`                 | 已有                                                                                | 变更模块边界                                                       |
| `pnpm verify:pre-push`                              | 已有                                                                                | lint 和 architecture，不包含全部测试                               |
| `pnpm --dir apps/zcode-cli typecheck`、`lint`       | 已有                                                                                | CLI 子 workspace                                                   |
| `pnpm --dir apps/zcode-cli/packages/bootstrap test` | 已有                                                                                | bootstrap 的 tsx/Node test                                         |
| `packages/services/test/*.test.ts`                  | 已有                                                                                | Node test，但 services package 没有统一 test script                |
| `packages/ui/test/*.test.ts`                        | 已有                                                                                | Node test，但 UI package 没有统一 test script                      |
| desktop 的 `playwright-core`                        | 已有依赖                                                                            | 可用于 Electron/浏览器控制，不等于已有 E2E runner                  |
| `packages/shared/src/e2e-test-bridge.ts`            | 已有                                                                                | 专用 build flag + run ID；不能仅凭 test 环境扩大权限               |
| `packages/desktop/src/main/e2eCoverage.ts`          | 已有                                                                                | coverage 支持，不等于行为覆盖                                      |
| `scripts/test-continuous.mjs`                       | 已有（CT-00；CT-09 script 契约；CT-10 platform/regression 接入；CT-16 增 packaged） | suite 编排、报告、严格退出码                                       |
| `packages/desktop/test/continuous/*`                | 已有（CT-09；CT-10 增 regression 入口；CT-16 增 packaged 入口）                     | runner/fixtures/evidence、Electron、手机、live、回归、打包验收测试 |

不使用假定的根 `pnpm test`、`pnpm test:e2e` 或未安装的 `@playwright/test`。测试代码沿用 Node test；TypeScript 使用已有 tsx；Electron 使用 desktop 现有 playwright-core。

## 2. 每次执行的隔离和证据

每次新建 testRunId 和系统临时根目录，不读写用户真实数据、workspace 或登录资料。跨平台用 os.tmpdir/path API，禁止硬编码个人路径。

目录规划：

```text
临时根/<testRunId>/
  data/                 产品/Host/CLI隔离数据
  electron-user-data/   Electron profile
  repositories/        临时Git仓库和Program worktree
  target-app/          浏览器验证对象
  artifacts/
    manifest.json
    results.json
    cases/<caseId>/
      screenshots/
      trace.zip
      commands.json
      protocol.ndjson
      service-events.ndjson
      db-facts.json
      usage.json
      git-before.json
      git-after.json
      diff.patch
```

使用已有 ZCODE_DATA_BASE_DIR 和实际 desktop runtime path 配置隔离。runner 在启动前校验最终解析路径均在临时根；只设一个环境变量不足以证明隔离。

测试桥必须同时命中专用 build flag 和非空 run ID。Clock、barrier、provider fixture、故障注入和只读状态检查只通过 test composition 注入。生产构建不得暴露这些操作。新环境变量若确有必要，先补 spec；优先用 runner 参数和配置，不新增任意全局开关。

证据至少包括：源码 commit、Node/pnpm/Electron 版本、OS、模型类型、case ID、start/end、exit code、traceId/programId/cycleId/runId/sessionId、截图、关键服务事实和实际 diff。去掉凭据、真实用户内容和内部地址。

失败保留 artifact。成功按 runner 生命周期清理临时进程和 fixtures，但保留验收报告。清理只作用于当前 testRunId 资源；不能按进程名杀所有 Electron/Node，不能删除用户 worktree。

## 3. Provider 与目标应用 fixtures

### 脚本化模型

fixture provider 返回合法模型事件、tool calls、typed submit_result 和 usage，通过实际模型接口接入。禁止直接注入最终 Cycle 成功状态，禁止绕过 AgentRuntime、Engine 或 journal。

fixture 必须可控制：

- 候选和 Decision 输出；10 pending 的初始发现。
- 模型请求开始/usage 发布/typed result/工具执行前后的 barrier。
- transient/permanent failure、取消、重复 usage、晚到 usage、缺失 usage。
- read/write/test/browser/review 的真实工具调用。
- 恶意越界调用，越界必须被真实工具边界拒绝。

模型价格使用虚构固定值，账本断言可精确计算。它证明调度、恢复和权限边界，不证明真实模型的改进质量。

### 目标应用

创建临时 Git fixture，包含可启动的 UI 页面、响应式 header/sidebar/empty state，以及 Settings navigation。其测试命令用明确 argv 配置。

初始问题：Header spacing、390px sidebar overflow、empty state 对比度；Settings architecture 需要决策。测试实际运行该临时应用，浏览器对 DOM 几何、可访问名称、键盘和截图作断言。

不要把 Continuous 控制页面截图当作目标应用改进通过。候选 done 必须同时有代码 diff、测试结果、目标页面浏览器证据和独立 reviewer 结果。

### 真实模型

live suite 默认不运行。使用显式测试 provider 配置和有限额度，不能读取生产凭据。没有已配置的测试身份则 blocked；不能由 agent 输入个人密码、OTP 或 API key。

至少执行真实 E-01/E-03/E-04：确实生成候选、修改 fixture、运行测试、验证目标页面、完成 Review、本地提交。真实模型输出波动时记录实际失败，不反复重跑直到成功。

## 4. 按顺序执行

### 步骤 A：基线与静态检查

从仓库根目录执行，RTK 按仓库指令使用：

```sh
rtk proxy node scripts/check-workspace-freshness.mjs
rtk proxy pnpm typecheck
rtk proxy pnpm lint
rtk proxy pnpm fmt:check
rtk proxy pnpm architecture:check --changed
rtk proxy pnpm --dir apps/zcode-cli typecheck
rtk proxy pnpm --dir apps/zcode-cli lint
rtk proxy pnpm --dir apps/zcode-cli/packages/bootstrap test
```

这组命令在代码实施阶段执行，会产生构建输出；当前文档阶段不声称执行完毕。已有失败不能写通过；区分本次导致、已有基线和环境阻塞，核心新增失败阻止发布。

CLI typecheck 可能需要生成库和依赖 build，按实际脚本执行，不用 root typecheck 替代。

### 步骤 B：单元和存储集成

以下命令为 **CT-00 后新增 runner 的确定接口**（CT-01 起逐 suite 可用；CT-09 起 e2e/mobile/live 入口存在，用例状态见各自 artifacts/results.json）：

```sh
rtk proxy node scripts/test-continuous.mjs --suite unit
rtk proxy node scripts/test-continuous.mjs --suite integration
```

runner 对 Node/tsx 测试文件使用 manifest 枚举和 argv spawn，不依赖 shell glob/平台分隔符。unit 运行 U；integration 运行 I。实际 SQLite migration、FK、事务与 reopen 不得替换为内存 Map 测试。

### 步骤 C：崩溃恢复

```sh
rtk proxy node scripts/test-continuous.mjs --suite recovery
```

执行 R-01 至 R-10。只在 test barrier 达到后注入 kill/disconnect，不用 sleep 猜时序。观察进程树，确认旧 actor 停止或被禁止操作后，才启动接管方。

### 步骤 D：真实 Electron + 脚本化模型 E2E

```sh
rtk proxy node scripts/test-continuous.mjs --suite e2e
```

runner 必须完成：

1. 校验隔离目录和 dependencies。
2. 构建当前 CLI：使用已有 `scripts/build-desktop-agent-cli.mjs`；不能误用旧 bundled agent。
3. 准备 desktop runtime assets 并构建 main/host/preload/renderer；复用已有构建脚本。
4. 在 test build 中启用受限 bridge，准备受控 endpoint/provider；禁止生产配置和真实外部提交。
5. 用 playwright-core Electron API 启动实际应用和当前构建；不同时启动另一个 dev Electron。
6. 等待实际 Host/CLI ready 和能力响应，不只等待窗口出现。
7. 从 UI 创建 Program、点击命令；观察真实协议、数据库、Run、工具和目标页面。
8. 每个 E 用例收集 UI + 服务/存储 + 文件/执行三层断言。
9. 按需重启实际进程，保留同一测试数据根核对恢复。
10. 完成后停止测试所有进程树并输出报告；任何失败返回非零（blocked 的退出码语义见 §10）。

构建与 runtime path 以当前 desktop 脚本为准。runner readiness 必须包括实际加载的 CLI build fingerprint，不把成功编译等同于已加载新版本。

CLI/desktop 构建与 Electron 进程输出默认写入 `artifacts/logs/<label>.log`，控制台只保留结论行（批量构建子进程动辄 300KB+ 输出，编排层存在 stdout 上限的门禁环境会整条命令拒收）；失败时错误消息必须指向对应日志文件。

### 步骤 E：手机控制和两种交付语义

```sh
rtk proxy node scripts/test-continuous.mjs --suite mobile
```

复用已有配对/鉴权链路在隔离环境创建测试 attachment；浏览器连接步骤由 runner 明确驱动，不输入个人凭据。同一桌面 Program 在手机查看、Pause、resolve 和重连，核对两端同一 IDs/owner。

不能用 desktop renderer 缩成 390px 替代手机真实 replayable 连接。390px 控制页布局与手机链路是两项独立验收。

### 步骤 F：live 和平台验收

```sh
rtk proxy node scripts/test-continuous.mjs --suite live --allow-live
```

没有 allow-live 拒绝启动；all 默认排除 live，避免无意消费。live 结果单独汇总。各 OS 跑 platform suite：

```sh
rtk proxy node scripts/test-continuous.mjs --suite platform
```

macOS/Windows/Linux 分别记录。平台无法可靠限制文件/命令时验证其观察模式和自主执行拒绝，不能标该平台自主写入通过。CT-10 起 platform suite 在两份实测文件（services 存储/工作区面 + bootstrap 执行策略/进程树面）于当前 OS 真实执行并把证据 JSON 写入 `os.tmpdir()/continuous-ct10-*`（路径打印到 stdout）；某平台从未运行过该 suite 时，其自主执行能力由 shared 登记表 fail closed（observe_only），登记追加必须随附该平台证据（`docs/release/continuous.md` 逐平台证据表）。

CT-16 起真实打包 app 验收单独执行（打包链重、按平台/机器取证，不并入 all）：

```sh
rtk proxy node scripts/test-continuous.mjs --suite packaged
```

runner 复用 packages/desktop 现有打包脚本（CLI 构建 → `pnpm build` 生产构建（renderer 无 bridge flag）→ `electron-builder --config electron-builder.config.js --dir`，产物为 unpacked .app 真实打包形态），在打包 app 内重复暂停/退出/恢复/停止/本地提交边界（E-34/E-01/E-02/E-15/E-16/E-11/E-17 打包形态重复）与 E-28 负向探针（run ID 在场、build flag 缺席 → 桥不暴露）。正向本地提交链仍受授权面声明测试命令为空约束（CT-12 已知限制 3），如实 blocked。

### 步骤 G：回归、汇总与发布

```sh
rtk proxy node scripts/test-continuous.mjs --suite regression
rtk proxy node scripts/test-continuous.mjs --suite all
rtk proxy pnpm verify:pre-push
```

CT-10 起 regression suite 入口存在（`packages/desktop/test/continuous/regression.test.mjs`，普通 production build 即无 bridge flag 构建）：E-26（bootstrap 既有测试真实重跑 + 权限 mode 枚举 canary + Continuous 不引入并行 Goal 链的 grep 事实）、E-27（recovery 停止链重跑 + 回滚顺序文档在场；「默认关闭探针」的证据归 E-28 独家记录）、E-28（production build 测试桥不可用 + 测试符号不进产物 bundle + Continuous tab 缺席 canary——隔离环境无凭据时首屏为欢迎/登录页、无法打开 Automations 页，tab 缺席证据不可得，该半边如实标 blocked 而非 passed/failed）。UI 级普通 Workflow Run 回归与手机 replayable 链路不由 regression 声称（归 e2e/mobile，其 blocked 状态见各自 artifacts/results.json）。

all = unit/integration/recovery/e2e/mobile/platform/regression，当前机器不能运行的 OS 单独标 unavailable，不伪造结果。多 OS 发布汇总合并各自结果。

release gate：核心 U/I/R/E 全部真实通过、功能回归通过、产品发布平台证据齐全、live 验收单独完成、无生产测试桥。核心失败或必需 live 验收 blocked 时，自主实施 flag 保持关闭；可以交付明确标识的只读观察能力。

## 5. 单元测试清单

| ID   | 测试               | 必须断言                                                                                                    |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| U-01 | 模型/schema/命令   | 非法状态、缺 identity/epoch、无 capability 拒绝；错误结构稳定                                               |
| U-02 | 状态迁移与授权     | pending 不暂停；Goal/Scope 改变撤销；Pause 与立即停止分开                                                   |
| U-03 | Scope 和变更量     | 路径、symlink、角色、forbidden、未知语义、累计文件/行数、binary/rename                                      |
| U-04 | 日预算与价格       | 原子预留、金额整数、价格版本、unknown、timezone、跨日、Unlimited                                            |
| U-05 | 执行期限与重试     | 请求3次、resume2次、1小时有效执行；上限暂停确认；正常阻塞不计时                                             |
| U-06 | Decision/Candidate | 局部过滤、去重、version resolve、dismiss、旧决策重核对                                                      |
| U-07 | Cadence/trigger    | interval 结束后计算、daily/DST、manual key、错过多轮合并                                                    |
| U-08 | 主动探活和有效计时 | 15秒探测、180秒无进展+3次失败确认；正常等待有owner/原因/期限；heartbeat不等于进展；有效/等待/离线区间持久化 |

## 6. 集成测试清单

| ID   | 设置/动作                                | 必须断言与证据                                                                              |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| I-01 | 旧 DB 升级、重开、重复 migration         | checksum 不变；旧 tasks/automations 原值；新表可读；SQL/FK 证据                             |
| I-02 | 两连接同时创建 Cycle                     | UNIQUE/事务只接受一个；不能靠内存 mutex                                                     |
| I-03 | 导入报告中途异常后重放                   | 队列/事件/cursor 同步；重复不新增；跨 Program FK 拒绝                                       |
| I-04 | worktree 和检查点                        | 原工作区字节与 Git 状态不变；失败只恢复归属明确路径                                         |
| I-05 | submitOnce 重发/不同内容                 | 一次执行；相同 ID 不同 hash/args 拒绝；session 绑定可恢复                                   |
| I-06 | Run 结束但工具/usage 未结束              | Cycle 保持 settling，不能提前下一轮；晚到 usage 入账                                        |
| I-07 | 多请求并行、重复/未知 usage              | reservation 不超发；幂等结算；费用/token 均持久化                                           |
| I-08 | typed report 增量/非法输出               | 运行中 Decision 已保存；非法输出不 done，不提交                                             |
| I-09 | 完整有限模板 + actual runtime            | 有限 ask、独立 review、测试、commit；新轮 actor ID 不复用                                   |
| I-10 | 10 pending + 3 independent + 2 dependent | 3 可执行，2 deferred，Program 非 paused，下一轮可运行                                       |
| I-11 | 两 Host/两 scheduler/旧 owner            | 一个执行权；过期不直接接管；旧 epoch 副作用拒绝                                             |
| I-12 | 同轮挂起、继续确认与grant                | 不cancel、不新Run；在途操作安全收尾；多上限合并一问；重复/旧version拒绝；授权增量不重置用量 |

## 7. 崩溃和重启矩阵

所有 R 用真实数据库和进程。barrier 是新增测试接口，只在受限 test composition 存在。

| ID   | 精确故障点                               | 恢复断言                                                                                    |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| R-01 | Cycle 保存后、提交前 kill                | 同 cycle/session/run 身份继续提交；无第二 Cycle                                             |
| R-02 | Run 接受后 ACK 丢失/kill                 | inspect 原 Run；只有一个 Run/actor 工作集合                                                 |
| R-03 | actor 写入后、节点完成记录前 kill        | 核对 diff/checkpoint；安全恢复或明确失败；不重复破坏写入                                    |
| R-04 | report 写入后、导入事务前/中 kill        | cursor 重读；Decision/Candidate 不双计，不丢已保存内容                                      |
| R-05 | Run completed 后、Cycle terminal 前 kill | settling 收尾；不 resume、不新 Run；保存结果和 nextCycleAt                                  |
| R-06 | 旧 lease 过期但旧 executor 仍活着        | 不启动第二写入者；撤销旧 epoch，确认停止再接管                                              |
| R-07 | reservation 后、usage 前 kill            | unknown 保留；无静默归零；晚到重复结算最多一次                                              |
| R-08 | terminal/nextCycleAt 事务中 kill         | 两者一起提交或一起回滚；不遗漏计划/重复 terminal                                            |
| R-09 | 正常退出、强杀、睡眠跨多周期             | 退出不执行；重开先旧轮；只补一次；离线时间不重置执行限额                                    |
| R-10 | Resume 脚本/模型/仓库变化或超限          | 不偷偷换模板；不可恢复明确保存证据；恢复次数超限暂停询问；用户取消不恢复                    |
| R-11 | 资源上限后用户未回答即重启/跨日          | 同Cycle suspended、pending确认、用量和占用保留；不自动恢复、不新Cycle；用户同意后同身份继续 |
| R-12 | normal_wait或疑似hang期间kill/restart    | 等待和有效时长保留；重新验证owner/操作期限；旧heartbeat不能冒充健康；没有固定墙钟取消       |

## 8. E2E 用例：设置、操作、断言、证据

所有 E 从真实 UI 操作，除时间、provider 和崩溃控制外不绕过业务接口。只读检查可以通过测试接口或停机后 DB 读取，不用 SQL 直接制造成功状态。

### E-01：创建并运行首轮

- 设置：空临时 workspace，已配置 fixture provider，目标页面有已知 UI 问题。
- 操作：打开 Continuous tab，填写 Goal/Scope/Budget/Cadence；确认初次授权。
- 断言：一个 Program/首轮 Cycle；分支/worktree 被创建；执行 cwd 正确；Run 有真实 journal；成功项实际验证和本地提交；Program sleeping，nextCycleAt 正确。
- 证据：创建表单/完成页截图、协议、SQL facts、Run、目标页面 before/after、测试 exit code、review、commit。

### E-02：未提交的用户改动受到保护

- 设置：原仓库含 staged、unstaged、untracked 三类改动。
- 操作：从 HEAD 创建 Program 并执行。
- 断言：界面说明不复制这些改动；原仓库文件/hash/status 原样；只在 Program worktree 有提交；无 push/merge/deploy。
- 证据：原仓库前后 manifest、独立分支 log 和 diff。

### E-03：三个独立改进完整验证

- 设置：Header spacing、mobile sidebar、empty state 三个已知问题。
- 操作：Run now；fixture 输出三个自主候选，实际 builder 逐项修改。
- 断言：builder 不并行；单项测试/浏览器/独立 Review 全通过才 done；三个可追踪提交；累计预算/文件/行数受限；目标页面390/1280无已知问题。
- 证据：各 candidate 的命令、几何/可访问断言、截图、review、commit、费用。

### E-04：10 个 pending 不阻塞独立改进（发布必需）

- 设置：上一轮通过真实报告发现10个 pending Decisions；新轮3个无依赖候选、2个相关候选。不得用 DB 直接塞成功/暂停状态。
- 操作：Run now；保持10个问题都不回答。
- 断言：3独立项实施/验证/提交；2依赖项 deferred；10项仍 pending；不存在等待人类的永久 ask；Program 不 paused；本轮结束；推进测试时钟后下一轮能运行。
- 证据：Decision/Candidate 关联、工具路径、Cycle/Run时间线、目标应用、第二轮身份。

### E-05：执行中新 Decision 只停止对应项

- 设置：第一个候选需要导航选择，另两个不依赖。
- 操作：执行期间触发专用 escalation。
- 断言：Decision 先持久化；该候选后续写入拒绝；工作流不等待人；另两项照常完成；普通 Workflow escalation 未变化。
- 证据：决策事件、授权撤销、scope_denied、后续两项提交。

### E-06：Resolution 进入未来 Cycle

- 设置：当前 Cycle 正在执行；另有 pending Decision 和关联候选。
- 操作：选择一个选项并提交；重复同请求，再发送旧 version 回答。
- 断言：resolution 只保存一次，旧版本拒绝；当前计划不变；未来 Cycle 重新核对并选相关候选；可追踪 decision→candidate→cycle→run→commit。
- 证据：回答截图、version、审计关系和未来轮记录。

### E-07：Dismiss、重复发现和局部 Scope

- 设置：同问题重复报告，旁边有不重叠的候选。
- 操作：Dismiss；执行下一轮。
- 断言：重复 Decision 合并来源；Dismiss 不授权实施；不相关候选继续；大范围路径不会被默认 blocking。
- 证据：去重记录、相关拒绝、独立提交。

### E-08：单轮预算耗尽

- 设置：费用/token额度足够第一项、不够后续项。
- 操作：运行并使第二请求需超额预留。
- 断言：超额请求未发provider；新写入在安全边界挂起；首项提交保留；同Cycle suspended、Program paused；AskUserQuestion询问是否增加额度继续；用户同意前不结算、不创建新轮，不反复消费。
- 证据：admission ticket、provider收到的请求数、部分结果和账本。

### E-09：跨日与未知用量

- 设置：provider 请求后丢 usage，重启；固定时区推进到次日，再补旧 usage。
- 操作：打开预算详情并触发下一轮。
- 断言：旧 unknown 不清零；晚到 usage 归原窗口且不双计；新一天额度正确，但已有资源暂停仍需用户继续授权；只有显式核销能消除未证实预留。
- 证据：两个窗口 ledger、重复事件拒绝、核销审计。

### E-10：Unlimited 仍有限

- 设置：日预算 Unlimited，小单轮费用/时间/文件上限。
- 操作：持续产生候选或 transient failures。
- 断言：有效时间/单轮上限触发挂起和继续确认，不自动取消；正常等待不触发时间上限；不存在无限自动重试；日无限不解除Scope。
- 证据：请求数、停止原因、累计activeDuration和实际diff。

### E-11：Pause 与立即停止

- 设置：正在执行候选。
- 操作：先 Pause，观察本轮结束后不新开；另一轮点击立即停止。
- 断言：Pause不误取消已在执行项；立即停止撤销写入、取消、等待停止后paused；旧Run不能自动恢复；UI两种行为可区分。
- 证据：按钮反馈、后续请求/写入数、取消原因与owner停止。

### E-12：测试/Review/浏览器失败

- 设置：分别注入非零测试、review拒绝、浏览器不可用。
- 操作：运行该候选及一个可独立验证候选。
- 断言：失败项不done、不提交；只能恢复所属修改；不可用标unverified；独立项仍可完成；模型“已通过”文本不能覆盖事实。
- 证据：exit code、review、unverified、恢复diff、保留提交。

### E-13：越界工具和恶意绕过

- 设置：尝试 `../`、symlink、绝对外部路径、任意shell、MCP写入、关闭sandbox、push/migration。
- 操作：fixture模型发真实工具调用。
- 断言：操作前拒绝；forbidden路径字节不变；没有外部提交；yolo不绕过专用限制；观察/审查角色不能写。
- 证据：真实tool记录、拒绝代码、文件manifest、网络/子进程调用记录。

### E-14：变更量和外部修改

- 设置：候选修改超过文件/行上限，或在barrier间由fixture模拟外部编辑。
- 操作：继续写入/恢复失败项。
- 断言：累计上限阻止进一步操作；外部内容不被覆盖；不全仓reset；不删除未知文件；无法归属时结束本轮并保留证据。
- 证据：前后hash、scope拒绝、检查点、取消原因。

### E-15：无改进与非法报告

- 设置：一轮返回空候选，另一轮报告不符合schema。
- 操作：运行两轮。
- 断言：空候选completed/no_changes后休眠；非法报告拒绝且不产生done/commit；报告尺寸/数量边界明确失败，不丢已有有效Decision。
- 证据：outcome、nextCycleAt、rejected report事件。

### E-16：重复启动与 ACK 丢失

- 设置：两scheduler同时wake，同一UI命令重传；吞一次启动ACK。
- 操作：Run now/推进时钟。
- 断言：一个Cycle、session和Run；不会靠新随机ID补偿；错误内容同ID明确拒绝。
- 证据：两请求、unique约束、journal计数、执行身份。

### E-17：退出、强杀与重启

- 设置：运行中达到R barrier。
- 操作：正常退出或只强杀本测试进程树；同数据根重开。
- 断言：退出后无新执行；重开先恢复旧Cycle；同Run安全resume或明确失败；completed仅结算；文件副作用不盲目重放。
- 证据：OS进程树、恢复前后IDs、diff、时间线。

### E-18：睡眠错过多周期与无 Host

- 设置：应用暂停，测试时钟跨三次到期；关闭所有可用Host窗口。
- 操作：恢复Host并打开页面。
- 断言：只补一次，不队列补三轮；Host不可用时无另起Agent；下次时间为未来。
- 证据：触发列表、进程数、Cycle数量。

### E-19：旧 owner 尚活与 stale 结果

- 设置：阻断续租使其过期，保留旧executor；新Host请求接管。
- 操作：旧executor继续发写入、usage、report；新Host恢复。
- 断言：旧写入/新请求拒绝；旧执行确认停止前不开新Run；usage允许幂等收尾；旧业务结果不覆盖新epoch。资源suspended仍保留占用，不能新开另一轮绕过上限。
- 证据：epoch、操作拒绝、停机证明、无重叠执行区间。

### E-20：Goal/Scope/Budget/模板/仓库变更

- 设置：活跃Cycle和冻结快照。
- 操作：修改Goal/Scope并重新授权；分别降低预算、改cadence、改模板或工作区内容。
- 断言：旧Scope立即失去许可；新轮使用新revision；预算降低挂起并询问；本轮显式grant才延长额度；cadence不插入当前轮；resume不换脚本；外部改动重核对。
- 证据：授权版本、old/new快照、工具限制、新Cycle。

### E-21：手机真实控制与重连

- 设置：隔离环境中手机浏览器连接桌面同一Host，390px。
- 操作：查看Program、Pause、Resolve、断网重连；重复已接受命令。
- 断言：同一program/cycle/run/owner；replay补正确状态；无重复Cycle；无手机新Agent；桌面实时链路和手机恢复链路均正确。
- 证据：两端截图、attachment、协议clientMode、进程数量。

### E-22：布局、主题、国际化与键盘

- 设置：390/768/1280，浅/深主题，当前所有支持语言；长Goal/Decision/错误。
- 操作：创建、展开队列、回答、打开Run侧栏，键盘操作。
- 断言：无横向overflow/按钮重叠；有可读标签和焦点；金额/风险信息完整；长文可读；状态不靠颜色表达。
- 证据：矩阵截图、bounding box、明确的可访问断言和人工复核；不假定当前已安装 axe。

### E-23：历史审计与事实展示

- 设置：混合成功、失败、部分、未知用量和resolved Decision。
- 操作：浏览Program历史、Candidate、Decision、Cycle、Run、commit。
- 断言：trigger、选择原因、deferred原因、预算、实际文件、验证和关联可追踪；费用标估算；pending数量不显示暂停；没有把Run completed当验收通过。
- 证据：每层截图与事实交叉核对。

### E-24：不支持的环境与旧 CLI

- 设置：远程workspace、旧CLI无capability、工具限制不可用的平台。
- 操作：尝试创建或Run now。
- 断言：明确不支持；不回退普通prompt或本地同名路径；没有绕过授权写入；可观察的模式明确只读。
- 证据：capability、结构化错误、无Run/无文件副作用。

### E-25：跨平台路径与取消

- 设置：各OS、含空格/Unicode/大小写/符号链接路径。
- 操作：worktree、运行、立即停止、强杀恢复。
- 断言：argv正确、取消整棵所属进程树、路径范围正确、FK和锁一致；无任意shell依赖。
- 证据：平台信息、命令argv、进程树、实际文件。

### E-26：现有功能回归

- 设置：普通交互session、Goal、Workflow和automation。
- 操作：CreateWorkflow确认、saved start、resume、amend、automation、Plan/Goal互斥和权限模式。
- 断言：原确认规则、actor模型pin、imported cache、普通人工escalation、交付语义不变；Continuous不新增mode枚举或并行Goal loop。
- 证据：已有bootstrap测试及实际UI/Run回归记录，不假定已有覆盖。

### E-27：关闭与回滚

- 设置：有活跃Cycle、历史和用户原始改动。
- 操作：关闭flag/调度并按ticket顺序回滚入口。
- 断言：先撤销新操作、等待停止；历史/分支/提交/用户文件保留；无新唤醒；旧产品入口可用。
- 证据：停机证明、DB/文件before-after、旧入口回归。

### E-28：生产测试桥关闭

- 设置：普通production build，以及只有ZCODE_ENV=test而无双重测试标识的build。
- 操作：尝试读测试桥、改时钟、注入provider或kill barrier。
- 断言：均不可用；测试接口不因环境名而开放；正常产品功能运行。
- 证据：capability/IPC拒绝、bundle检查和实际访问结果。

### E-29：正常阻塞超过一小时仍继续

- 设置：单轮上限一小时；全部可执行actor进入已注册的长测试/外部请求等待，适配器返回具体owner、原因、期限和可核对阶段证据。
- 操作：每15秒主动探活，推进墙钟超过一小时，再让外部操作完成。
- 断言：始终normal_wait；不弹时间额度问题、不取消Run；正常等待区间不计有效时间；同Cycle/Run继续执行并验证；恢复前后累计有效时间不重置。某个actor等待而另一个仍工作时，仍累计有效时间。
- 证据：health快照序列、操作deadline、active/blocked/wallClock三个时长、同Run后续节点和目标页面结果。

### E-30：健康工作达到一小时暂停并询问

- 设置：actor持续产生真实进展，无全轮normal_wait；有效时间累计至一小时。
- 操作：打开继续确认，先保持暂停，再选择“增加本轮1小时继续”。
- 断言：不因健康而无限豁免；安全边界suspended，不cancel/fail/新Cycle；grant落库后同Run继续；总允许时间为2小时，已用1小时保留；新Cycle仍默认1小时。
- 证据：有效时长、AskUserQuestion截图、grant、未发生新操作区间、恢复身份。

### E-31：探活识别卡死，heartbeat不能掩盖

- 设置：仅heartbeat更新，无节点/工具/模型进展、无正常等待依据；另外对照合法长等待及Host断联。
- 操作：推进180秒并完成连续3次主动验证；尝试重复确认请求。
- 断言：疑似hang保存诊断并挂起询问，不直接将整轮failed/cancelled；仅进程活着不足以判健康；合法等待继续；unreachable进入恢复核对；到期等待无进展也不能无限豁免。
- 证据：三次probe、最后进展、等待分类、诊断与一条确认；旧操作未确认停止前不得第二次执行。

### E-32：用户继续授权、跨日与重复回答

- 设置：同轮同时费用/token上限，触发一条pending继续请求，应用退出并跨日。
- 操作：重开；先不回答，再授权本轮增加USD100和10亿tokens；重放相同回答、旧version回答；另一轮选择结束本轮。
- 断言：跨日/重启不默认同意；额度增量和用量均保留；重复回答不重复扩额；下一轮仍使用默认值；只有用户结束才cancelled/partial；Scope禁止项不能通过继续绕过。
- 证据：请求version、原/新限额、grant/usage、同Cycle/Run、用户取消记录。

### E-33：并发上限10且预算原子化

- 设置：test composition实际并发能力10；有限模板发起11个只读actor任务并用barrier让它们同时竞争，另外测试builder唯一写入。
- 操作：启动Run，释放barrier；同时提交需要争用费用预留的请求。
- 断言：同时运行最多10，第11个排队；builder最多1；原子reservation不超额度；不得用高并发绕过token/cost；较低平台能力在UI显式展示。
- 证据：actor运行区间、并发峰值、排队事件、账本和实际capability。

### E-34：新默认值、整数精度与界面

- 设置：创建表单无自定义值，选择默认预算；另一组输入超出安全整数的token/grant。
- 操作：创建Program，读取配置与Cycle快照；打开预算和健康状态，触发上限确认。
- 断言：并发10、token1,000,000,000、单轮USD100、每日USD1,000、有效时间3,600,000ms；金额按微美元存储；大整数验证无截断/溢出；界面同时显示最近探活/等待原因/有效和墙钟时间；未来模板不得恢复旧默认值。
- 证据：表单截图、schema结果、DB/config快照、计算断言。

## 9. 时间、等待与故障注入

用可注入 Clock 控制Supervisor和预算窗口；不修改工作流VM的Date/随机限制；Clock区分墙钟、有效执行与已确认正常等待，不使用固定墙钟timeout直接取消Run。tick只唤醒，不直接创造Cycle。

等待条件必须是 observable event、协议ACK、状态revision或文件/进程事实，具有超时和失败artifact。禁止“等5秒以后应该完成”作为验收。

先记录barrier到达，再执行故障。ACK丢失和usage延迟在transport/provider adapter注入，不能删DB行制造另一种故障。forced kill通过测试process adapter跨平台停止本run进程树；正常退出另测，不能互相代替。

UI用accessibility和稳定test IDs定位，不靠翻译文本或像素坐标。截图用于人工检查，几何/状态断言用于机器验证。

## 10. 报告与完成标准

结果状态只有 planned/passed/failed/blocked/skipped。核心用例不允许以skipped发布。runner启动失败、测试数量为零、未找到配置或fixture均不是passed。

退出码语义（runner 与编排入口 `scripts/test-continuous.mjs` 一致）：failed 用例、runner 启动/预检失败、suite missing、live 未显式 opt-in 均返回非零；blocked 不是失败——capability/平台/浏览器/凭据不可用时 runner 如实把用例与 suite 状态记为 blocked（报告 JSON 与编排层 summary 均保留），退出码为 0，由 release gate（步骤 G）消费 blocked 并保持自主实施 flag 关闭。把 blocked 编码成非零退出码会让默认关闭阶段（Host 装配属开启前置，见 docs/release/continuous.md §2）的 e2e/mobile 永远无法通过自身门禁，也与「blocked 状态见各自 artifacts/results.json」的发布语义冲突。

每个case记录：

```json
{
  "caseId": "E-04",
  "status": "planned",
  "executionKind": "scripted",
  "sourceCommit": "<commit>",
  "platform": "<os>",
  "command": "<actual command>",
  "exitCode": null,
  "assertions": [],
  "evidence": [],
  "failureReason": null
}
```

最终验收记录必须分别列：脚本化链路通过情况、live质量验证、各OS自主执行能力、手机恢复链路、旧功能回归、未验证范围、实际消费、清理/回滚证明。

当前文档阶段仅完成规划与文档验证。不能填写Continuous功能passed；下一轮实施按CT和本文用例逐项补实际结果。

## 2026-10-05：发布 §2.1 修复验证与下一步完整验收

实施顺序见 [遗留问题 Ticket](../tickets/continuous-release-gaps.md)。以下分开记录当前已执行结果与产品接入后的验收流程。

## 本次实际结果

CT-16 增补（2026-10-06，见 tickets/records/CT-16.md）。**实际 Node 版本：v25.8.0**
（`mise.toml` 为 `>=24` 下限，本机未安装 mise；pnpm 10.33.2 与 mise 一致；版本写入各
results.json 的 `nodeVersion`）。分工：本 ticket 实测 packaged/platform/live 与
services/bootstrap 包级全量、host 项目类型检查；root typecheck/lint、unit/integration/
recovery/e2e/regression 与格式检查由统一门禁在工作流脚本执行（结果以其运行为准，本文
不预填）。逐项：

- **packaged suite（新增，`node scripts/test-continuous.mjs --suite packaged`）真实通过
  （exit 0：9 passed / 0 failed / 0 blocked）**：electron-builder unpacked `.app`
  （真实打包形态；`--dir` 只出 .app 不出 dmg 安装器——安装器是同一 .app 的分发包装，
  如实记录未测）内重复暂停（E-11 Pause/Resume）、退出（正常退出保存 interrupted）、
  恢复（重启后 Host 启动核对同 Cycle/同 Run 恢复至 completed，无第二 Cycle/执行者，
  provider 计数证明真实重放）、停止（E-11 立即停止 cancelled）、本地提交边界（无验证
  候选零本地提交 + 原仓库字节不变；正向提交链如实未驱动——授权面声明测试命令第一版
  为空，CT-12 已知限制 3）与 E-34/E-01/E-02/E-15/E-16 打包形态重复；E-28 打包半边
  （run ID 在场、build flag 缺席 → 桥不暴露）。进程级证据：随包
  `resources/glm/zcode.cjs` 指纹 == 本次 CLI 构建，且 spawn preflight 显示打包 app 以
  该随包文件启动（launcher 固定中性 cwd——dev 候选 findUpward 会从仓库 cwd 解析到
  checkout dist，字节虽同、取证弱化）。证据目录：
  `os.tmpdir()/continuous-ct09-packaged-*/artifacts/`（最终代码形态复核 run 目录
  `continuous-ct09-packaged-7YFFAH`，testRunId `806a6a2d-d63b-4cd4-a2b0-e4ddd49fd619`，
  含 9 用例截图/SQL facts/退出前后对照与 results.json（nodeVersion v25.8.0）；全新
  构建轮与中间复核轮同样 9 passed/exit 0）。
- **打包链路暴露并修复真实缺陷 3 处**（每处中文注释说明依据）：①Host 启动核对未接线
  （装配只有 wake/interrupt 入口，重启后 interrupted 轮要等 cadence wake——新增
  `recoverAllOnStartup`，D2/§10）；②wire 会话路由实例内丢失（重启后 inspect 以空
  workspace 发送→读期限超时→退避→resume_limit 挂起——`getCycleByExecutionSession`
  持久化事实解析 + 未登记会话先 ensureExecutionSession 复活）；③租约接管的防御性
  `stop`（用户停止语义，admission 永久 revoked）毒化同 Run 恢复（改 interrupt 语义；
  scheduler/recovery 测试同步钉死新行为）。另修复 assembly 测试 double 不回 health
  快照导致的失联冻结竞态（double 如实回 reachable 快照；unreachable 语义由 ct14
  专用用例覆盖）。
- **platform suite 复核 exit 0**（darwin-arm64，Node 25.8.0；证据 JSON
  `os.tmpdir()/continuous-ct10-*`）。**其他平台如实未验证**：win32/linux 无机器，
  保持 observe_only（release 文档 §1），不因代码审查或单平台通过外推。
- **live：`node scripts/test-continuous.mjs --suite live --allow-live` 真实执行 →
  exit 0、状态 blocked**（E-01/E-03/E-04 三用例如实 blocked：无已配置测试身份
  `ZCODE_E2E_LIVE_PROVIDER_KEY`；不由 agent 输入个人凭据，不用模拟结果替代）。
  修复：live 汇总断言与 §10 对齐（旧断言要求 blocked===0，把「无凭据」折叠成
  failed/非零，entryReport 与退出码矛盾）。
- **包级全量**：services `npx tsx --test "test/continuous/*.test.ts"` → 130/130；
  bootstrap 同款 → 83/83；`tsc -b packages/shared packages/services
packages/desktop/tsconfig.host.json` → 0。
- **手机恢复链路**：E-21 仍如实 blocked（外部 relay 不在仓库，连接真实 relay 需个人
  凭据，§3/§4 禁止）；packaged 形态未新增手机断言。
- **未验证范围（如实）**：dmg/zip 安装器分发形态；win32/linux 平台；darwin-x64；
  live 真实模型质量（usage/compaction/sidecar/限流/unknown/无进展/同轮继续——需
  测试凭据）；正向本地提交链（授权面声明测试命令为空）；e2e 时钟类与候选路径用例
  （CT-15 既有 21 个 blocked 理由不变）。
- **实际消费**：脚本化 provider 虚构固定价目（不产生真实费用）；live 未运行（无凭据，
  零消费）；打包构建本地产物不外发。
- **清理/回滚证明**：packaged suite 成功路径清理临时数据目录、保留 artifacts 报告
  （runner 既有语义）；测试新增文件独立可删（packaged\*.mjs + suite 注册行）；产品修复
  三处各自独立可回退（见 CT-16 记录）；`packages/desktop/dist` 打包产物为构建输出、
  不入版本库。

CT-15 增补（2026-10-06，见 tickets/records/CT-15.md）：e2e/regression/mobile suite 重写为
真实驱动并多轮真实执行（run1…run15）。**e2e suite 真实通过（exit 0：9 passed / 0 failed /
21 blocked / 0 skipped / 0 planned）**：E-01/E-02/E-15/E-16（首轮执行链：空候选轮经真实
UI→Host→CLI→脚本 provider 完成 no_changes、重复 Run now 被 open_cycle_exists 幂等吸收、
原仓库用户改动与工作树字节不变、零提交）、E-08（单轮 USD1：超额请求未发 provider、
suspended+paused+唯一 pending 确认、继续确认对话框真实出现）、E-11（Pause 静止态不新开轮；
停止确认框→cancelled、lease 释放）、E-34（表单默认值/超安全整数拒绝/微美元落库）、E-24
（装配开/关双实例的 tab 门与零副作用）、E-28（双条件桥正反实例）；regression E-26/E-27/
E-28（production 无 flag build 真实导航后 tab 缺席 canary 通过；此前记录的「E-28 断言失败
被 entryReport 漏记」已修复——失败先落 failed+证据，编排层交叉核对退出码）；mobile E-21
如实 blocked（外部 relay 不在仓库，连真实 relay 需个人凭据）。E2E 暴露并修复的真实产品
缺陷 5 处（session/create 外部 sessionId 守卫改为「已存在才拒绝」、
continuousManagedCyclesOptionFor 漏传 store、金丝雀子进程缺 ELECTRON_RUN_AS_NODE 且无
期限、DWF actor 会话 task link 的父会话 FK（Host 受控会话无用户轮未落库，新增
ensureParentSessionPersisted 接缝）、Host shutdown 先清 activeServices 致 interrupt 必
失败）。如实 blocked 的 21 个用例：候选路径需完整 builder/reviewer 脚本序列与授权面声明
测试命令（第一版为空）；时钟类（E-09/E-10/E-18/E-29/E-30/E-31）需测试时钟注入——与
「生产不得暴露故障注入」冲突，需产品决策。Node 25.8.0（mise 固定 24.14.0 未装——CT-16
重跑）。

CT-14 增补（2026-10-06，见 tickets/records/CT-14.md）：integration suite 新增两份测试
（services `ct14-probe-communication.test.ts` 6 用例、bootstrap `ct14-probe-waits.test.ts`
6 用例）登记进 runner manifest（integration 161/161）。覆盖：读操作通信期限（超时/传输
失败 → 结构化 execution_unreachable 且消息携带期限事实）、探活 RPC 失败按 unreachable
冻结（不发 wire 挂起、保存 interrupted + `cycle.execution_unreachable` 证据、Program
paused）、监督循环读报告失联退出并冻结（不抛异常不空转）、失联冻结不覆盖执行权已改变
的轮（epoch/游标原样）、两小时登记等待跨一小时墙钟仍继续且等待失效后重新计时、操作等待
登记生命周期（完成/取消/过期/旧 epoch 移除、runId 隔离）、journal backoff 与登记等待的
整轮覆盖聚合（任一 actor 工作不豁免）、trusted 端口声明测试的真实期限登记与浏览器验证
通信期限（超时如实 unverified 不伪造证据）、适配器 inspectHealth 快照聚合与 epoch 高水位
过滤。既有 U-08/E-29/E-30/E-31/R-12 与「发布 2.1」健康写入守卫全量复跑通过（健康工作一
小时暂停询问、180 秒 + 3 次失败探测 hang 确认、中途暂停/执行权改变不被旧快照覆盖、重启
不累计离线时间）。未执行 e2e/mobile/regression（真实 UI 场景归 CT-15）。

CT-13 增补（2026-10-05，见 tickets/records/CT-13.md）：integration suite 新增两份测试
（services `ct13-budget-communication.test.ts` 9 用例、bootstrap `ct13-budget-communication.test.ts`
6 用例）登记进 runner manifest；包级复跑 services 124/124、bootstrap 77/77（含既有全部
Continuous 测试）。开发中被新测试暴露并修复的真实缺陷 3 处：①领域 limitKind `cycle_token`
与 wire 枚举 `cycle_tokens` 不一致——token 超限的 denial 在 CLI 侧解析失败被误报成
`ledger_unreachable`；②并发拒绝通知撞「同轮唯一 pending」索引直接失败（未合并）；③恢复成功
后的同回答重放被 `program_not_runnable` 拒绝（重复回答应幂等回执）＋同 version 不同 grant
的异答被当 no-op 吞掉（应 version_conflict）。未执行 e2e/mobile/regression（真实 UI 用例与
窗口就绪预检归 CT-15）；真实 provider 定价写入仍归 CT-16。

CT-12 增补（2026-10-05，见 tickets/records/CT-12.md）：integration suite 新增两份测试
（services `assembly.test.ts` 7 用例、bootstrap `registration.test.ts` 3 用例）登记进
runner manifest；包级复跑 services 115/115、bootstrap 71/71（含既有全部 Continuous 测试）。
未执行 e2e/mobile/regression（窗口就绪预检与真实 UI 用例实现归 CT-15）；价格快照注入面
（`continuous/pricing-snapshot.json`）在测试中经装配参数注入，真实 provider 定价写入归
CT-13/16。

| 验证                     | 结果                             | 证据范围                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit                     | 44 passed / 0 failed             | 领域、契约与 runner 自检                                                                                                                                                                                                               |
| integration              | 149 passed / 0 failed            | 真实 SQLite、Git、文件、DWF 子进程；包括预算等待、同 Run 继续、退出 interrupted、监督时间暂停和原子健康写入；CT-13 起含预留传输校验/拒绝观测三分/合并确认/retry_limit 继续授权/旧 errored 轮结束与新开；部分端口用替身，不等于完整产品 |
| recovery                 | 17 passed / 0 failed             | 存储重开与恢复；进程 kill 多为同库新实例模拟                                                                                                                                                                                           |
| platform                 | 10 passed / 0 failed             | 当前 darwin-arm64 的真实文件/进程/Git/数据库；不替代安装包或其他平台                                                                                                                                                                   |
| 根类型检查、CLI 类型检查 | passed                           | CLI 27 个 task 成功；有 workspace lockfile 警告                                                                                                                                                                                        |
| 根 Lint、CLI Lint        | passed，0 errors                 | 原仓库已有警告，不声称零警告                                                                                                                                                                                                           |
| Electron e2e             | 30 blocked / 0 passed / 0 failed | 真实构建并启动 Electron；窗口未就绪，未完成 Automations 导航；生产测试桥的无 flag 构建半边未在该 suite 验证                                                                                                                            |
| mobile、live、安装包     | 本次未执行                       | 不能写成 passed                                                                                                                                                                                                                        |

全仓 `pnpm fmt:check` 未通过：34 个本次未修改文件存在格式问题（含用户已有 `.zcode` 计划），本次没有修改这些文件；本次改动文件单独格式检查通过。

regression suite 已执行并失败（退出码 1）：E-26 bootstrap 既有测试与 E-27 停止/回滚检查通过；E-28 production build 无法打开 Automations 页面，`canary 必须先打开 Automations 页面` 断言失败。runner 的 case 报告漏记了这次失败，entryReport 错误显示 passed；统一 runner 仍正确保留 failed/exit 1。需 CT-15 同时修复导航预检和失败用例报告，不把它记成通过。
regression 证据：`/private/var/folders/q9/kv1rgzmd33317h52wmx6fgzr0000gn/T/continuous-ct09-regression-uFbiqY/artifacts/`。

本次使用 Node 25.8.0，`mise.toml` 固定为 24.14.0；本机未安装 mise/固定 Node。固定版本重跑是 CT-16 的必需条件。（CT-16 更正：`mise.toml` 现为 `>=24` 下限——`e941526` 放开；Node 25.8.0 满足下限，CT-16 已按该口径复跑并记录版本，见本文 CT-16 增补。）
integration testRunId：`12eba9b5-ab27-4196-a693-0c45108d5a3d`；recovery：`c60d624e-9546-426a-92b1-68ffae735c67`。
E2E 原始证据目录：`/private/var/folders/q9/kv1rgzmd33317h52wmx6fgzr0000gn/T/continuous-ct09-e2e-rwDJvA/artifacts/`。
该报告的 sourceCommit 是执行时 HEAD，源码有本次未提交修改；它不单独代表被测试源码。下一轮按 CT-15 补工作树差异标识。

## 可复现的自动流程

从仓库根目录执行，运行前先确认 `mise.toml` 的 Node/pnpm 与实际环境一致；本地 shell 按仓库要求加 `rtk proxy` 前缀：

```sh
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm --dir apps/zcode-cli typecheck
pnpm lint
pnpm --dir apps/zcode-cli lint
pnpm architecture:check --changed
pnpm fmt:check
node scripts/test-continuous.mjs --suite unit
node scripts/test-continuous.mjs --suite integration
node scripts/test-continuous.mjs --suite recovery
node scripts/test-continuous.mjs --suite platform
node scripts/test-continuous.mjs --suite e2e
node scripts/test-continuous.mjs --suite mobile
node scripts/test-continuous.mjs --suite regression
node scripts/test-continuous.mjs --suite packaged
```

live 单独执行 `node scripts/test-continuous.mjs --suite live --allow-live`，使用已配置的测试账户/模型，费用计入真实预算；没有配置则保持 blocked（exit 0、状态 blocked，§10 语义；由 release gate 消费）。packaged 打包链重（CLI+desktop 生产构建+electron-builder）且按平台取证，`--suite all` 不含 packaged/live，需单独执行；可加 `-- --skip-cli-build --skip-desktop-build --skip-package` 复用既有产物。
任何 blocked/missing 都不能满足开启条件，runner 退出码 0 也不等于业务场景 passed。

## 产品接入后完整 E2E 流程（CT-15 待实施）

每次创建隔离 home、tasks-index、session journal 和临时 Git 原仓库；原仓库预先放一项用户未提交修改。记录 base commit/工作树差异、平台、Node、testRunId。模型使用脚本 fixture，所有命令通过真实 UI → Host → CLI 路径；时钟和故障由测试专用受控接口注入。

| 步骤             | 真实操作                                                                                          | 必须核对的事实                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1. 能力与创建    | 等窗口和 Automations 页可见；点击 Continuous，填写 Scope、目标和确认                              | capability 实际返回；默认值为 10 / 10 亿 / USD 100 / USD 1000 / 有效一小时；一条 Program；原仓库用户修改不变                |
| 2. 执行与重发    | Run now，重复发送同 requestId，再发另一个 requestId                                               | 一条开放 Cycle、一个 Run、一个执行权；重复返回同身份，另一请求不并行新开                                                    |
| 3. 授权和验证    | 模型给出独立低风险候选与一个需要决策候选；通过受控工具实施                                        | 一名 builder；独立项继续；需决策项无写入；真实测试退出码、390/1280 浏览器证据和独立 Review 可关联同 candidate/run/epoch     |
| 4. 本地交付      | 验证成功后提交；失败/缺证据时再尝试提交                                                           | 只有 Program 分支有验证通过的提交；原分支/原仓库修改不变；无 push/merge/deploy；缺任一验证没有提交                          |
| 5. 越界拒绝      | observer/reviewer 写入；builder 写其他候选、protected/原仓库、链接目标；任意 shell、MCP、旧 epoch | 在真实文件/进程/调用记录确认零副作用；检查后 symlink 替换也不能绕过；yolo 和用户扩额不能扩大 Scope                          |
| 6. 各资源上限    | 分别使单轮 token、单轮费用、日费用、文件/行数达到限额；10 路请求争抢最后额度                      | 先冻结再暂停，provider 调用数不增加；预留/unknown 均占额度；一条合并 pending 确认；原 Cycle/Run 保留                        |
| 7. 回答与继续    | 选择增加额度，重放同回答，发旧 version；再选保持暂停或结束                                        | 增量只生效一次；Host running 落库后才唤醒；同 Run 完成；保持暂停无请求；结束取消工具并保留账本；不清零已用量                |
| 8. 正常长等待    | 实际登记责任方、原因和两小时期限；推进墙钟超过一小时；再让一个 actor 开始工作                     | 全部正常等待时有效时间不增加、继续探测、不误报；任一 actor 工作时有效时间增加；完成/取消/期限失效移除登记                   |
| 9. 一小时与 hang | 持续健康工作累计一小时；另一轮冻结真实动作但继续 heartbeat                                        | 前者 time_limit 暂停；后者 180 秒且 3 次失败探测才 suspected_hang；均询问用户，不 failed/cancelled；授权仍用同轮身份        |
| 10. 退出与恢复   | 预算等待、正常执行和正常长等待期间分别退出应用，再启动                                            | 退出 interrupt 等工具收尾，无后台工作；预算暂停确认仍 pending；正常执行 interrupted 同 Run 恢复；离线不计时，先旧轮后未来轮 |
| 11. 故障与幂等   | 保存身份后、ACK 后、usage 前、报告导入前分别终止子进程/重启；模拟 Host 通信阻塞                   | 无第二个 Run；unknown 保留；游标去重；有界探测报告失联；旧版本/旧 epoch/已 cancelled 状态不被晚到探活覆盖                   |
| 12. 手机重连     | 手机连接桌面 attachment，开始/暂停/回答；断线后重连，重复提交回答                                 | 同 Local Host/Run/workspaceIdentity；snapshot/sequence 补缺口；不重复扩额或创建 actor；桌面退出后手机不能另起运行           |
| 13. 关闭与生产   | 关闭功能后重开、普通任务/Workflow/Automation 回归；普通 production build 检查测试接口             | Continuous 入口由 capability 控制；已有数据/worktree 保留；普通行为不变；无故障注入与测试 store bridge                      |

所有步骤保存 UI 截图、命令关联 ID、数据库/journal 序号、预算明细、真实 IO/进程/Git 证据。仅看到 UI 文案或直接修改 store 不算验收。现有 E2E 的 blockedCase 必须替换成这些真实操作；未实现步骤逐项保留 blocked，不用通用预检结果代替。

上线判定：先完成 CT-11…16，核心 U/I/R/E 与兼容回归真实通过、手机和 live 完成、安装包与目标平台验证完成，再开放自主实施。CT-11…16 已全部实施；当前仍不满足——live blocked（无测试凭据）、手机 E-21 blocked（外部 relay）、win32/linux 平台无机器证据，自主实施 flag 保持关闭。
