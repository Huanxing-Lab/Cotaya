# Continuous 功能实施汇总（feature/continuous-mvp）

- 汇总日期：2026-10-05。
- 依据：结构化执行数据（本轮工作流编排产出）、`docs/tickets/records/CT-00.md`…`CT-10.md` 逐 ticket 记录、`git log main..feature/continuous-mvp` 与 `git diff --shortstat main...feature/continuous-mvp`（本汇总本地实测：163 个文件，+33720/−35）。
- 分支：`feature/continuous-mvp`（对比基线 `main`），共 13 个提交：
  - `761a24b` 规格/tickets/测试文档基线（CT-00 前置）；
  - CT-00…CT-10 共 11 个 ticket 提交；
  - `8cded8f` 整体评审问题处置；
  - `830bd17` 最终验证修复。
- 配套文档：`docs/specs/continuous.md`（产品规格）、`docs/testing/continuous.md`（测试/E2E 计划）、`docs/release/continuous.md`（发布、开启前置与回滚）。
- 状态词表：passed / failed / blocked / planned / unverified。凡未执行或证据不可得，一律如实标注，绝不写成通过。

## 1. Ticket 实施状态

| Ticket | 标题 | 状态 | 提交 | 轮次（含门禁修复轮） |
| --- | --- | --- | --- | --- |
| CT-00 | 锁定契约和测试入口 | 已提交 | `ebe2a64` | 1 |
| CT-01 | 长期状态和事务 | 已提交 | `ba241cb` | 2 |
| CT-02 | 独立工作区、操作范围和交付 | 已提交 | `09372a0` | 1 |
| CT-03 | 受控 Run 身份、报告和停止 | 已提交 | `4acb75f` | 2 |
| CT-04 | 预算、暂停确认、主动探活和模型准入 | 已提交 | `fceca4d` | 1 |
| CT-05 | 手动完整 Cycle 与固定模板 | 已提交 | `1c3cf15` | 1 |
| CT-06 | 非阻塞 Decision Queue | 已提交 | `53c790c` | 1 |
| CT-07 | 周期、租约与恢复 | 已提交 | `a5e9d0a` | 2 |
| CT-08 | 桌面与手机 UI | 已提交 | `1a389a6` | 1 |
| CT-09 | 真实 E2E runner 和故障证据 | 已提交 | `fdcb953` | 2 |
| CT-10 | 跨平台、兼容回归与发布 | 已提交 | `048aa89` | 2 |

各 ticket 要点（细节以 `docs/tickets/records/CT-XX.md` 为准）：

- **CT-00**：`continuous-protocol.ts` 严格 schema（capability、状态枚举、策略、10 个 `continuous/*` 命令、结构化错误）、services 受控模块骨架（contract/domain/application ports，无实现副作用）、`scripts/test-continuous.mjs` 测试入口（显式 manifest、不吞退出码、live 需 `--allow-live`）。capability 拒绝先锁定在协议/契约层。
- **CT-01**：tasks-index 0004 migration（规格 §5 全部 9 张 `continuous_*` 表、CHECK/UNIQUE/部分唯一索引、ON DELETE RESTRICT）；adapters 7 文件（JSON 字段 zod 校验）；`continuousService` 唯一写入口。并发正确性以 4 worker 独立连接 + Atomics barrier 验证数据库约束（恰 1 成功、失败均 SQLITE_CONSTRAINT）。
- **CT-02**：worktree/分支/候选检查点（按指纹逐路径恢复，绝不整仓 reset/clean）与 bootstrap 侧执行策略纯函数（observer/reviewer 只读、单 builder、argv 白名单、受保护路径、变更预算）；全部拒绝 `scope_denied` + reason 审计。**已知限制：策略在产品路径零执行点（见 §2 未决项）。**
- **CT-03**：§11 九方法执行适配器（含 suspendAtSafeBoundary/resumeSuspended/inspectHealth）、`submitOnce` 幂等裁决、dwf-journal 报告读取、v4 命令 `continuousManagedCycle`（默认关闭）。
- **CT-04**：微美元整数预算准入（事务内原子汇总+判定+落库）、同轮唯一 pending 续期确认（version 乐观幂等）、15s 探活分类服务、`ModelRequestAdmission` 接缝闸门（缺席逐字不变，wiring 测试钉住）。
- **CT-05**：报告协议 V1（done 门=tests/browser/review 三阶段最新结果全 passed）、候选选择策略、supervisor 全链路（授权核对→workspace 准备→Cycle 快照→submitOnce→增量导入→settle）、`ui-ux-v1` 固定模板（决策先于实施、三验证过才 commit）。预算/重试失败按 §6.1 挂起。
- **CT-06**：分类双检查、局部阻塞谓词唯一实现、resolve/dismiss 单事务写入（version 守卫、终态粘性）、escalate 先持久化再撤销写入许可并返回结构化 defer（不等人）、driver `wrapEscalatePort` 最小接缝。
- **CT-07**：cadence/退避、workspace lease（epoch 单调、旧 owner 存活核对）、§10 恢复顺序（先未结束后到期、有限 resume、不可恢复 failed+证据）、supervisor 重构与控制面、desktop wake 链路（scheduler 只读查询→Main 仅转发→Host 注册制路由，无人注册=默认关闭）。修复 3 个真实竞态与 1 个语义缺陷（结算保持用户已 Pause 状态）。
- **CT-08**：wire 契约（协议小版本 1）、`ContinuousCommandService` 单一命令/查询门面（业务全委托既有服务）、UI（useContinuous hook、设置页八文件、Automations tab、继续确认四选项、i18n en-US/zh-CN）。Electron Host 侧注册留待装配（交付全部接缝，默认关闭）。
- **CT-09**：真实 E2E runner（临时根隔离、越界/symlink 校验、CLI 构建 fingerprint、Electron 双实例、脱敏证据）、fixtures（脚本化 provider 故障注入、目标应用、可控时钟）、e2e/mobile/live suite 入口与 runner 自检。附带修复 CLI 打包 alias 缺陷（`@zcode/shared/continuous-protocol`）。
- **CT-10**：平台能力登记表与 fail-closed 评估（未登记一律 observe_only）、darwin/arm64 真实 platform suite、regression suite（真实 production build + Electron 探针 E-26/E-27/E-28）、release 文档（逐平台证据、开启装配清单、有序回滚）。Windows/Linux 无机器，如实 observe_only 未验证。

### 门禁修复轮原因（轮次 > 1 的 ticket）

- **CT-01（2 轮）**：spec 表格行尾管道未对齐，oxfmt 格式化后过门禁；代码与首轮一致。
- **CT-03（2 轮）**：首轮 verify 清单误入两条改动前即非绿的包级 lint 基线命令；`git stash` 对照证明 CT-03 引入零 lint finding（计数逐字相同），代码零改动，改为定点 oxlint 并在记录留档。
- **CT-07（2 轮）**：verify 命令路径/入口写错（tsc 包路径拼接、oxfmt 变量展开为空、architecture 入口），代码零改动，从仓库根重写命令后逐条真实执行通过。
- **CT-09（2 轮）**：`docs/testing/continuous.md` 表格列宽不满足 oxfmt --check，规范化后复验。
- **CT-10（2 轮）**：regression suite stdout 380KB 超编排上限（vite 生产构建回显）→ runner 增加 quiet 模式（完整输出只落 artifacts/logs），复测 exit 0、stdout 13.9KB。

## 2. 整体评审结论与处置

评审范围：feature 相对 main 的全量 diff 与提交历史（评审时点记录为 12 个提交、161 个文件、+33217/−35；其后 `830bd17` 最终验证修复落地，本汇总实测当前为 13 个提交、163 个文件、+33720/−35），对照 `docs/specs/continuous.md` §4/§5/§9/§10/§11、AGENTS.md 工程边界与 tickets 禁改清单。

**结论：整体架构质量高。** 分层（UI→hooks→单一 command service→domain/application/adapters）、wake 链路职责（scheduler 只读、Main 仅转发、Host 路由不存业务状态）、schema/事务/唯一约束（one-open-cycle 与 one-pending-continuation 部分唯一索引、lease 同有同空 CHECK）、预算准入原子性（BEGIN IMMEDIATE、微美元整数单一实现、幂等结算/unknown 保留/显式核销）、submitOnce 幂等裁决、lease epoch 与过期非死亡证明、恢复顺序、decision 乐观锁与 fingerprint 合并、平台三层门共用单一评估函数、协议 additive、UI 默认值复用产品常量，均符合规格；「明确不改的现有核心」7 个文件与原 DWF 表/旧 migration 确认未触碰；services 不引用 AgentRuntime 实现。

**评审发现与处置（共 10 项：7 已修复、1 部分修复、2 暂缓）：**

1. 已修复：services 根入口 browser-safe 被 continuous 模块 value 再导出破坏（esbuild 实测 6 处 `node:*` 不可解析，威胁既有 web/renderer 构建）→ index.ts 改为 browser-safe 叶子 value 导出 + type-only 再导出，`pnpm --dir packages/services exec esbuild --bundle src/index.ts --platform=browser` 真实执行通过（0 个 node: 引用），新增 `browserSafe.test.ts` 回归并登记进 unit suite。
2. 暂缓：CT-02 操作范围策略在产品路径零执行点（grep 全仓非测试调用为 0）。理由：默认关闭无暴露面；接线接缝需设计决策，非评审最小修复可承载。已记录于 `docs/release/continuous.md` §2.1 第 1 条为开启前必须落实。
3. 部分修复 + 残余暂缓：§6.1 预算挂起-继续链断裂 → `suspendCycleForBudget` 已先调 `execution.suspendAtSafeBoundary` 再落库（带 calls 断言测试）；残余为 errored Run 不可恢复的引擎侧语义（continue 后按同一终态再次挂起），如实记录于 `budgetSuspensionReason` 注释与 release §2.1 第 2 条。
4. 已修复：`RemoteServiceAccess.continuousService` 恒 truthy 代理使「Host 未装配→tab 隐藏」失效 → capability 契约改 Promise（ProxyChannel.call 恒 Promise）、新增 `useContinuousAvailability`（未装配时停留 checking）、Automations tab 门改为 ready/unsupported 才显示。
5. 已修复：E-24/E-27/E-28 探针导航（先点 automations-open、导航失败判失败）；`830bd17` 进一步按真实执行结果修正为「欢迎页阻挡，tab 缺席证据不可得」的如实 blocked 理由（隔离环境无凭据首屏为登录页，原「已取 tab 隐藏证据」的说法证据不存在）。
6. 暂缓：§10.1 主动探活两端未闭合（`ContinuousHealthMonitor` 无产品调用者；`inspectHealth` 刻意不提供 lastProgressAt/waitingFor，缺证据源时接线即误报 hang）。已记录于 healthMonitor.ts 文件头与 release §2.1 第 3 条。
7. 已修复：适配器准入状态无消费者 → `continuous-model-budget.ts` 新增 `admissionProbe` 接缝（suspended/revoked → admission_closed，不触 inner 不 reserve），budget-runtime 测试 8/8 通过。
8. 已修复：validation failed/unverified 未同批删除、跨批可复活 → 门语义改为「最新结果」，E-12 扩展用例（先 passed 后复验 failed，done 仍拒）通过。
9. 已修复：sqliteDecisionStore.ts 错别字。
10. 已修复：评审修复自身引入的 `architecture-policy.yaml` oxfmt 格式回归（基线 stash 对照证实非既有），oxfmt 重排后 24 文件复验 exit 0；另将上轮无效的 esbuild 验证命令（`node --dir`）更正为真实执行。

**Host 侧装配缺席是已声明边界而非隐瞒**：`ServiceChannels.Continuous` 注册、wake 处理器注册（`registerContinuousWakeHandler` 无调用者）、`modelBudgetGateFor`/`decisionGateFor` 登记、模板注册表注入均未实施，功能默认关闭（accessor 可选字段 + `create-app` 开关）。该状态在 `docs/release/continuous.md` §2 与 CT-09/CT-10 记录中如实文档化，依赖它的 E 用例标 blocked 未伪称通过。

### 当前未决项（汇总时点，均为开启前必须或建议处理）

1. 【medium】CT-02 范围策略零执行点：`continuous-execution-policy.ts` 的路径/命令/git/能力检查无产品调用者，§7 写入边界在 actor 实际执行链上不设防（release §2.1 第 1 条）。
2. 【medium】预算挂起-继续引擎侧半边未闭环：挂起靠 Run 终态 errored 的 failureCode 文本尽力映射；errored Run 不可恢复，用户 continue 后会陷入答-挂循环（release §2.1 第 2 条；代码阅读证据，未端到端执行）。
3. 【medium】§10.1 探活两端未闭合（release §2.1 第 3 条）：无产品调用者、无进展证据源。
4. 【low，修复轮新发现】默认关闭下 capability 探测请求在 Host 侧永久挂起并缓慢累积：channel 未注册时 `ChannelServer` 走 collectPendingRequest（仅注册时冲刷），`useContinuousAvailability` 每次挂载即发；量小但无上界，建议加超时/缓存或长期 pending 拒绝策略。

## 3. 最终验证各 suite 真实结果

退出码语义（`830bd17` 确立并回写 `docs/testing/continuous.md` §10）：failed/missing → 非零；**blocked → exit 0 且状态如实传播（blocked ≠ passed）**，由 release gate 消费；live 未显式 opt-in 的拒绝启动仍非零。

| suite | 退出码 | 真实结果 |
| --- | --- | --- |
| unit | 0 | passed |
| integration | 0 | passed |
| recovery | 0 | passed |
| e2e | 0 | runner 健康完成（failed=0）；依赖 Host 装配的用例为 **blocked**（附预检证据；欢迎页阻挡下 tab 缺席证据不可得），非用例通过 |
| mobile | 0 | 同 e2e：健康完成，Host 依赖用例 blocked |
| platform | —（无退出码） | **最终验证未执行**（编排 runner 未提供该 suite）；此前整体评审会话曾真实执行 exit 0 |
| regression | —（无退出码） | **最终验证未执行**（编排 runner 未提供该 suite）；CT-10 轮与 `830bd17` 提交记录中 exit 0（E-26/E-27/E-28 passed、stdout 13.9KB），最终验证会话未复核 |
| live | 未执行 | 需真实测试凭据，未运行 `--allow-live`；未 opt-in 的拒绝启动语义为 exit 1 |

- 编排层最终收敛标记：converged = true。
- 编排数据将 e2e/mobile 的 note 记为 "passed"；按 `830bd17` 提交记录与 `packages/desktop/test/continuous/e2e.test.mjs` 文件头注释，其准确含义是「runner 健康完成、failed/missing 为 0」，用例级仍存在 blocked。本汇总按 blocked 如实报告，不写成「E2E 用例全部通过」。
- 最终硬门禁：typecheck、architecture:check、lint 通过；fmt:check 与 CLI lint 的既有基线处置见 §4。

## 4. 已知基线失败（与本 feature 无关，单列）

- **`pnpm fmt:check`**：33 个既有文件失败（基线即有，属本 feature 的 0 个）。评审修复曾引入 `architecture-policy.yaml` 一处格式回归，已 oxfmt 修复并复验（24 文件 --check exit 0）。
- **CLI lint（apps/zcode-cli）**：基线记录 2 条既有 max-lines 错误。`830bd17` 查明根因：子包无自己的 oxlint 配置时向上继承根 `.oxlintrc.json` 的 max-lines，而根配置 ignorePatterns 的「apps/zcode-cli 不受约束」意图在子目录 script 下失效（turbo 缓存失效即暴露，main 上同样存在，worktree 实测证实）。修复为新增 `apps/zcode-cli/.oxlintrc.json`（显式空规则集，formal-proof 先例）阻断继承，CLI lint 14/14 task `--force` 全真实执行通过（0 错误；本 feature 文件 0 条）。
- **根 `pnpm lint`**：0 errors / 70 warnings，与 spec §14 记录的基线一致，无新增。
- **bootstrap 包 lint**：CT-02/CT-03 记录的历史账（stash 对照证明全部为未触碰文件的既有 finding），按「不混无关重构」与 UPSTREAM-SYNC 低 diff 原则不处理；本 feature 文件以定点 oxlint 覆盖（0 warnings 0 errors），记录留档。
- **desktop scheduler tsc**：1 个改动前基线错误（CT-07 stash 对照确认），未计入通过项。

## 5. 未覆盖范围（未执行，不视为通过）

1. **live suite**：需真实模型凭据，全程未运行 `--allow-live`，按文档 blocked。
2. **Windows/Linux 平台 suite**：无可用机器，登记为 observe_only 未验证（不伪造）；平台执行验证仅 darwin/arm64（Node 25.8.0）。
3. **Host 侧装配**（默认关闭的根因）：Continuous channel 注册、wake 处理器注册、预算/决策 gate 登记、模板注册表注入均未实施 → E-01…E-20、E-29…E-34 的 E2E 层用例 blocked（服务层/表单层已 passed）。
4. **web/renderer 生产构建**：未运行；以 `esbuild --platform=browser` 定向 bundle 实验替代取证（修复后 0 处 `node:*`）。
5. **真实模型链路**：CT-05 模板测试使用脚本化 actor runtime（typed 校验真实、模型输出为 fixture）；真实模型 E2E 属 live，未执行。
6. **最终验证未复核 platform/regression**（见 §3 表；二者仅在更早会话有 exit 0 记录）。
7. **unpackaged 形态进程级 agent 指纹加载核对**：需 workspace 会话（装配后）方可继续核对。

## 6. 开启与回滚

- 功能默认关闭（capability 缺席 + accessor 可选字段 + CLI `continuousManagedCycles.enabled` 开关），开启装配清单与有序回滚步骤见 `docs/release/continuous.md` §2/§3（回滚不靠删表）。
- 开启前必须逐项落实 §2.1 四项接线：CT-02 范围策略执行点、引擎侧预算挂起-继续语义、探活证据源、Host 预算闸门登记；建议一并处理 §2 未决项 4 的 pendingRequests 累积问题。
