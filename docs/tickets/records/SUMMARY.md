# Continuous 功能实施汇总（feature/continuous-mvp）

- 汇总日期：2026-10-05。
- 依据：结构化执行数据（本轮工作流编排产出）、`docs/tickets/records/CT-00.md`…`CT-10.md` 逐 ticket 记录、`git log main..feature/continuous-mvp` 与 `git diff --shortstat main...830bd17`（功能实施终点实测：163 个文件，+33720/−35；测量基线取 `830bd17`，不含本汇总及其修订两个纯文档提交）。
- 分支：`feature/continuous-mvp`（对比基线 `main`）。截至 `830bd17`（即本汇总及其修订这两个纯文档提交之前），`git log main..830bd17` 枚举共 **14 个提交**（本次修订以 `git rev-list --count` 复核为 14）：
  - `761a24b` 规格/tickets/测试文档基线（CT-00 前置）× 1；
  - CT-00…CT-10 共 11 个 ticket 提交；
  - `8cded8f` 整体评审问题处置、`830bd17` 最终验证修复 × 2。
  - 1 + 11 + 2 = 14（初版汇总误写「13 个提交」，与自身枚举不符，本次修订更正；含汇总文档提交后分支为 15+，纯文档提交不计入功能实施账目）。
- 配套文档：`docs/specs/continuous.md`（产品规格）、`docs/testing/continuous.md`（测试/E2E 计划）、`docs/release/continuous.md`（发布、开启前置与回滚）。
- 状态词表：passed / failed / blocked / planned / unverified。凡未执行或证据不可得，一律如实标注，绝不写成通过。

## 1. Ticket 实施状态

| Ticket | 标题                               | 状态   | 提交      | 轮次（含门禁修复轮） |
| ------ | ---------------------------------- | ------ | --------- | -------------------- |
| CT-00  | 锁定契约和测试入口                 | 已提交 | `ebe2a64` | 1                    |
| CT-01  | 长期状态和事务                     | 已提交 | `ba241cb` | 2                    |
| CT-02  | 独立工作区、操作范围和交付         | 已提交 | `09372a0` | 1                    |
| CT-03  | 受控 Run 身份、报告和停止          | 已提交 | `4acb75f` | 2                    |
| CT-04  | 预算、暂停确认、主动探活和模型准入 | 已提交 | `fceca4d` | 1                    |
| CT-05  | 手动完整 Cycle 与固定模板          | 已提交 | `1c3cf15` | 1                    |
| CT-06  | 非阻塞 Decision Queue              | 已提交 | `53c790c` | 1                    |
| CT-07  | 周期、租约与恢复                   | 已提交 | `a5e9d0a` | 2                    |
| CT-08  | 桌面与手机 UI                      | 已提交 | `1a389a6` | 1                    |
| CT-09  | 真实 E2E runner 和故障证据         | 已提交 | `fdcb953` | 2                    |
| CT-10  | 跨平台、兼容回归与发布             | 已提交 | `048aa89` | 2                    |

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

评审范围：feature 相对 main 的全量 diff 与提交历史（评审记录为 12 个提交、161 个文件、+33217/−35；其后 `830bd17` 最终验证修复落地，截至 `830bd17` 全量为 14 个提交、163 个文件、+33720/−35——本次修订会话以 `git log`/`git diff --shortstat main...830bd17` 实测），对照 `docs/specs/continuous.md` §4/§5/§9/§10/§11、AGENTS.md 工程边界与 tickets 禁改清单。提交数口径说明：评审时点 `main..8cded8f` 全量实测为 13 个提交，评审记录的「12」与「不计前置文档提交 `761a24b`」的口径吻合（11 个 ticket 提交 + 1 个评审修复提交 = 12）；两套口径并存易误读，本汇总统一采用全量口径并在文首给出可核对的枚举账目。

**结论：整体架构质量高。** 分层（UI→hooks→单一 command service→domain/application/adapters）、wake 链路职责（scheduler 只读、Main 仅转发、Host 路由不存业务状态）、schema/事务/唯一约束（one-open-cycle 与 one-pending-continuation 部分唯一索引、lease 同有同空 CHECK）、预算准入原子性（BEGIN IMMEDIATE、微美元整数单一实现、幂等结算/unknown 保留/显式核销）、submitOnce 幂等裁决、lease epoch 与过期非死亡证明、恢复顺序、decision 乐观锁与 fingerprint 合并、平台三层门共用单一评估函数、协议 additive、UI 默认值复用产品常量，均符合规格；「明确不改的现有核心」7 个文件与原 DWF 表/旧 migration 确认未触碰；services 不引用 AgentRuntime 实现。

**评审发现与处置（共 10 项：7 已修复、1 部分修复、2 暂缓）：**

1. 已修复：services 根入口 browser-safe 被 continuous 模块 value 再导出破坏（esbuild 实测 6 处 `node:*` 不可解析，威胁既有 web/renderer 构建）→ index.ts 改为 browser-safe 叶子 value 导出 + type-only 再导出，`pnpm --dir packages/services exec esbuild --bundle src/index.ts --platform=browser` 真实执行通过（0 个 node: 引用），新增 `browserSafe.test.ts` 回归并登记进 unit suite。
2. 暂缓：CT-02 操作范围策略在产品路径零执行点（grep 全仓非测试调用为 0）。理由：默认关闭无暴露面；接线接缝需设计决策，非评审最小修复可承载。已记录于 `docs/release/continuous.md` §2.1 第 1 条为开启前必须落实。
3. 部分修复 + 残余暂缓：§6.1 预算挂起-继续链断裂 → `suspendCycleForBudget` 已先调 `execution.suspendAtSafeBoundary` 再落库（带 calls 断言测试）；残余为 errored Run 不可恢复的引擎侧语义（continue 后按同一终态再次挂起），如实记录于 `budgetSuspensionReason` 注释与 release §2.1 第 2 条。
4. 已修复：`RemoteServiceAccess.continuousService` 恒 truthy 代理使「Host 未装配→tab 隐藏」失效 → capability 契约改 Promise（ProxyChannel.call 恒 Promise）、新增 `useContinuousAvailability`（未装配时停留 checking）、Automations tab 门改为 ready/unsupported 才显示。
5. 已修复（E-24/E-27/E-28 探针导航与如实性，分两步落地）：`8cded8f` 修正空转探针——Continuous tab 只在 Automations 页挂载，探针必须先点 `automations-open` 并等页面骨架，导航失败判失败而非静默通过；`830bd17` 在最终验证实际执行时发现无凭据隔离环境首屏为登录/欢迎页（**同一首屏**，以 `oauth-login-button` 前缀族探测，`e2e.test.mjs:212-231`、`regression.test.mjs:230-249`），侧栏入口不渲染、「tab 缺席」证据不可得，据此把 blocked 理由改为引用真实探测结论（原「已取 tab 隐藏证据」的说法证据不存在）。用例编号澄清：**E-24 不是 E-26 的笔误**——二者是 `docs/testing/continuous.md` §8 用例目录中的不同用例（E-24「不支持的环境与旧 CLI」在 e2e suite；E-26「现有功能回归」在 regression suite；`e2e.test.mjs:47` 注明 E-25…E-27 在 platform/regression 执行）；**E-28 是同一用例编号拆两个半边执行**（e2e 半边 = bridge build + run ID 正反向断言；regression 半边 = 无 bridge flag 的普通 production build）。各用例最终状态见 §3 表格与表下说明。
6. 暂缓：§10.1 主动探活两端未闭合（`ContinuousHealthMonitor` 无产品调用者；`inspectHealth` 刻意不提供 lastProgressAt/waitingFor，缺证据源时接线即误报 hang）。已记录于 healthMonitor.ts 文件头与 release §2.1 第 3 条。
7. 已修复：适配器准入状态无消费者 → `continuous-model-budget.ts` 新增 `admissionProbe` 接缝（suspended/revoked → admission_closed，不触 inner 不 reserve），budget-runtime 测试 8/8 通过。
8. 已修复：validation failed/unverified 未同批删除、跨批可复活 → 门语义改为「最新结果」，E-12 扩展用例（先 passed 后复验 failed，done 仍拒）通过。
9. 已修复：sqliteDecisionStore.ts 错别字。
10. 已修复：评审修复自身引入的 `architecture-policy.yaml` oxfmt 格式回归（基线 stash 对照证实非既有），oxfmt 重排后 24 文件复验 exit 0；另将上轮无效的 esbuild 验证命令（`node --dir`）更正为真实执行。

**Host 侧装配缺席是已声明边界而非隐瞒**：`ServiceChannels.Continuous` 注册、wake 处理器注册（`registerContinuousWakeHandler` 无调用者）、`modelBudgetGateFor`/`decisionGateFor` 登记、模板注册表注入均未实施，功能默认关闭（accessor 可选字段 + `create-app` 开关）。该状态在 `docs/release/continuous.md` §2 与 CT-09/CT-10 记录中如实文档化，依赖它的 E 用例标 blocked 未伪称通过。

**评审轮已执行验证（出处：评审结论文本；数据未随附 artifacts 路径，本汇总无法复核）**：`node scripts/test-continuous.mjs --suite unit / integration / recovery / platform` 全部 exit 0；`pnpm typecheck` exit 0；`pnpm --dir apps/zcode-cli typecheck` exit 0（turbo 27 task）；`pnpm architecture:check --changed` OK（violations 0/new 0）；`pnpm lint` 0 errors/70 warnings（与 spec §14 基线一致）。评审轮未执行：e2e/mobile/regression/live（e2e 记录耗时约 25 分钟且用例 blocked 于装配缺席；e2e/mobile 后在最终验证轮补跑，regression 仅存 `830bd17` 提交记录，见 §3）与 web 生产构建（以 `esbuild --platform=browser` 定向 bundle 实验替代取证）。

### 当前未决项（汇总时点，均为开启前必须或建议处理）

1. 【medium】CT-02 范围策略零执行点：`continuous-execution-policy.ts` 的路径/命令/git/能力检查无产品调用者，§7 写入边界在 actor 实际执行链上不设防（release §2.1 第 1 条）。
2. 【medium】预算挂起-继续引擎侧半边未闭环：挂起靠 Run 终态 errored 的 failureCode 文本尽力映射；errored Run 不可恢复，用户 continue 后会陷入答-挂循环（release §2.1 第 2 条；代码阅读证据，未端到端执行）。
3. 【medium】§10.1 探活两端未闭合（release §2.1 第 3 条）：无产品调用者、无进展证据源。
4. 【low，修复轮新发现】默认关闭下 capability 探测请求在 Host 侧永久挂起并缓慢累积：channel 未注册时 `ChannelServer` 走 collectPendingRequest（仅注册时冲刷），`useContinuousAvailability` 每次挂载即发；量小但无上界，建议加超时/缓存或长期 pending 拒绝策略。

## 3. 最终验证各 suite 真实结果

退出码语义（`830bd17` 确立并回写 `docs/testing/continuous.md` §10）：failed/missing → 非零；**blocked → exit 0 且状态如实传播（blocked ≠ passed）**，由 release gate 消费；live 未显式 opt-in 的拒绝启动仍非零。

| suite       | 退出码        | 真实结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | 0             | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| integration | 0             | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| recovery    | 0             | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| e2e         | 0             | suite 状态 **blocked**（非用例通过）：E-01…E-20、E-22、E-23、E-29…E-34 依赖 Host 装配，逐用例 blocked（`CAPABILITY_BLOCKED_REASON`，`e2e.test.mjs:268-269、341-348`）；E-24 blocked（capability 探测可能停在登录/欢迎页，blocked 理由按真实探测结论生成，`e2e.test.mjs:326-339`）；E-28 本 suite 半边的两个真实 Electron 断言（有 run ID bridge 暴露 / 无 run ID 不暴露）**已执行且通过**，但用例整体记 blocked（production 半边归 regression，`e2e.test.mjs:283-324`）                                                                                                                                                                                                                                                                         |
| mobile      | 0             | E-21 blocked（浏览器不可用，或浏览器可用但配对/attachment 依赖 Host 装配，`mobile.test.mjs:78-107`）；exit 0 = failed 为 0，非用例通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| platform    | —（无退出码） | **最终验证编排未提供该 suite**。历史 exit 0 记录两处：① 整体评审轮的验证记录（评审结论原文：「`node scripts/test-continuous.mjs --suite unit / integration / recovery / platform 全部 exit 0`」，见 §2 评审执行验证）；② `830bd17` 提交信息（`--suite all → 0`，其中 platform passed）。两处记录均未随数据保留 artifacts 路径（runner 证据写 os.tmpdir，现已不可查），本汇总无法复核，仅如实注明出处                                                                                                                                                                                                                                                                                                                                            |
| regression  | —（无退出码） | **最终验证编排未提供该 suite**。`830bd17` 提交信息记录 `--suite regression → 0`（stdout 13.9KB），按该提交时的代码与提交记录，最终用例状态为：E-26 **passed**（bootstrap 既有测试真实重跑 + mode 枚举 canary + 无并行 Goal 链）、E-27 **passed**（recovery 停止链重跑 + 回滚文档在场；`830bd17` 后不再附带未取证的「默认关闭探针」断言，`regression.test.mjs:360-363`）、E-28 **blocked**（登录/欢迎页阻挡 tab 缺席 canary；bridge 不暴露与测试符号不进产物两个真实断言已执行且通过，`regression.test.mjs:275-294`）。CT-10 轮记录的「E-26/E-27/E-28 全 passed」是导航 canary 加入**之前**的结果，其「tab 缺席」判定当时为空转探针（未导航即扫描），以 `830bd17` 后的如实状态为准；本汇总及修订会话均未复跑该 suite，以上为记录转述非本会话执行 |
| live        | 未执行        | 需真实测试凭据，未运行 `--allow-live`；未 opt-in 的拒绝启动语义为 exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

- 「Electron 探针最终到底过没过」的准确回答：bridge 探针（e2e E-28 半边的有/无 run ID 正反向、regression E-28 半边的 production 不暴露）与「测试专用符号不进产物」检查均**真实执行且通过**；「Continuous tab 缺席 = 默认关闭」的产品行为证据在无凭据隔离环境**不可得**（登录/欢迎页阻挡），相关用例（e2e E-24、regression E-28）如实记 blocked，不放水成 passed 也不误判 failed。
- 编排层最终收敛标记 converged = true 来自编排产出数据（编排脚本不在本仓库、未随数据提供，其内部判定条件本会话**无法核实**）。就数据可见范围，该标记至多对应：最终轮 runner 实际提供的 5 个 suite（unit/integration/recovery/e2e/mobile）全部 exit 0、无 failed/missing，且 fmt/CLI lint 基线归属清点完成（finalNotes）；**platform/regression 未在最终轮提供，不在该标记可声明的覆盖范围内**——「收敛」不等于「全量 suite 验收完成」。
- 编排数据将 e2e/mobile 的 note 记为 "passed"；按 `830bd17` 提交记录与 `e2e.test.mjs`/`mobile.test.mjs` 的汇总断言（failed === 0、blocked 如实传播、suite 状态写 blocked），其准确含义是「runner 健康完成、failed 为 0」，用例级仍为 blocked。本汇总按 blocked 如实报告，不写成「E2E 用例全部通过」。
- 「最终硬门禁通过」的准确口径（命令与覆盖面）：根 `pnpm typecheck` exit 0（`package.json:29` 的 `tsc -b` 项目清单共 11 项：rpc/provider/provider-node/shared/services/client/server/zcode-server-cli/ui/web + desktop/tsconfig.host.json，**不含** desktop tsconfig.scheduler/main 两个基线失败项目，该清单在本 feature 之前即如此）；`pnpm --dir apps/zcode-cli typecheck` exit 0（turbo 27 task）；`pnpm architecture:check --changed` 0 violations；`pnpm lint` 0 errors/70 warnings（基线一致）。本修订会话实测复跑根 `pnpm typecheck` 仍 exit 0；scheduler 项目的现状见 §4。

## 4. 已知基线失败（与本 feature 无关，单列）

- **`pnpm fmt:check`**：33 个既有文件失败（基线即有，属本 feature 的 0 个）。评审修复曾引入 `architecture-policy.yaml` 一处格式回归，已 oxfmt 修复并复验（24 文件 --check exit 0）。
- **CLI lint（apps/zcode-cli）**：基线记录 2 条既有 max-lines 错误。`830bd17` 查明根因：子包无自己的 oxlint 配置时向上继承根 `.oxlintrc.json` 的 max-lines，而根配置 ignorePatterns 的「apps/zcode-cli 不受约束」意图在子目录 script 下失效（turbo 缓存失效即暴露，main 上同样存在，worktree 实测证实）。修复为新增 `apps/zcode-cli/.oxlintrc.json`（显式空规则集，formal-proof 先例）阻断继承，CLI lint 14/14 task `--force` 全真实执行通过（0 错误；本 feature 文件 0 条）。
- **根 `pnpm lint`**：0 errors / 70 warnings，与 spec §14 记录的基线一致，无新增。
- **bootstrap 包 lint**：CT-02/CT-03 记录的历史账（stash 对照证明全部为未触碰文件的既有 finding），按「不混无关重构」与 UPSTREAM-SYNC 低 diff 原则不处理；本 feature 文件以定点 oxlint 覆盖（0 warnings 0 errors），记录留档。
- **desktop scheduler/main tsconfig 项目**：不在根 `pnpm typecheck` 项目清单内（清单只含 `tsconfig.host.json`，本 feature 之前即如此，见 `package.json:29`）。scheduler 项目现存 1 个 TS2322 基线错误（`packages/desktop/src/scheduler/index.ts:262`，modelSelection 可选性；CT-07 以 git stash 对照证明改动前即存在，`CT-07.md` verify 清单 123-126 行）。本修订会话实测 `./node_modules/.bin/tsc -b packages/desktop/tsconfig.scheduler.json` 仍 exit 1、同一错误——该错误不在任何「通过」声明的覆盖范围内（§3 硬门禁口径已注明），如实单列。

## 5. 未覆盖范围（未执行，不视为通过）

1. **live suite**：需真实模型凭据，全程未运行 `--allow-live`，按文档 blocked。
2. **Windows/Linux 平台 suite**：无可用机器，登记为 observe_only 未验证（不伪造）；平台执行验证仅 darwin/arm64（Node 25.8.0）。
3. **Host 侧装配**（默认关闭的根因）：Continuous channel 注册、wake 处理器注册、预算/决策 gate 登记、模板注册表注入均未实施 → E-01…E-20、E-29…E-34 的 E2E 层用例 blocked（服务层/表单层已 passed）。
4. **web/renderer 生产构建**：未运行；以 `esbuild --platform=browser` 定向 bundle 实验替代取证（修复后 0 处 `node:*`）。
5. **真实模型链路**：CT-05 模板测试使用脚本化 actor runtime（typed 校验真实、模型输出为 fixture）；真实模型 E2E 属 live，未执行。
6. **最终验证未复核 platform/regression**（见 §3 表；二者仅在更早会话有 exit 0 记录）。
7. **unpackaged 形态「Host 进程级加载 agent 指纹」核对**：与 CT-09 的「CLI 构建 fingerprint」是**同一概念**——E2E runner 经 `scripts/build-desktop-agent-cli.mjs` 构建 CLI bundle 并计算 sha256（CT-09 记录 053fc78c…）。当前已核对的是**磁盘层**：unpackaged（非打包）形态下 Host 经 Electron Node 执行 JS bundle，runner 核对 `zcodeAgentProcessManager` 的两条解析候选（cli dist 入口 + staged bundled-agents 拷贝）存在且 sha256 等于本次构建（`runnerElectron.mjs:145-150`）。未核对的残余是**进程层**：Host 实际 spawn agent 进程时加载的正是该指纹 bundle——该事实只会在 workspace 会话创建时产生，而会话创建依赖 capability 装配（当前默认关闭），故归装配后由会话用例补核（`runnerElectron.mjs:168` 注释自述「进程级 spawn 加载指纹随会话用例核对」）。影响评估：属证据完整性缺口（两候选磁盘同指纹不能单独证明运行态加载的就是它），无产品行为风险，默认关闭阶段无暴露面；打包态（native binary 指纹直接比对）不受此缺口影响。

## 6. 开启与回滚

- 功能默认关闭（capability 缺席 + accessor 可选字段 + CLI `continuousManagedCycles.enabled` 开关），开启装配清单与有序回滚步骤见 `docs/release/continuous.md` §2/§3（回滚不靠删表）。
- 开启前必须逐项落实 §2.1 四项接线：CT-02 范围策略执行点、引擎侧预算挂起-继续语义、探活证据源、Host 预算闸门登记；建议一并处理 §2 未决项 4 的 pendingRequests 累积问题。

---

# 二期：CT-11 至 CT-16（分支 codex/continuous-release-gaps）

- 修订日期：2026-10-06。
- 依据：二期结构化执行数据（工作流编排产出：逐 ticket notes、reviewVerdict、reviewDispositions、outstandingReviewFindings、finalSuites、finalNotes、notRun）、`docs/tickets/records/CT-11.md`…`CT-16.md` 逐 ticket 记录（CT-15/CT-16 含同日「评审修复补记」）、`git log e9415266d58f2a4c0ffadf11ede61fd722b5f9e2..HEAD`。ticket 源为 `docs/tickets/continuous-release-gaps.md`（随 `a0b128c` 入库，见 §2 谱系说明）。
- 分支谱系与提交账目（本修订会话实测；hash 固定表述，避免「HEAD」随文档提交漂移）：二期基线 `e941526`（一期终点 `830bd17` 之后依次为两个汇总文档提交 `1918fc4`/`4aee490`、`a0b128c` 预算暂停/探活/受管执行检查修复、Node 版本下限放开）。**功能实施账目沿用一期文首约定（纯文档提交不计入）**：`e941526..4bcf682` 共 **7 个提交** = CT-11…CT-16 六个 ticket 提交 + `4bcf682` 二期评审处置提交（2026-10-05 至 10-06）；其后 `8fbb7e5`（二期汇总初版）与本修订提交均为纯文档提交，不入账。全量 diff `git diff --shortstat e941526..4bcf682` 实测 110 文件 +15546/−1250，**不含本文件**（`docs/tickets/records/SUMMARY.md` 在该区间零提交，git log 实测）；评审时点 `e941526..9ad735b` 实测 103 文件 +14366/−1013，与评审结论自述一致。
- 二期主题（关闭一期遗留的 `docs/release/continuous.md` §2.1 开启前置——指**源代码接缝与产品装配**层面；验收层残余与 §2.1 从四项到六项再到五行表的演进见 §2，与 §6 门槛清单的关系见 §6）：安全操作与可信验证、window-scoped Local Host 装配、预算与 AskUserQuestion 真实通信、完整主动探活与正常阻塞、真实桌面/手机 E2E、固定运行时与安装包验收。
- 状态词表沿用一期：passed / failed / blocked / planned / unverified；未执行或证据不可得一律如实标注，绝不写成通过。本修订会话实际复跑的检查在文中逐条注明命令与结果；其余结论注明出处（编排数据或逐 ticket 记录），二者不混写。

## 1. Ticket 实施状态

| Ticket | 标题                              | 状态   | 提交      | 轮次（含门禁修复轮） |
| ------ | --------------------------------- | ------ | --------- | -------------------- |
| CT-11  | 补齐安全操作与可信验证            | 已提交 | `6b9640d` | 1                    |
| CT-12  | 装配 window-scoped Local Host     | 已提交 | `eddfa8d` | 2                    |
| CT-13  | 预算与 AskUserQuestion 的真实通信 | 已提交 | `757893e` | 1                    |
| CT-14  | 完整主动探活和正常阻塞            | 已提交 | `1e27cf3` | 1                    |
| CT-15  | 真实桌面与手机 E2E                | 已提交 | `a28d941` | 2                    |
| CT-16  | 固定运行时、安装包与真实模型验收  | 已提交 | `9ad735b` | 2                    |

各 ticket 要点（细节以 `docs/tickets/records/CT-11.md`…`CT-16.md` 为准）：

- **CT-11**：六项全部落地——①受限递归搜索（目录下行仅导航、逐实际目标过完整 Scope/forbidden/protected/角色/链接目标判定，不跟随目录符号链接）；②symlink 替换竞态收敛（O_NOFOLLOW + fstat/lstat/检查期 inode 三方绑定、IO 全在 fd 上，如实声明不宣称完整 OS 沙箱，先失败回归证明旧实现在准入窗口泄露受保护内容）；③受控 argv 测试端口 + darwin seatbelt 隔离（构造期三金丝雀自证，含无沙箱对照组排除离线误判，自证不过 fail closed；win32/linux 无隔离实现，observe_only 三层门拒绝一切写入/命令/提交）；④工具端口证据与提交门（tests/browser/diff/commit 关联 candidate/run/epoch、每阶段取最新；模型 exitCode:0/passed 只算报告不能授权提交）；⑤模板 v2 移除 `world.run` git add/commit 与模型转述结论路径，本地提交只经可信提交端口（只提交候选授权路径内改动，原仓库 HEAD 与工作树实测不变）；⑥文件/行数上限按相对起始 commit 累计口径核对，超限同轮挂起（继续只增额度不重置已消耗量）。开发中被测试捕获并修复 5 处真实缺陷（链接目标漏查、porcelain "??" 漏计、"." 前缀不覆盖全仓、执行器数据文件进 diff 口径、候选终局授权占用未释放）。绕过测试先失败实录 exit 1（pass 0/fail 2）；修复后 ct11-security 8/8（seatbelt 真实执行未 skip）。
- **CT-12**：shared 新增登记协议（`continuousRegisterManagedRun` strict 载荷：冻结配置/价格快照/上限/角色/leaseEpoch/真实工作目录/并发上限；CLI→Host 四反向请求）+ 模板注册表下沉 shared（同一份 hash 绑定）；services wire 执行端口（恢复先重建登记、缺 interrupt→capability_missing）与装配工厂；CLI 登记处把载荷变进程内预算/决策/IO 端口（同轮重发幂等）；desktop env 门 `ZCODE_CONTINUOUS_HOST_ENABLED`（默认关闭=channel 未注册=tab 隐藏不变）+ shutdown 新增 continuous-interrupt 阶段。已知限制如实：Electron 真实链路归 CT-15；价格快照无真实定价来源（缺席 fail closed）；声明测试命令第一版为空→候选 fail closed；浏览器证据仍为注入接缝。开发中被测试捕获并修复 2 处真实缺陷（挂起等待忙等、缺 health 快照打崩监督循环）。
- **CT-13**：账本传输严格校验（reserve 必带 leaseEpoch/workflowRunId/pricingVersion 核对、requestKey 同事实幂等/异事实拒绝；settle 归属三元组、旧 epoch 晚到 usage 幂等收尾）；denial 重构携带真实事实（limitKind 四词表、已用/预留/unknown 三分、currentLimit、本请求需求）；统一暂停路径（CLI 先本地冻结再通知；并发超限合并进同轮唯一 pending，两侧事实并集保留）；授权增量不重置已用量；尝试上限继续授权语义（pricing_missing/ledger_unreachable/lease_lost 结构化抛出不等待）；旧版 errored 预算轮经 `executionRecoverable` 呈现 + 用户显式结束旧轮/新开轮。新增 15 用例先红后绿（实现前 12 例失败）；修 4 处真实缺陷（领域/wire limitKind 词表不一致、并发挂起撞唯一索引、重复回答幂等断裂、wireSuspendForChangeLimit 漏 leaseEpoch）。
- **CT-14**：CLI 操作等待登记处（每条带 owner/run/epoch/原因/真实期限，过期或低于执行权高水位永久移除）；normal_wait 聚合为「全部运行节点被有效等待覆盖才豁免，任一 actor 工作照计」；Host wire 读操作通信期限（默认 30s）超时/失败折算结构化 `execution_unreachable`（additive 错误码），写操作有意不加期限（ACK 语义不可安全重试）；失联冻结不发 wire 挂起，直接保存 interrupted + 证据事件 + Program paused（同 epoch 守卫，旧观察不覆盖新执行权）。先红后绿：services 期限用例实现前真实挂起（正是 ticket 描述的缺陷本身）。
- **CT-15**：e2e 重写为真实 UI 驱动 + 三层事实断言（UI test id、tasks-index 只读 SQL、provider 计数/Git/worktree/进程日志）；终态 run15 exit 0：**9 passed / 0 failed / 21 blocked / 0 skipped**；regression E-26/E-27/E-28 真实通过；E-21 如实 blocked。修复 5 处真实产品缺陷（session id 守卫、store 漏传、金丝雀 Electron 形态与期限、父会话 FK、shutdown interrupt 顺序）+ runner 隔离缺口 1 处，产品代码 6 文件 +106/−22（低 diff；普通 Workflow/手动会话零行为变化）。
- **CT-16**：Node 口径核实（`mise.toml` 为 `>=24` 下限——`e941526` 放开而非固定 24.14.0，本机无 mise、系统 Node 25.8.0 满足下限，本修订会话复核 mise.toml 为 `node = ">=24"`/`pnpm "10.33.2"`）；新增 packaged suite（electron-builder `--dir` 的 unpacked .app——**打包形态、只是未出安装器**——内 **9 个用例：PK-01、E-01、E-02、E-11、E-15、E-16、E-17、E-28、E-34**（`packaged.test.mjs:30` 实测；此前汇总把暂停/退出/恢复/停止/本地提交边界等描述名与编号并列导致「11 个标识对 9 例」的误读——对应关系：E-11=暂停/恢复/停止、E-17=退出/重启恢复、E-02=本地提交边界与原仓库不变），终态 9 passed/0 failed/0 blocked；spawn preflight（`packagedSetup.mjs:13-49`）提供**打包形态**的进程级解析证据（运行期日志显示 agent 以随包 `resources/glm/zcode.cjs` 启动——注意与一期 §5 第 7 条的「unpackaged（非打包）」缺口是两个形态，见 §5 未覆盖第 8 条））；platform（darwin-arm64）复核 exit 0；live `--allow-live` 真实执行 exit 0/状态 blocked（无凭据，三用例如实 blocked）。打包链暴露并修复 3 处真实缺陷（Host 启动核对未接线→`recoverAllOnStartup`、wire 会话路由实例内丢失→持久化解析+会话复活、租约接管防御性 stop 毒化同 Run 恢复→改 interrupt 语义）。

### 门禁修复轮原因（轮次 > 1 的 ticket）

- **CT-12（2 轮）**：唯一失败项 `docs/release/continuous.md` 表格管道未对齐的 oxfmt 格式；oxfmt 修复后 diff 仅格式，门禁同款 `oxfmt --check` 26 文件复验 exit 0，代码零改动。
- **CT-15（2 轮）**：首轮 e2e exit 1，根因为 DWF actor 子会话创建报 FOREIGN KEY constraint failed（`session_task_link.parent_session_id` 对 session(id) 的 FK，Host 受控会话无用户轮、父行惰性缺席）→ 新增 `ensureParentSessionPersisted` 接缝（对已持久化普通会话为 no-op）；其后打通 7 处断点（全部为 runner/fixture 侧，见下节对账）。第二轮 e2e 真实通过。
- **CT-16（2 轮）**：`repository.test.ts` 新增断言手工换行的 oxfmt 格式；折叠单行后门禁同款 22 文件复验 exit 0，语义零变化。

### CT-15 缺陷/断点清单对账（三处口径的映射）

此前三份清单（ticket 要点「5 产品缺陷 + 1 runner 隔离缺口」、门禁轮「FK 根因 + 7 断点」、§3 过程清单约 12 项）是同一迭代史的不同切面，逐项对账（出处：CT-15.md 与编排 notes；每处产品修复均有中文注释落码）：

- **产品缺陷 5 处**：①session/create 外部 id 守卫（server-operations.ts）；②`continuousManagedCyclesOptionFor` 漏传 store（continuous-registration.ts）；③金丝雀 Electron 形态（ELECTRON_RUN_AS_NODE）+ 硬期限（continuous-isolation.ts）；④父会话 FK（dynamic-workflow-run-launch.ts `ensureParentSessionPersisted`）；⑤shutdown interrupt 顺序（host/index.ts activeServices 清空移到 phases 后）。
- **runner/fixture 侧修复 11 处**：①HOME/USERPROFILE 隔离缺口（runner.mjs）；②窗口就绪三形态与引导页跳过（runnerWindow.mjs）；③providerFamilyDomain 应用配置种子（e2eAppConfigSeed.ts）；④fixture 无 /v1 前缀路径 404（双路径兼容）；⑤barrier 缺省期限 30s→10 分钟；⑥git log argv 模板拼接；⑦停止按钮确认框真实驱动；⑧E-11 resume 后静止等待；⑨遗留模态遮罩收口；⑩node:test 并发下 blocked 登记覆盖；⑪recordCaseFailure 报告-退出码一致（+编排层守卫）。
- 三份清单的映射：ticket 要点 = 产品 ①…⑤ + runner ①；门禁轮「FK + 7 断点」= 产品 ④ + runner ④⑤⑥⑦⑧⑨⑩；§3 过程清单（run1…run15）= 产品 ①②③④ + runner ②③④⑤⑥⑦⑩（共 11 项）。产品 ⑤ 由 Host 侧日志定位而非 e2e 用例失败，runner ①⑧⑨⑪ 分别来自预检、门禁轮与断言层，故不出现在过程清单。数字由此对平：5 + 11 = 16 处独立修复，任何单份清单都是其子集视图。

## 2. 整体评审结论与处置

评审范围（hash 固定表述）：`e941526..9ad735b` 的 6 个 CT-11…16 ticket 提交（103 文件 +14366/−1013，本修订会话实测）；评审处置落地于 `4bcf682` 后，功能实施区间全量为 `e941526..4bcf682`（110 文件 +15546/−1250，见文首账目）。对照四个基准：

- **ticket 固定规则与 CT-11…16 验收**：预算额度/有效一小时/15s 探活/180 秒+3 次 hang/本地 only/自动本地提交边界/unknown 占预算/预算确认与 Decision Queue 分离均在代码与测试中落实；但「最多 10 个 actor 并发」未传入引擎 caps、CT-15/16 验收条款未全部达成、CT-13 `executionRecoverable` UI 呈现落空、真实装配链路的候选实施回路断裂——四项均进入下述处置。验收差距的条款级清单：CT-15 验收要求「E-01…E-20、E-24/E-28、E-29…E-34 及手机相关 case 都有真实动作和断言；无 planned；核心 case 无 blocked/skipped」，实际 9 passed/21 blocked + E-21 blocked——未达成的是全覆盖与「核心 case 无 blocked」两条（无 planned、截图/序号/执行身份/预算记录/断言、base commit 与工作树差异注明三条已满足）；CT-16 验收要求「打包平台、手机和 live 完成；生产无测试接口」，未达成的是手机（E-21）与 live（无凭据，usage/compaction/sidecar/限流/unknown/无进展/同轮继续 全部 blocked）、其他平台无真实机器证据（win32/linux observe_only、darwin-x64 未测）、真实打包 app 内「本地提交」仅驱动 fail-closed 边界而正向提交链未驱动；生产无测试接口（E-28）已满足。
- **spec §4/§5/§9/§10/§11 与 §2.1 修复边界**：达标（§4 所有者边界；§9 账本单一写入者/原子预留/严格传输校验/断联 fail closed/unknown 保留；§10 lease epoch 贯穿与 trigger key 幂等；§10.1 探活分类、读期限 30s、unreachable 冻结只写同 epoch running 行；§11 错误词表 additive）。「§2.1 六项修复边界全部有对应实现」的实体与出处：`a0b128c`（2026-10-05，早于 CT-11，一期与二期之间的独立修复提交）把 `docs/release/continuous.md` §2.1 从一期「已知边界（开启前必须补齐）」的**四项**（CT-02 范围策略执行点、引擎侧预算挂起-继续、探活证据源、Host 预算闸门登记——一期 §6 所引）重写为「遗留问题修复进度」表，并在 `docs/tickets/continuous-release-gaps.md`「已完成的接缝修复」列出**六行**：预算等待、操作检查、探活调用与进展证据、原子健康更新、登记缺项拒绝、退出中断——即评审「六项」所指，全部由 a0b128c 落地并有包级测试；CT-16 期间 §2.1 再增至五行（新增 CT-16 验收行）。从四变六不是改写一期条目，而是 a0b128c 先把四项的源代码接缝修掉（六行 = 四项的接缝实现拆细 + 登记缺项拒绝/interrupt 退出两个新增面），「仍需完成」列移交 CT-11…16。二期终点 §2.1 表头自述「**源代码接缝已经修复，完整产品仍未达到开启条件**」——「六项有对应实现」指实现+包级测试成立，与本汇总 §6 的开启门槛清单不矛盾：实现 ≠ 验收，§2.1 的文档化状态是「接缝关闭、验收开放、flag 关闭」。
- **AGENTS.md 工程边界**：达标，但口径须按时间点区分——「UI 零改动」是**评审时点**（`e941526..9ad735b`）事实；处置 6 在 `4bcf682` 引入了整个二期分支仅有的 UI 改动（`ContinuousProgramFacts.tsx` 与 en-US/zh-CN i18n 共 3 文件 +16/−1，`git show 4bcf682 --stat -- packages/ui` 实测）。「Main（`packages/desktop/src/main`）零改动」在 `e941526..HEAD`（含处置与文档提交）成立（该路径 git log 实测为零提交）；CT-12 的 shutdown continuous-interrupt 阶段落 `packages/desktop/src/host/index.ts`（Host 进程），处置 7 的 zcodeAgentService.ts 在 `packages/services`——均不在 Main 目录。services/continuous 外部依赖仅 `@zcode/shared`；上游邻近文件改动小而局部（zcodeAgentService.ts +58 可选 handler、node.ts +18 再导出、host/index.ts +104 env 门内装配），产品逻辑全在新文件；协议新命令经 shared strict schema。
- **真实证据要求**：未发现把 blocked 占位或模拟当 passed——e2e 为真实 UI 驱动 + 三层断言；21 个 blocked 理由具体且引用真实约束；E-28 报告/退出码不一致缺陷已修（`recordCaseFailure` + 编排层状态交叉核对）；证据注明 base commit 与工作树差异。

**评审人实际执行的验证**（出处：reviewVerdict）：services 130/130、bootstrap 83/83、`architecture-check` 0 violations、unit suite exit 0。未执行（评审人如实声明）：e2e/mobile/regression/packaged/platform/live（需 Electron 生产构建/浏览器/真实凭据，超出评审可承受规模），相关 passed 结论以代码结构审查与记录交叉核对为据。

**处置 7 项全部成立并落地于 `4bcf682`**（本修订会话以 `git show --stat` 核对：25 文件 +1002/−59，含 v2 冻结副本 `ui-ux-v1-v2-script.ts`、`continuous-authorize` 端口、`ContinuousProgramFacts.tsx` 与 zh/en i18n、supervisorSettlement 竞态守卫、zcodeAgentService 错误应答、continuousHost clock 接缝、CT-15/CT-16 记录补记）：

1. 【候选授权无产品调用点】trusted 端口新增保留命令 `continuous-authorize`（前一候选终局非撤销释放→授权、同候选幂等、revoked 终局拒绝、授权不扩张 Scope）；受管模板升 v3（骨架在每个候选实施 ask 前经该端口授权，v2 按版本化纪律冻结保留）；spec §7/§14 先行；bootstrap 85/85（含新用例，template 套件移除 fixture 手动 authorize、端到端经真实授权端口驱动）。
2. 【并发上限 10 未接线】`ManagedRunSubmitRequest.maxConcurrency` → startNewRun 透传 + 执行适配器 `maxConcurrencyFor` 按 Run ID 现读传入引擎 caps（更低机器天花板仍按钳制语义）；registration 测试钉住；E-33 仍无法真实验证（多 actor 脚本序列未建），如实保留。
3. 【CT-15/16 验收差距与时钟接缝说法】部分成立：装配级 clock 接缝补上（`createContinuousHostRuntime` 可选 clock 参数，生产调用点不传、恒真实系统时钟）——「产品决策冲突」说法不成立（ticket 实施段允许测试时钟注入，约束是生产构建不暴露）；CT-15/CT-16 记录追加「评审修复补记」不改写历史；跨进程 e2e 时钟注入仍需测试桥设计，时钟类用例维持如实 blocked；E-21 维持 blocked。
4. 【传输前 reRegister 覆盖已登记端口】同 runId + 同 leaseEpoch + canonical 载荷深比较相等 → 幂等复用并保留已登记端口对象；同 epoch 载荷变化 → registration_invalid；更高 epoch → 完整重建；registration 测试扩展钉住。
5. 【挂起写入整行覆盖竞态】落库前重读最新行，仅同 leaseEpoch 非 suspended 行合并挂起字段（游标/健康列保留最新事实）；services 131/131。**修复不完整的遗留见下文未决 1。**
6. 【executionRecoverable 无 UI 消费】`ContinuousProgramFacts.tsx` 当前轮卡片在不可恢复时渲染 role=alert 提示（入口复用本页既有停止/Run now 按钮），新增稳定 test id 与 zh-CN/en-US 文案；该呈现的真实 E2E 驱动仍受候选路径/时钟类 blocked 约束（如实声明）。
7. 【退出窗口 CLI 反向请求悬挂】`zcodeAgentService` 对已按词表认定却无 handler 的 Continuous 反向请求，由 handled=false 直接 return 改为立即 `respondError(-32603)`（原会悬挂到传输超时）；CLI 侧本就 fail closed 折算 ledger_unreachable，语义不变；未写专项单测（该文件无现存单测），如实说明。

**遗留未决 2 项 → 已于 2026-10-06 独立修复落地**（`200a9a7`/`3b97755`；原登记保留如下供追溯）：

1. 【medium】处置 5 的竞态守卫不完整：`supervisorSettlement.ts:134` 当前仍只排除 `latest.status !== "suspended"` 一种状态——终态（cancelled/completed/failed）与 interrupted 行在 wire 往返窗口内仍可被迟到的拒绝通知整行改写回 suspended。可达场景：CLI 挂起请求进入 Host 处理期间，用户并发的 stopCurrentCycle 链落地（stop 不 bump leaseEpoch，epoch 校验拦不住），随后挂起链重读到非 suspended 行被翻写。后果：违反 §6「立即停止→Cycle cancelled」终局性；completeCycle 已释放 lease，被复活的 suspended 行按部分唯一索引仍算开放轮，下一次 runNow 撞 open_cycle_exists 幽灵确认。新增竞态回归用例只覆盖游标/健康列保留，未覆盖终态改写。修法方向：仅非终态开放状态（running/preparing/settling）才合并（与 applyHealthAssessment 的 running-only 纪律对齐）。**为何有修法而未随处置修复**：该项是处置轮（`4bcf682`）完成后复核才确认的「修复不完整」新发现，不在该轮处置清单内；编排数据未附延后原因、归属或计划 ticket。本修订会话的任务边界是汇总文档、不改动产品代码，故仅登记。鉴于后果含幽灵开放轮，建议作为开启前置的独立变更落地，并补终态改写回归用例（现有用例不覆盖该路径）。**→ 已修复（`200a9a7`）**：守卫收窄为 `!isTerminalCycleStatus && 非 suspended && 非 interrupted`（即仅 running/preparing/settling 合并），并新增「往返窗口内 cancelled/interrupted 不被翻写」两路回归用例（ct13-budget-communication.test.ts）。
2. 【low】登记回音词表本地复制：`continuous-registration.ts:116` 的 `REGISTRATION_ECHO_OPERATIONS` 与 shared `CONTINUOUS_CLI_MANAGED_OPERATIONS`（`continuous-registration-protocol.ts:31-43`）逐项重复（本修订会话比对当前 11 项一致）；未来 shared 新增 op 时回音不跟随，漂移方向 fail closed（Host capability_missing）不会越权，只是把协议变更误报成 CLI 过旧；建议直接引用 shared 常量。**→ 已修复（`3b97755`）**：删除本地词表，两处回音直接 spread shared 常量（经 `@zcode/shared/continuous-protocol` 星号重导出导入）。

**本修订会话复跑的验证**（命令原样照录，全部在 `4bcf682` 之后的当前工作树执行）：`node scripts/test-continuous.mjs --suite unit` → exit 0（44/44）；`pnpm --dir packages/services exec tsx --test "test/continuous/*.test.ts"` → exit 0（131/131，与处置 5 记录的 131/131 一致）；`pnpm --dir apps/zcode-cli/packages/bootstrap exec tsx --test "test/continuous/*.test.ts"` → exit 0（85/85，与处置 1/2 记录的 85/85 一致）；`node scripts/architecture/architecture-check.mjs check` → OK（violations 0/baseline 0/new 0）；`pnpm fmt:check` → 33 个既有文件失败、与二期改动文件（`e941526..4bcf682`）交集 0（comm 比对实测）；`pnpm --dir apps/zcode-cli lint --force` → 14/14 task 全真实执行（0 cached）0 errors（详见 §4）。

### 一期未决项在二期的下落（含 `a0b128c` 的归属）

一期 §2 列出 4 项未决（一期 :76-79），二期下落逐项对账：

| 一期未决项                                             | 二期下落                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.【medium】CT-02 范围策略零执行点                     | `a0b128c` 先建执行点（「操作检查」接缝：actor 文件/执行端口与模板 world 端口包装，角色/候选路径/链接/命令检查进入 IO 调用路径）；CT-11 补齐安全边界（受限搜索、fd 竞态收敛、受控执行、可信提交端口）。release §2.1 行 1 记「CT-11 已落地」。                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2.【medium】预算挂起-继续引擎侧半边未闭环              | `a0b128c` 修引擎侧（预算闸门释放并发席位并等待、授权后同一 acquire 重新预留、旧 errored Run 明确拒绝继续——「预算等待」行）；CT-13 落地 Host 侧真实通信与旧 errored 轮产品入口；处置 6 补 UI 呈现。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3.【medium】§10.1 探活两端未闭合                       | `a0b128c` 接通调用与证据源（supervisor 同一监督循环 15 秒探测、journal sequence/timeCreated 真实进展、`updateCycleHealth` 按 running+leaseEpoch 条件原子更新）；CT-14 扩真实操作等待登记、读期限与失联冻结。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4.【low】capability 探测请求默认关闭下永久挂起缓慢累积 | **已修复（`d4a0e46`，2026-10-06）**：Host 关闭态改为在 `ServiceChannels.Continuous` 注册 `ContinuousDisabledService` 静态 stub——capability 立即以含 `continuous_not_enabled` 标记的结构化错误拒绝（不进 ChannelServer pendingRequests，堆积从源头消失）、其余命令 fail closed；UI 可用性新增 `disabled` 隐藏态（「未开启」≠「不支持」——后者仍进 tab 展示解释面，关闭态 tab 缺席行为不变，e2e E-24 关闭态实例复验通过）；renderer 探测加 5 秒超时兜底版本错配（旧 Host 无 stub 时落 unsupported）。原登记（修复前状态，保留供追溯）：二期无下落——`packages/rpc/src` 与 `packages/ui/src/hooks` 在 `e941526..HEAD` 零提交，`a0b128c` 亦未触及；默认关闭（channel 未注册）形态下按一期描述仍可能缓慢累积。 |

`a0b128c`（「修复预算暂停、探活与受管执行检查」，40 文件 +1752/−339）因此是**一期与二期之间的独立修复提交**：它是一期未决 1/2/3 的接缝侧关闭者、二期票据文件与 §2.1 新表（「已完成的接缝修复」六行，即评审「六项」出处）的入库者；它不在二期 7 个提交的功能账目内，也不在二期评审范围（`e941526..9ad735b`）内。其当时自述的中间验证（e2e 30 场景 blocked、regression E-28 断言失败且报告漏记）后被 CT-15/16 的真实结果取代（release §2.1 末尾注明，历史原文见 git 历史）。

**release gate：自主实施 flag 保持关闭**（live 与手机链路未完成、验收差距未关闭——CT-15 评审修复补记重申这是当前唯一正确状态）。

## 3. 最终验证各 suite 真实结果

口径与**时序声明**：下表前 7 行为二期最终验证轮编排数据 `finalSuites`。**编排数据未随附该轮的执行时间戳或 artifacts 指针，本汇总无法判定 finalSuites 产生于评审处置提交 `4bcf682` 之前还是之后**；可核实的是其数字与 CT-15/CT-16 ticket 轮记录逐项一致（e2e = run15、platform/regression = CT-15/16 轮、packaged = CT-16 ticket 轮——后两行不在 finalSuites 内，单列）。**处置后（`4bcf682` 代码形态）有执行证据的验证只有**：处置自述的包级自测（bootstrap 85/85、services 131/131）与本修订会话复跑（unit 44/44、services 131/131、bootstrap 85/85、architecture 0 violations、fmt:check/CLI lint，见 §2/§4）。e2e/mobile/regression/platform/packaged **在处置后代码上的执行无任何证据**——即 `4bcf682` 的产品改动（模板 v3、`continuous-authorize`、UI 提示、supervisorSettlement 竞态守卫、agent 请求错误应答、clock 接缝）未被任何端到端 suite 取证覆盖，仅有包级测试；且处置 3 更新了 `e2eCases.mjs` 的 blocked 理由文案（候选授权已接线、时钟接缝已就位），e2e 未重跑，「21 blocked」数字未在处置后重新取证。本汇总按「不能证实即不声称覆盖」处理。suite note「passed」对 e2e/mobile 的准确含义是「runner 健康完成、failed=0」，用例级 blocked 仍如实存在，不写成「用例全部通过」。

| suite                       | 退出码       | 真实结果                                                                                                                                                                                                             |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit                        | 0            | passed（44/44；本修订会话原命令复跑实测 exit 0）                                                                                                                                                                     |
| integration                 | 0            | passed（编排数据 finalSuites；末次计数记录为 CT-14 时点 161/161，最终轮未附计数；本修订会话未复跑）                                                                                                                  |
| recovery                    | 0            | passed（编排数据；CT-14 记录 17/17；本修订会话未复跑）                                                                                                                                                               |
| e2e                         | 0            | runner 健康、failed=0；用例级 **9 passed（E-01、E-02、E-08、E-11、E-15、E-16、E-24、E-28、E-34——E-28 为 e2e 半边）/ 21 blocked / 0 skipped**（run15，CT-15.md:72-80 与编排数据一致；21 个 blocked 理由见下）         |
| mobile                      | 0            | E-21 **blocked**（外部 relay + 凭据边界；blocked→exit 0 的 §10 语义，源码事实断言在场，不冒充通过）                                                                                                                  |
| platform                    | 0            | passed（darwin-arm64 真实机器复核，CT-16 记录；本修订会话未复跑）                                                                                                                                                    |
| regression                  | 0            | passed（E-26/E-27/E-28 真实通过，含 production build 真实导航后 tab 缺席 canary，CT-15 记录；本修订会话未复跑）                                                                                                      |
| packaged（CT-16 ticket 轮） | 0            | 9 passed / 0 failed / 0 blocked（unpacked .app 真实打包形态；用例 = PK-01、E-01、E-02、E-11、E-15、E-16、E-17、E-28、E-34，`packaged.test.mjs:30` 实测；全新构建轮 run3 与复核轮 run4/5/6 均通过；本修订会话未复跑） |
| live                        | 最终轮未执行 | CT-16 ticket 轮 `--allow-live` 真实执行 exit 0 / 状态 **blocked**（无 `ZCODE_E2E_LIVE_PROVIDER_KEY`，三用例如实 blocked，不用模拟替代、不输凭据）                                                                    |

编排层 `finalConverged=true` 仅对应上表前 7 个 suite 全部 exit 0、无 failed/missing，及 fmt/CLI lint 基线归属清点完成；live/packaged 不在该轮清单内，「收敛」不等于「全量验收完成」。

### e2e/mobile/regression：从一期 blocked/失败到二期真实断言的过程

- 一期终点（上文一期 §3）：e2e suite 状态 blocked（E 用例逐个 blocked 于 Host 装配缺席，仅 E-28 半边两个探针真实执行）；mobile E-21 blocked；regression 最终验证轮未提供、仅有提交记录转述。
- 转折点是 CT-12 落地 window-scoped Local Host 装配（env 门 `ZCODE_CONTINUOUS_HOST_ENABLED`，默认关闭形态不变）；CT-15 把 e2e 重写为**真实 UI 驱动**：窗口就绪预检三形态（欢迎/登录页、主界面、首次运行引导页）、稳定 test id 驱动、停止确认框与继续确认模态真实点击收口，断言升级为三层事实（UI test id、tasks-index 只读 SQL、provider 计数/Git/worktree/进程日志）。
- run1…run15 的迭代失败全部定位为可修根因并逐项修复，终态 run15 exit 0；过程清单（欢迎页/引导页 gating、providerFamilyDomain 缺席、session id 守卫、store 漏传、金丝雀 Electron 形态与期限、父会话 FK、fixture 路径/barrier 缺省期限/git argv 拼接/确认框/并发 blocked 登记覆盖，共 11 项）与「5 处产品缺陷」「门禁轮 7 断点」两份清单的逐项映射见 §1 末「CT-15 缺陷/断点清单对账」。
- regression：E-26/E-27/E-28 真实通过；此前「E-28 断言失败被 entryReport 漏记、报告显示 passed 而退出码 1」的缺陷由 `recordCaseFailure` + 编排层状态交叉核对修复，报告与退出码一致。
- mobile：E-21 仍 blocked，但已从占位升级为逐项调查结论（外部 relay 不在仓库——`packages/server` remote/\* 为 SSH/Docker 远程 workspace；连真实 relay 需个人凭据被测试文档禁止）+ 真实源码事实断言，不冒充通过。
- 21 个 e2e blocked 属实且由 release gate 消费：候选路径 10 个（E-03…E-07/E-12/E-13/E-14/E-20/E-33，需声明测试命令授权面与 builder/reviewer 完整脚本序列——授权面第一版为空，候选 fail closed 不 done/不提交）；时钟类 6 个（E-09/E-10/E-18/E-29/E-30/E-31，装配级 clock 接缝已就位，跨进程测试桥仍需设计且生产不暴露）；传输注入 2 个（E-17/E-19）；矩阵/历史 2 个（E-22/E-23）与回答链 1 个（E-32）依赖前述。

## 4. 已知基线失败（与本 feature 无关，单列）

- **`pnpm fmt:check`**：编排数据在三处时点给出三个数——一期 33、二期基线「若干既有」、二期最终轮 **34（属本 feature 0 个）**，但未随附文件清单。本修订会话实测当前为 **33 个既有文件失败**（含未跟踪的 `.zcode/plans/*.md` 1 个；失败清单与二期改动文件清单 `git diff --name-only e941526..4bcf682` 逐项比对），与二期改动文件**交集为 0**。33→34→33 的 +1/−1 波动无法从现有证据归因（最终轮无清单、无时间戳；可能与 `.zcode` 本地文件是否被扫描或处置轮格式化有关——此为可能性列举，不是结论）。属本 feature 0 个的结论在三处数据与本会话比对下一致。二期门禁以「全部改动文件逐个 `oxfmt --check`」覆盖，两轮门禁修复（CT-12/CT-16）均为纯格式，内容零变化。
- **CLI lint（apps/zcode-cli）**：编排数据记录——基线时点 2 条既有 max-lines 错误、最终轮 0 错误、属本 feature 文件 0 条。本修订会话以 `pnpm --dir apps/zcode-cli lint --force` 全真实执行（14/14 task、0 cached）：**0 errors**（存在 warning 级输出，如 @zcode/core 11 warnings，均为 warning 不是 error）。基线时点那 2 条为何出现：数据未附命令与文件清单，无法归因——一期 §4 记录过该基线的机制（子包无自身配置时继承根 max-lines，turbo 缓存失效即暴露，main 上同样存在）与修复（`830bd17` 新增 `apps/zcode-cli/.oxlintrc.json` 阻断继承，本修订会话确认该文件仍在）；可能是清点命令/范围/caching 状态不同，无证据不下结论。最终状态以本会话实测 0 错误为准。
- **desktop scheduler/main tsconfig 基线错误**：沿用一期 §4（CT-16 记录确认未触碰，不在任何「通过」声明覆盖内；本修订会话未复跑该项目）。

## 5. 未覆盖范围（未执行，不视为通过）

1. **live suite**：最终验证轮未运行 `--allow-live`（需真实测试模型凭据）。CT-16 ticket 轮曾真实执行并如实 blocked；真实模型质量（usage/compaction/sidecar/限流/unknown/无进展/同轮继续）全部未验证。
2. **Windows/Linux 平台 suite**：无可用机器，observe_only 未验证，不外推（autonomous 登记只随真实机器 platform suite 证据）；平台执行验证仅 darwin-arm64，darwin-x64 亦未测。
3. **安装器分发形态与远程资产**：dmg/zip 未测（`--dir` 只出 unpacked .app，不出安装器——安装器是同一 .app 的分发包装）。`ZCODE_SKIP_REMOTE_ASSETS=1` 是 packaged 验收构建时**显式设置的构建开关**（specs §742「如实取舍」），不是产品默认行为断言——含义是远程 workspace 原生资产不进产物，因此「远程资产在产物中的形态」本身未测；其依据 D4 是 `docs/specs/continuous.md` 决策表第 4 条「第一版仅本地 workspace，远程 workspace 自主执行不进入第一版」。
4. **正向本地提交链**（验证通过候选 → Program 分支提交）：未驱动——授权面声明测试命令第一版为空，候选 fail closed 不 done/不提交（已驱动边界为「无验证候选零提交 + 原仓库字节不变」）；`continuous-authorize` 端口与模板 v3 已在 `4bcf682` 接线，端到端正向提交仍待授权面扩展后真实验证。
5. **e2e 时钟类/候选路径 21 个用例与 E-21 手机链路**：维持 blocked（理由与证据引用见二期 §3）。
6. **真实 provider 定价来源**：仍缺席——价格快照为注入面（文件缺席 fail closed），CT-13 只增加版本严格校验。
7. **`4bcf682` 处置改动的端到端覆盖**：无（见二期 §3 时序声明）——处置后的端到端 suite 全部未执行，产品改动仅有包级测试；后续若解锁开启，须先在处置后代码形态复跑 e2e/regression/packaged 再谈验收。
8. **非打包（unpackaged）形态的进程级指纹核对**：一期 §5 第 7 条的残余在二期**仍未核对**。CT-16 的 spawn preflight 断言只在 packaged suite（`packagedSetup.mjs:13-49`；本修订会话 grep 实测 e2e 无同类断言）；注意「unpacked .app（打包未分发）」与一期「unpackaged（非打包、dev 形态）」是两个形近义反的词。e2e 在非打包形态真实创建了会话与 agent 进程，但记录未声称对加载 bundle 做指纹断言——该证据缺口仍开放（默认关闭阶段无暴露面，风险评级沿用一期）。
9. **本修订会话（汇总增补）的复核边界**：实际执行了 unit suite（44/44）、services 全量 continuous 测试（131/131）、bootstrap 全量 continuous 测试（85/85）、architecture check（0 violations）、`pnpm fmt:check`（33 文件清单比对）、`pnpm --dir apps/zcode-cli lint --force`（0 errors）、git log/diff 与关键代码点核对；integration/recovery/e2e/mobile/platform/regression/packaged/live 均未复跑，其结论出处已在二期 §3 逐条注明。

## 6. 当前状态与开启门槛（二期终点）

- 功能默认关闭不变：`ZCODE_CONTINUOUS_HOST_ENABLED` 未开 → channel 未注册 → tab 隐藏；CLI 侧未登记 run 被守卫拒绝（fail closed）；**自主实施 flag（release gate）保持关闭**。
- 与 §2.1 的关系（「六项有对应实现」与本清单为何并存）：二期把一期 §2.1 四项的**源代码接缝**（a0b128c 六行）与**产品装配**（CT-12…16）都落了地，实现层有包级测试与（处置前的）真实 E2E 证据；但**验收层未完成**——release §2.1 表头自述「源代码接缝已经修复，完整产品仍未达到开启条件」，第 5 行明示 flag 关闭的两个直接原因（live 验收 blocked、手机链路未完成）。本清单即 §2.1「仍需完成」残余与评审新增项的合并视图，二者不矛盾：实现 ≠ 验收。
- 开启前仍需处理：二期 §2 遗留 2 项已修复（`200a9a7` 挂起终态改写竞态、`3b97755` 登记回音词表，见 §2 登记）；一期未决 4（capability 探测堆积）亦已修复（`d4a0e46`，关闭态 stub + 探测超时，见 §2 下落表）——**代码级评审遗留至此全部清零**；仍开放：声明测试命令授权面扩展（候选正向链）、跨进程测试时钟桥、E-21 手机链路（外部 relay/凭据——2026-10-06 复跑仍因缺 `ZCODE_E2E_BROWSER_PATH` 标 blocked）、live 真实模型验收。端到端 suite 已于 2026-10-06 在 `3b97755` 代码形态复跑（`d4a0e46` 后 e2e 又复跑一次：9 passed/0 failed/21 blocked，E-24 关闭态实例 tab 缺席断言通过）：e2e exit 0（用例级 9 passed/0 failed/21 blocked，与 CT-15 记录一致）、mobile exit 0（1 blocked，浏览器可执行缺失）、regression exit 0（3 passed/0 failed，E-26/27/28 通过）——「`4bcf682` 后代码形态复跑端到端 suite」条件（§5 第 7 条）已满足，但 e2e 用例级 21 项 blocked 清单本身仍是开启前工作（同日静态/包级门禁：root 与 CLI typecheck 0 errors、lint 0 errors、改动文件 oxfmt 通过、integration suite exit 0 含新增竞态回归两用例、bootstrap 测试 exit 0）。
