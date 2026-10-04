# Continuous 实施 tickets

| 项目       | 内容                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 状态       | 可开始实施；未实现、未完成测试                                                                  |
| 基线       | `7a83710b4ba13427f1c41d29f0ac3b242a7dfc03`                                                      |
| 产品规格   | [continuous.md](../specs/continuous.md)，唯一产品规则来源                                       |
| 完整验证   | [测试与 E2E](../testing/continuous.md)                                                          |
| 已确认决策 | 独立分支自动本地提交、用户手动合并；退出停止/重启恢复；保守估算和未知额度保留；仅本地 workspace |

本文用于后续直接执行，不实施任何 ticket。所有 ADD 文件是建议新增位置，不代表当前存在。如需调整文件划分，职责、公开边界和验收 ID 必须保持一致。

## 总体执行规则

1. 开工先运行 freshness，保留用户本地改动；Node 24.14.0、pnpm 10.33.2 以 mise 为准。
2. 行为变更先更新规格和测试；代码使用 architecture-governance，先检查再读目标模块受控上下文。
3. 一张 ticket 一个可独立审查的功能提交；基础设施可分更小提交，不混无关重构。
4. services 不能引用 AgentRuntime 实现；UI 必须通过 hooks；Main/scheduler 不保存业务队列。
5. 新功能默认关闭；新 protocol 能力需查询 capability，旧 CLI 返回不支持，不能退回普通 prompt 自主执行。
6. 修改上游文件前通过 UPSTREAM-SYNC 的检查，小补丁只负责接线，规则放新模块。
7. 只有执行过的测试记 passed；failed、blocked、skipped 分开，未实施为 planned。
8. 每张 ticket 的记录包含实际 diff、测试命令和退出码、用例 ID、证据路径、已知旧失败和回滚步骤。
9. 不安装新测试库来绕过现有入口；Node test/tsx 与 desktop 的 playwright-core 足以开始。测试执行器为明确新增任务。

## 依赖关系

```text
CT-00 规则/契约/测试目录
  -> CT-01 存储
  -> CT-02 Program worktree 与操作限制
  -> CT-03 受控执行身份与恢复接口
  -> CT-04 预算/挂起确认/探活
  -> CT-05 手动完整 Cycle
  -> CT-06 Decision Queue
  -> CT-07 周期、执行权和恢复
  -> CT-08 UI/手机
  -> CT-09 E2E runner 与故障验收
  -> CT-10 跨平台与发布
```

单元/集成测试随 CT-01 起逐步加入，不等 CT-09 才编写。CT-00 先提供测试统一入口；CT-09 增加真实 Electron 执行和报告汇总。

## CT-00：锁定契约和测试入口

目标：把规格变成明确的接口和可追踪验收，不启动真实 Agent。

ADD：

- `packages/services/src/continuous/contract.ts`：公开 service、snapshot、命令、结构化错误。
- `packages/services/src/continuous/domain/types.ts`：Program/Cycle/Candidate/Decision/Budget/Scope。
- `packages/services/src/continuous/application/ports.ts`：Repository、Execution、WorkspacePreparation、Clock、RequestAdmission。
- `packages/shared/src/continuous-protocol.ts`：严格 schema 和 capability；复用既有身份构造器。
- `scripts/test-continuous.mjs`：suite 清单、参数校验、跨平台 spawn 和标准报告，不能吞 exit code。
- `packages/services/test/continuous/contract.test.ts`：必需字段、错误和兼容性。

MODIFY：services/shared 的实际公开入口和必要 package exports；`architecture-policy.yaml`；shared protocol index。新增 source 存在后更新 feature seed graph，只写已经验证的路径与符号。

规则：接口携带 workspacePath/identity/remoteSessionId、cycleId、traceId、epoch。ordinary task mode 不变；managed cycle capability 独立。

验收：U-01、U-02；旧 capability 不能误启动；测试执行器遇到 suite 空目录、无测试或 runner 缺失必须非零退出并标 missing，不能打印通过。

回滚：关闭 flag，保留新类型但不装配 service。无数据库/进程副作用。

## CT-01：长期状态和事务

目标：保存 Program、Cycle、队列、使用记录、事件和执行权，重开数据库仍可读。

ADD：

- `packages/services/src/continuous/adapters/sqliteRepository.ts`，按职责拆分，单文件不超过 CLI/仓库约定上限。
- `packages/services/src/continuous/application/continuousService.ts`：唯一写入口，先只接 CRUD。
- `packages/services/test/continuous/repository.test.ts`。

MODIFY：`packages/services/src/session/tasksDatabase/migrations.ts` 追加 migration；startup 接入；使用当前存储 worker 的公开入口，不让 UI 或 domain 做 SQL。

任务：

- 实施规格列出的表、CHECK、同 Program 复合 FK、索引和 archive。
- 创建 Cycle 和 trigger 去重原子化；一个 Program 一条未结束 Cycle。
- report 事件/队列/cursor 原子化；terminal Cycle 和 nextCycleAt 原子化。
- workspace lease 行保留单调 epoch，正常释放设空 cycle/owner，不重置 epoch。
- 旧 task/automation 行和 migration checksum 不变；不修改 DWF 原表。

验收：I-01、I-02、I-03；事务中断不出现半条队列；跨 Program FK 拒绝；migration 重跑安全；旧数据逐字段保持。

回滚：禁用装配，不做降级删表。旧版本忽略新表；历史和用户提交保留。

## CT-02：独立工作区、操作范围和交付

目标：只在授权的 Program worktree 内实施，原始工作区不变。

ADD：

- `packages/services/src/continuous/adapters/workspacePreparation.ts`：通过现有公开 Git/平台边界组装；无可复用能力的部分新增 adapter，不越层。
- `apps/zcode-cli/packages/bootstrap/src/app/continuous-execution-policy.ts`：actor 角色、候选授权、路径/命令检查。
- `apps/zcode-cli/packages/bootstrap/test/continuous/scope.test.ts`。
- `packages/services/test/continuous/workspace.test.ts`。

MODIFY：只在必要 filesystem/execution/MCP 接缝加入专用注入包装；不修改普通权限 mode 和默认 Workflow 行为。

任务：

- 从所选 HEAD 创建 `codex/continuous-<id>` 分支/worktree；保存实际 path/branch/commit。
- parent/child runtime 绑定 executionPath；原 workspace 只用于身份与展示。
- observer/reviewer 只读，builder 一次一个候选；文件工具、shell、外部工具都在操作前检查。
- 禁止任意 shell/部署/migration/push/merge；只开放配置中声明的测试命令，使用 argv 而非 shell 拼接。
- 处理 traversal、symlink、大小写、空格路径、Windows 路径、binary/rename、并发外部改动。
- 保留并核对候选检查点，验证失败只恢复归属明确的本候选文件。
- 测试和 Review 通过才本地提交；没有自动合并或 PR。

验收：U-03、I-04、E-02、E-13、E-14；禁止路径实际字节不变；绕过 attempt 返回 scope_denied；保留原工作区 staged/unstaged/untracked。

回滚：撤销授权并等待停止；保留分支和 worktree，不自动删用户成果。

## CT-03：受控 Run 身份、报告和停止

目标：使用现有有限 Run；请求重发不会重复执行。

ADD：

- `apps/zcode-cli/packages/bootstrap/src/app/continuous-execution-adapter.ts`。
- `apps/zcode-cli/packages/bootstrap/test/continuous/execution.test.ts`。

MODIFY：

- `dynamic-workflow-run-service.ts`：最小受控接口。
- `dynamic-workflow-run-submit.ts`：内部 submitOnce，普通 submit 随机 ID 语义不变。
- `dynamic-workflow-run-lifecycle.ts`：等待执行停止和统计收尾。
- `create-app.ts`：专用组装。
- `zcode-protocol-v4/commands/handlers/interaction-background.ts`、shared protocol：managed cycle 命令。
- `adapters/.../repositories/dwf-journal.ts`：公开按序读取报告；无 DWF schema 改动。

任务：稳定 session/run ID 创建和查询；同 ID 同内容复用，不同 hash/args/owner 拒绝；持久化绑定先于提交；保持现有 CommandInbox 和 owner/stale guard。用户明确停止时先撤销新操作，再 abort，等待 Agent/工具停止而不只等 run-settled。新增专用suspendAtSafeBoundary/resumeSuspended/inspectHealth接口；资源暂停不能调用stop结束Run，也不能把现有无pause状态伪装成支持。

验收：I-05、I-06、R-01、R-02、R-05；ACK 丢失仍只有一个 Run；completed 不 resume；errored/superseded 拒绝 resume；普通 Workflow confirm/resume/amend 回归通过。

回滚：关闭 managed capability，不修改普通 Workflow 启动；未结束 Cycle 留可核对状态。

## CT-04：预算、暂停确认、主动探活和模型准入

目标：每个请求尝试先预留，未知消费不丢失；达到上限保存同轮进度、暂停询问；探活区分正常等待与疑似卡死。默认并发10、tokens10亿、单轮USD100、每日USD1,000、有效执行1小时。

ADD：

- `packages/services/src/continuous/domain/budgetPolicy.ts`。
- `packages/services/src/continuous/application/budgetAdmission.ts`。
- `apps/zcode-cli/packages/bootstrap/src/app/continuous-model-budget.ts`。
- `packages/services/test/continuous/budget.test.ts`。
- `packages/services/src/continuous/application/continuationService.ts`：持久化继续确认与本轮grant。
- `packages/services/src/continuous/application/healthMonitor.ts`：实际进展、主动探活和有效计时。
- `packages/services/test/continuous/health.test.ts`。
- `packages/services/test/continuous/continuation.test.ts`。
- `apps/zcode-cli/packages/bootstrap/test/continuous/budget-runtime.test.ts`。

MODIFY：模型组装/准入的最小接缝，复用 ModelRequestAdmission；不改变所有 session 的全局 retry。

任务：持久化 price snapshot、request attempt ID、金额/token reservation；覆盖 compaction 与相关模型请求；并发原子准入；晚到/重复 usage；unknown 保留；Host 断联不新增请求；有限尝试/resume；每15秒主动健康查询，180秒无进展且3次确认失败才疑似hang；每操作期限与正常等待证据；一小时有效计时、等待豁免及重启持久化；同轮suspend不cancel；AskUserQuestion、grant、version和重复确认；每日timezone和跨日。

验收：U-04、U-05、U-08、I-07、I-12、R-07、R-11、R-12、E-08、E-09、E-10、E-29至E-34；相同 usage 不双计；Unlimited 不绕过单轮限制；不能限制请求/缺价格时明确拒绝。

回滚：停止新请求，保留账本与 reservation；不把未知额度清零。

## CT-05：手动完整 Cycle 与固定模板

目标：Run now 能完成从观察到验证提交的一轮，无需周期调度。

ADD：

- `packages/services/src/continuous/application/supervisor.ts`。
- `packages/services/src/continuous/application/reportIngestion.ts`。
- `packages/services/src/continuous/domain/candidatePolicy.ts`。
- `apps/zcode-cli/packages/bootstrap/src/continuous-templates/ui-ux-v1.ts`：版本化产品模板，不覆盖用户 saved workflow。
- `packages/services/test/continuous/cycle.test.ts`。
- `apps/zcode-cli/packages/bootstrap/test/continuous/template.test.ts`。

任务：Program 创建授权、Cycle 快照、Run 创建、报告校验/增量导入、有限候选选择、逐项验证提交、settling、最终摘要、sleeping；保存脚本 bytes/hash、模型配置、观察证据、选择理由、实际 diff 和 commit。

模板使用现有 typed ask/submit_result/report/artifact；不扩 compiler/lowering；不跨 Cycle imported cache。不得让 Continuous parent 同时运行 Goal continuation。

验收：I-08、I-09、E-01、E-03、E-12、E-15；no_changes 正常休眠；malformed report 不提交；验证不可用明确 unverified；晚到 usage 不遗漏。

回滚：禁用 Run now；保留历史和已验证提交，不重写 Engine。

## CT-06：非阻塞 Decision Queue

目标：人类选择长期 pending 时，无依赖候选仍可实施。

ADD：

- `packages/services/src/continuous/domain/decisionPolicy.ts`。
- `packages/services/src/continuous/application/decisionService.ts`。
- `apps/zcode-cli/packages/bootstrap/src/app/continuous-decision-adapter.ts`。
- `packages/services/test/continuous/decision.test.ts`。
- `apps/zcode-cli/packages/bootstrap/test/continuous/decision-runtime.test.ts`。

任务：Autonomous/Deferred/Blocking 分类、fingerprint/证据合并、局部 blockingScope、versioned resolve/dismiss、resolution→未来队列；执行中遇到问题持久化并撤销该候选许可，返回 defer，不等待人类；必要 driver 注入接缝保持普通 escalation 默认不变。

验收：U-06、I-10、E-04、E-05、E-06、E-07。核心标准是“10 pending + 3 independent + 2 dependent”：3 项完成、2 项推迟、Program 不暂停、下一轮仍启动。

回滚：停用新自主执行入口，保留 Decision 和 resolution；不能把 pending 清空。

## CT-07：周期、租约与恢复

目标：周期唤醒可靠，重启不重复启动，中断可核对恢复。

ADD：

- `packages/services/src/continuous/domain/cadencePolicy.ts`。
- `packages/services/src/continuous/application/recovery.ts`。
- `packages/services/src/continuous/application/workspaceLease.ts`。
- `packages/services/test/continuous/scheduler.test.ts`。
- `packages/services/test/continuous/recovery.test.ts`。

MODIFY：desktop scheduler/main 只增加 wake；Host 组装和路由；不能复制普通 automation 的派发即释放锁。

任务：nextCycleAt、stable trigger key、原子 Cycle/lease、epoch 到每个副作用；原 owner 核对、撤销与停止证明；重启先未结束后到期；睡眠只补一次；关闭/退出/断联；有限退避；用户取消不自动resume；suspended及pending继续确认在重启/跨日后保持，用户同意前不恢复；健康等待不触发一小时取消。

验收：U-07、I-11、R-01 至 R-10、E-11、E-16、E-17、E-18、E-19、E-20。租约过期但旧进程活着时不得第二次实施。

回滚：停止 scheduler wake，等待或停止现有 Cycle，保留手动查询与记录。

## CT-08：桌面与手机 UI

目标：配置和执行状态清楚，Decision 不被误显示成暂停。

ADD：

- `packages/ui/src/hooks/useContinuous.ts`。
- `packages/ui/src/settings/continuous/ContinuousSection.tsx`。
- `packages/ui/src/settings/continuous/ContinuousProgramDetail.tsx`。
- `packages/ui/src/settings/continuous/DecisionQueue.tsx`。
- `packages/ui/src/settings/continuous/ImprovementQueue.tsx`。
- `packages/shared/src/test-ids-continuous.ts`：稳定测试标识。

MODIFY：`AutomationsSection.tsx`、`AutomationsPageTitleSwitch.tsx`、`app-shell/WorkspaceShellLayout.tsx`、`WorkflowRunSidePane.tsx` 和当前实际 locale 文件。各语言依当前仓库集合处理，不推测存在的语言。

任务：Continuous tab、创建授权表单、预算/Scope/Cadence、Run now/Pause/立即停止、Cycle/队列/分支/证据；新增资源继续AskUserQuestion，显示额度/增量/最近探活/等待原因/有效与墙钟时长；保持暂停和结束本轮分开；手机控制既有 Host；保持 mode 枚举不变；以服务事件/snapshot 更新，不在 store 中另建接受队列。

验收：E-01 至 E-20 的交互、E-21、E-22、E-23、E-24、E-29至E-34；390/768/1280 宽度、浅深主题、当前支持语言；键盘、焦点、可读标签和错误反馈。

回滚：隐藏 tab，服务 flag 同时关闭；历史仍保留，不隐藏未停止执行的事实。

## CT-09：真实 E2E runner 和故障证据

目标：为所有验收生成真实证据，不只测试函数或静态截图。

ADD：

- `packages/desktop/test/continuous/e2e.test.mjs`。
- `packages/desktop/test/continuous/runner.mjs`：Node test + 当前 playwright-core Electron API。
- `packages/desktop/test/continuous/fixtures.mjs`：临时 Git 仓库、可启动 UI 目标、脚本化 provider。
- `packages/desktop/test/continuous/evidence.mjs`：脱敏日志、截图、trace、SQL 事实和 diff 汇总。
- `packages/desktop/test/continuous/live.test.mjs`：显式 opt-in 真模型验收。
- `packages/desktop/test/continuous/mobile.test.mjs`：浏览器连接桌面同一 Host。

MODIFY：CT-00 runner 加入实际 suite 与 artifact 清单；只在 test build + run ID 双重条件下暴露故障注入和只读检查接口，生产不暴露。

任务：隔离数据目录、实际 CLI 构建、Electron/Host/Agent/VM、UI 命令、确定性 provider、可控时钟/barrier、崩溃进程树、快照/重连、失败 artifact。不能用数据库直接修改业务状态代替 E2E 用户动作。

验收：测试文档所有核心 ID 有报告；kill、ACK 丢失、乱序/重复结果由事件 barrier 精确注入；失败不自动重跑直到通过；平台不可用标 blocked 而非 passed。

回滚：仅去掉 test runner/测试专用接口；普通运行行为无依赖。

## CT-10：跨平台、兼容回归与发布

目标：在声明支持的平台提供实际可控的自主执行。

任务：macOS/Windows/Linux 验证路径、进程取消、worktree、SQL、命令 sandbox；能力不足时只读且解释；两种交付语义回归；普通 Workflow/Automation/Goal/权限确认回归；完整 typecheck/lint/fmt/architecture；逐平台证据和默认关闭到开启的记录。

验收：E-25 至 E-34；R 全部；核心脚本化 E2E 通过；真模型至少 E-01/E-03/E-04 的实际链路验收；生产 build 不含测试故障接口。没有身份凭据时真模型测试 blocked，不能替代为模拟通过。

回滚顺序：关闭调度与新启动 → 撤销新请求/写入 → 等待停止或保存 interrupted → 回退入口 → 保留 DB、worktree、用户改动和历史。不得靠删表回滚。

## 明确不改的现有核心

```text
apps/zcode-cli/packages/dynamic-workflow/src/compiler/compile.ts
apps/zcode-cli/packages/dynamic-workflow/src/lowering/lower.ts
apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts
apps/zcode-cli/packages/dynamic-workflow/src/engine/scheduler.ts
apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-source.ts
apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts
packages/shared/src/zcode-task-mode-schema.ts
```

原 DWF 表与旧 migration 不改。普通 Workflow 人类确认和 escalation 不改。发现接缝不足时追加专用可选接口及回归，不改变这些产品规则。

## Ticket 完成记录模板

```text
Ticket: CT-xx
Commit / 基线:
实现范围 / 实际文件:
Spec 规则编号:
测试命令 / exit code:
用例 IDs / passed / failed / blocked / skipped:
E2E 类型: scripted / live / manual（分别记录）
Evidence directory:
旧失败与本次新增失败:
未验证平台/范围:
回滚步骤与停止证明:
```

发布门槛：所有核心行为与恢复用例通过，未验证范围明确；不能将 runner 存在、截图生成或 lint 通过写成端到端验收完成。
