# Continuous：产品与架构规格

| 项目       | 内容                                           |
| ---------- | ---------------------------------------------- |
| 状态       | 方案已定；尚未实现                             |
| 日期       | 2026-10-04                                     |
| 源码基线   | `7a83710b4ba13427f1c41d29f0ac3b242a7dfc03`     |
| 实施任务   | [Continuous tickets](../tickets/continuous.md) |
| 测试与 E2E | [完整测试流程](../testing/continuous.md)       |

本文规定第一版行为。本文中的新类型、表、接口和文件均为实施要求，不代表当前已经存在。只修改文档，不实现功能。

## 1. 已确认的产品决策

用户通过决策问题确认了四项规则，并在后续明确调整资源默认值、暂停确认和探活行为：

| 编号 | 决策                           | 必须遵守的行为                                                                               |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| D1   | 独立分支自动提交，用户手动合并 | 系统创建独立 Program 分支/worktree；验证通过后本地提交；不自动创建 PR、push、merge 或 deploy |
| D2   | 桌面退出后停止，下次启动恢复   | 应用运行且对应 Host 可用时执行；退出后停止；恢复时先核对未结束 Cycle                         |
| D3   | 保守预留与估算费用             | 显示估算费用；未知用量保留预留；不声称与供应商账单完全一致                                   |
| D4   | 第一版仅本地 workspace         | 初次授权包含创建独立分支/worktree和本地提交；远程 workspace 自主执行不进入第一版             |

手机可以查看和操作桌面已有本地 Program，不能新建手机 Agent、Host 或远程执行 session。项目目标、Scope、预算和模板变更需按第 6 节处理，不引入新的开放问题。

## 2. 目标、范围与默认值

Continuous 在长期目标下定期观察产品，发现候选，选择可自主实施的小改进，测试、浏览器验证、审查，保存本轮结果，然后休眠。

永续的是 Program 状态、队列、账本和时间表。每个 Cycle、Run 和主动执行的 actor session 都有限。新 Cycle 不复用上一轮 actor 对话或 imported cache。

第一版包含：本地 UI/UX 改进、手动启动、interval/daily 调度、局部决策阻塞、预算、独立分支本地提交、重启恢复、桌面和手机控制页面。

第一版排除：独立 daemon、远程 workspace 自主执行、自动 PR/push/merge/deploy、跨项目、复杂依赖图、通用事件总线、语义长期记忆、自动 amend、多 Run Cycle。

默认配置为产品常量，设置页可在授权时修改：

| 设置             | 默认值 / 限制                                                 |
| ---------------- | ------------------------------------------------------------- |
| cadence          | 上一轮结束后 6 小时；也支持每日指定本地时间                   |
| 初次执行         | 创建并授权后到期立即执行一次                                  |
| 每日估算费用     | USD 1,000；可选择 Unlimited                                   |
| 单轮估算费用     | USD 100；必须为正的有限值                                     |
| 单轮 tokens      | 1,000,000,000（10 亿）；包含模型执行和相关内部调用            |
| 单轮改进         | 最多 3 项                                                     |
| 单轮文件         | 最多 10 个，包括新增/删除/重命名涉及的路径                    |
| 单轮改动行       | 最多 400 行，按相对单轮起始 commit 的累计实际 diff 计算       |
| 并发 actor       | 最多 10；计入全部 actor，builder 仍最多 1 个                  |
| 单轮执行时间     | 有效执行时间最多 1 小时；已确认的正常阻塞不计时，见第 10.1 节 |
| 单次模型请求尝试 | 最多 3 次，总费用逐次预留                                     |
| 单轮 resume      | 最多 2 次                                                     |
| 连续失败         | 3 个失败 Cycle 后 Program 进入 failed，需显式恢复             |
| 临时恢复退避     | 首次 30 秒，第二次 120 秒；超限暂停询问，不无限自动重试       |
| 时区             | 创建时读取系统 IANA timezone 并持久化，后续不随系统悄悄改变   |

不按 tool call 数量停止正常工作。达到费用、token、有效执行时间、改动量或恢复次数上限时保留同一 Cycle，暂停并询问用户是否继续，不自动取消或结算任务。Unlimited 只取消每日额度；单轮限制仍触发暂停确认。Scope 禁止项不能通过“继续”绕过。

## 3. 当前源码证据与差异

以下路径均为当前仓库文件，路径相对仓库根目录。实施时再次核对基线，不沿用过时行号。

| 文件 / 符号                                                                                                          | 已确认事实                                                            | 设计影响                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/dynamic-workflow/src/compiler/compile.ts`：`createWorkflowProgram`、`compileWorkflowScript` | 虚拟 TypeScript 编译检查                                              | 固定模板继续用现有编译器                                                      |
| `apps/zcode-cli/packages/dynamic-workflow/src/lowering/lower.ts`：`lowerWorkflow`                                    | 脚本降低为 `__host` 调用                                              | 不增加长期循环语义                                                            |
| `apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts`：`runWorkflowScript`                               | 父 CLI 创建 Engine；子进程执行脚本 VM；支持中止                       | Engine 不在子进程 VM 中；复用现有取消路径                                     |
| `apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-source.ts`                                               | VM 限制 process/require/fetch/随机与时间                              | 不能把 VM 限制当成 Agent 工具范围限制                                         |
| `apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts`：`WorkflowEngine`                                    | journal-first；恢复节点；usage 可在 Run 结束后更新                    | Cycle 需要独立结算阶段                                                        |
| `apps/zcode-cli/packages/dynamic-workflow/src/engine/engine-settlement.ts`：`settleCompleted`                        | 脚本返回即完成，仍运行的 ask 会被中止                                 | completed 不等于产品验证通过                                                  |
| `apps/zcode-cli/packages/dynamic-workflow/src/engine/scheduler.ts`：`AskScheduler`                                   | actor 内串行、actor 间受并发限制；完成节点回放                        | 未记录完成的外部操作可能重复，不能承诺所有副作用只发生一次                    |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-service.ts`：`createDynamicWorkflowRunService`       | parent session 范围；registry 在内存；Caps 仅并发                     | 上层长期状态不放这里；需最小 submitOnce 扩展                                  |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-submit.ts`：submit/resume/amend                      | submit 随机 ID；resume 同 Run、同脚本；amend 新 Run 和 imported cache | 新 Cycle submit；中断才 resume；MVP 不自动 amend                              |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-reconcile.ts`：`reconcileOrphanRuns`                 | 核对当前 parent session 的非终态 Run；不补造 run-settled 事件         | 恢复查询状态，不依赖一次性回调                                                |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver.ts`：`AgentRuntimeWorkflowDriver`                         | actor 内复用对话；dispose 不等于所有异步工作已收尾                    | 增加专用执行停止检查                                                          |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts`：`createScriptWorkflowAgentRuntime`     | child cwd 来自注入的 workingDirectory                                 | 创建 parent/child 时就绑定 worktree，不只修改 run.cwd                         |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-model-failure.ts`                                         | transient redrive 会继续重试                                          | 专用执行层增加期限和尝试上限                                                  |
| `apps/zcode-cli/packages/core/src/runtime/methods/model-request-session-type.ts`                                     | workflow child 使用 Unbounded 重试预算                                | 不全局重写 retry；Continuous adapter 施加有限边界                             |
| `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`：`AgentRuntime.executeTurn`                              | 实际模型和工具执行入口                                                | 复用，不让 services 引用具体实现                                              |
| `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts`                                       | 已有单 session Goal continuation                                      | 不承担 cadence/Decision/Cycle；Continuous parent 不并行开启 Goal continuation |
| `apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts`：`createWorkflowToolEntry`                       | 编译、草稿、确认、submit；alwaysAsk                                   | 不全局绕过确认；新增绑定授权的内部启动入口                                    |
| `apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-run-start.ts`：`startSavedWorkflowRun`            | 用户点击启动保存脚本，可直接走 Run 服务                               | 不盲目复用为无条件后台授权                                                    |
| `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/store.ts`                                            | 保存的是可变文件                                                      | Program 绑定模板版本/hash；Cycle 保存原始脚本快照                             |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`                                           | `dwf_run/actor/node/event` 已有持久化                                 | 不修改这些旧 migration；Continuous 使用独立表                                 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal-codecs.ts`                      | errored→failed，stopped→cancelled 的数据库编码                        | 通过公开接口读取逻辑状态                                                      |
| `packages/services/src/session/tasksDatabase/startup.ts`、`migrations.ts`                                            | Host tasks-index 独立数据库和 migration                               | 新增长期业务表，保持异步 service 边界                                         |
| `packages/desktop/src/scheduler/index.ts`、`main/desktopCronScheduler.ts`                                            | 桌面调度随应用生命周期运行                                            | 退出停止，不承诺 daemon                                                       |
| `packages/desktop/src/host/index.ts`：`dispatchCronRun`                                                              | automation 创建/恢复 task 后发普通 prompt                             | Continuous 不能直接复制 automation 执行方式                                   |
| `packages/services/src/session/automationRepo.ts`                                                                    | 某些认领在派发成功后释放                                              | Cycle 执行权持有至结算，不照抄派发锁                                          |
| `packages/ui/src/v4/composer/V4ComposerModeControls.tsx`：`V4ComposerModeSwitch`                                     | build/edit/yolo 权限模式、独立 Plan 开关                              | 不向权限枚举加入 continuous                                                   |
| `packages/ui/src/settings/AutomationsSection.tsx`、`saved-workflows/AutomationsPageTitleSwitch.tsx`                  | 现有 automation/workflow 页面                                         | 增加 Continuous 第三个 tab                                                    |
| `packages/ui/src/app-shell/WorkflowRunSidePane.tsx`                                                                  | Run timeline/graph 详情                                               | 复用 Run 展示，新增 Cycle 摘要                                                |

Root `pnpm typecheck` 不涵盖全部 CLI package，实施验证必须补 `pnpm --dir apps/zcode-cli typecheck`。仓库有 E2E bridge 和 playwright-core，但当前没有可直接运行的 Continuous E2E runner。

## 4. 架构与唯一状态所有者

```text
UI：Continuous 页 / hooks / 服务接口
                     |
                     v
Host：ContinuousService（唯一业务写入者）
  Program + Supervisor + Scope/Decision/Budget policy
           |                         |
           v                         v
  tasks-index.sqlite          注入 ExecutionPort
  Program/Cycle/Queue/Usage           |
  Event/WorkspaceLease               v
                             CLI bootstrap adapter
                             授权/submitOnce/恢复/报告
                             文件/命令限制/模型准入
                                      |
                                      v
                             现有 Dynamic Workflow
                             compiler/analysis/lowering
                             父进程 Engine/driver/journal
                             子进程有限脚本 VM
                                      |
                                      v
                             AgentRuntime 与工具

桌面 scheduler --wake--> Main --按身份转发--> Host
```

责任：

- services 新增 `continuous` 受控模块：domain/application/adapters，公开 contract；不能导入 Runtime 实现。
- Host 组装 service 和执行接口，管理窗口已有 attachment，不新建第二个本地 Host。
- Main 只转发唤醒和进程生命周期；scheduler 只查询和唤醒，不能创建 Cycle 或写队列。
- CLI bootstrap 包负责连接既有 Run service 和 Agent 工具；业务规则使用明确注入接口。
- UI 通过 `packages/ui/src/hooks/` 访问服务；不直接 Repo、SQL 或 window.zcode。

身份统一为 `workspaceIdentity?.trim() || workspacePath`。workspacePath 用于原始仓库，executionPath 用于 Program worktree；两者不可混用。协议保留 workspaceIdentity/remoteSessionId，但第一版远程启动返回结构化 `remote_execution_not_supported`。

`desktop-continuous` 和 `web-remote-replayable` 仍是交付语义，不与产品名混淆。

## 5. 模型、表和索引

所有长期对象均为 MVP。Program 不复用 session_target；Candidate 不伪装成已接受的普通 task；DWF 执行引用不使用旧 workflow_run 的 FK。

新增 `ContinuousContinuationRequest`，用于资源上限或运行健康问题的用户确认。它与产品 Decision Queue 分开：产品决策只阻塞相关候选；资源确认暂停所属 Cycle。字段必须包含 id、programId、cycleId、reason、limitKind、observedUsage、currentLimit、recommendedExtension、version、status（pending/resolved）、resolution、createdAt/resolvedAt。reason 覆盖 cost/token/time/change/retry/resume 上限、suspected_hang 和 health_unknown。每个 Cycle 同时最多一条 pending 请求，多项触发合并，不重复弹窗。

```ts
type ProgramStatus = "active" | "sleeping" | "paused" | "failed" | "completed";
type CycleStatus =
  | "preparing"
  | "running"
  | "settling"
  | "interrupted"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";
type CandidateStatus = "candidate" | "queued" | "implementing" | "done" | "rejected" | "deferred";

interface Program {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  revision: number;
  goal: string;
  scope: ScopePolicy;
  budget: BudgetPolicy;
  cadence: CadencePolicy;
  decisionPolicy: DecisionPolicy;
  authorization: {
    revision: number;
    templateHash: string;
    grantedAt: string;
  };
  templateId: string;
  templateVersion: string;
  templateHash: string;
  executionPath?: string;
  branchName?: string;
  status: ProgramStatus;
  statusReason?: string;
  nextCycleAt?: number;
  lastCycleAt?: number;
  consecutiveFailures: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface Cycle {
  id: string;
  programId: string;
  sequence: number;
  triggerKey: string;
  trigger: { kind: "manual" | "interval" | "daily" | "decision_resolved" };
  status: CycleStatus;
  configurationSnapshot: unknown;
  scriptText: string;
  scriptHash: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
  leaseEpoch: number;
  resumeAttempts: number;
  activeDurationMs: number; // 已确认正常等待、用户暂停、离线不计入
  normalBlockedDurationMs: number;
  lastProgressAt?: number;
  lastProbeAt?: number;
  healthState: "progressing" | "normal_wait" | "suspected_hang" | "unreachable";
  pendingContinuationRequestId?: string;
  reportCursor: number;
  baseCommit?: string;
  result?: {
    outcome: "changes_verified" | "no_changes" | "partial";
    changedFiles: string[];
    commits: string[];
    evidence: unknown[];
    summary: string;
  };
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface Candidate {
  id: string;
  programId: string;
  sourceCycleId: string;
  fingerprint: string;
  title: string;
  rationale: string;
  targetPaths: string[];
  impact: number;
  confidence: number;
  effort: number;
  risk: "low" | "medium" | "high";
  status: CandidateStatus;
  executionCycleId?: string;
  evidence: unknown[];
}

interface Decision {
  id: string;
  programId: string;
  sourceCycleId: string;
  fingerprint: string;
  version: number;
  title: string;
  context: string;
  options: { id: string; label: string; consequences: string }[];
  recommendation?: string;
  classification: "deferred" | "blocking";
  blockingScope?: { candidateIds: string[]; paths: string[]; capability?: string };
  status: "pending" | "resolved" | "dismissed";
  resolution?: { optionId?: string; text?: string; resolvedAt: number };
}
```

SQL 设计在新 tasks-index migration 中实施。下表明确列结构和约束；JSON 字段必须经运行时 schema 校验，不能任意输入。

| 新表                              | 必须的列与约束                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuous_program`              | id PK；workspace_key/path/identity/remote_session_id；revision；status CHECK；status_reason（暂停/失败等原因，对应 Program.statusReason）；config_json；authorization_json；template id/version/hash；execution_path；branch_name；next_cycle_at；last_cycle_at；consecutive_failures；archived_at；created_at/updated_at                                                                                                                                                                                         |
| `continuous_cycle`                | id PK；program_id FK RESTRICT；sequence；trigger_key/json；status CHECK；config_snapshot_json；script_text/hash；execution_session_id；workflow_run_id UNIQUE；trace_id；lease_epoch；resume_attempts；active_duration_ms；normal_blocked_duration_ms；health_state；last_progress_at；last_probe_at；pending_continuation_request_id；report_cursor；base_commit；result_json；started_at/completed_at/created_at/updated_at；UNIQUE(program_id,sequence)、UNIQUE(program_id,trigger_key)、UNIQUE(program_id,id) |
| `continuous_candidate`            | id PK；program_id；source_cycle_id；fingerprint；status CHECK；body_json；execution_cycle_id；created_at/updated_at；UNIQUE(program_id,fingerprint)、UNIQUE(program_id,id)；复合 FK(program_id,source_cycle_id/execution_cycle_id)→Cycle(program_id,id)                                                                                                                                                                                                                                                           |
| `continuous_decision`             | id PK；program_id；source_cycle_id；fingerprint；version；status CHECK；body_json；resolution_json；resolved_at；created_at/updated_at；UNIQUE(program_id,fingerprint)、UNIQUE(program_id,id)；复合 FK→来源 Cycle                                                                                                                                                                                                                                                                                                 |
| `continuous_candidate_decision`   | program_id/candidate_id/decision_id；PK(candidate_id,decision_id)；复合 FK 分别指向同一 Program 的 Candidate 和 Decision                                                                                                                                                                                                                                                                                                                                                                                          |
| `continuous_usage`                | id PK；cycle_id FK；request_key UNIQUE（请求尝试身份）；state CHECK reserved/settled/unknown；provider/model；pricing_version；usage_json；reserved_cost_micros；estimated_cost_micros；reserved_tokens；actual_tokens；occurred_at/updated_at                                                                                                                                                                                                                                                                    |
| `continuous_event`                | id 递增 PK；program_id FK；cycle_id FK 可空；event_key UNIQUE；type；payload_json；created_at                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `continuous_workspace_lease`      | workspace_key PK；cycle_id 可空 UNIQUE FK；owner_id 可空；epoch；expires_at 可空；updated_at；跨窗口共享执行占用；释放后 cycle/owner/expiry 同时为空，epoch 保留                                                                                                                                                                                                                                                                                                                                                  |
| `continuous_continuation_request` | id PK；program_id/cycle_id 复合 FK；version；reason；status CHECK pending/resolved；request_json；resolution_json；created_at/resolved_at；部分唯一索引 cycle_id WHERE status=pending，保证同轮只问一次                                                                                                                                                                                                                                                                                                           |

必要索引：

```sql
CREATE UNIQUE INDEX continuous_one_open_cycle
ON continuous_cycle(program_id)
WHERE status IN ('preparing', 'running', 'settling', 'interrupted', 'suspended');

CREATE INDEX continuous_due_program
ON continuous_program(status, next_cycle_at)
WHERE archived_at IS NULL;

CREATE INDEX continuous_candidate_queue
ON continuous_candidate(program_id, status);
CREATE INDEX continuous_decision_queue
ON continuous_decision(program_id, status);
CREATE INDEX continuous_usage_period
ON continuous_usage(occurred_at, cycle_id);
CREATE INDEX continuous_event_history
ON continuous_event(program_id, id);
```

workspace lease 过期不能直接删除或接管。epoch 单调增加；正常释放仍保留 epoch，SQL CHECK 保证 cycle/owner/expiry 同时有值或同时为空。租约实现必须同时维护 owner/epoch 和当前 Cycle 关联，不把 expires_at 当作进程死亡证明。

DWF journal 位于另一个数据库，workflow_run_id 为受控软引用，不声明跨数据库 FK。当前 Run 引用通过 CLI 接口核对。pending_continuation_request_id 指向同轮确认请求，服务事务校验所属关系；资源暂停、请求创建与许可冻结同事务保存。Report 导入事件、队列修改和 cursor 同事务提交。Cycle 结束、Program 失败计数和 nextCycleAt 同事务提交。SQLite 同步调用运行在既有存储 worker/adapter 边界，服务方法保持异步。

Program 归档前必须没有主动执行；不级联清除审计历史。后续支持多 Run/amend 时再增 Cycle-Run 关联表；当前不得预先建设。

## 6. 状态机和变更规则

```text
Program
 ACTIVE --本轮结束--> SLEEPING --到期/Run now--> ACTIVE
   |                     |
   +----暂停-------------> PAUSED --显式恢复--> ACTIVE/SLEEPING
   +----资源上限/疑似卡死-> PAUSED（附继续确认）--用户授权--> ACTIVE
   +----连续失败3轮------> FAILED --显式重试--> ACTIVE
   +----结束目标---------> COMPLETED

Cycle
 PREPARING --> RUNNING --> SETTLING --> COMPLETED / FAILED / CANCELLED
     |            |
     |            +--> SUSPENDED --用户继续，同Run/同Cycle--> RUNNING
     |            +--> INTERRUPTED --同Run安全恢复--> RUNNING
     +--> FAILED/CANCELLED        +--恢复次数超限--> SUSPENDED
                                  +--确认不可恢复--> FAILED

Decision
 PENDING --> RESOLVED --> 关联候选重新核对，进入未来Cycle
         --> DISMISSED --> 不获得实施许可
```

确定规则：

- pending Decision 不改变 Program 状态，不默认阻止当前 Cycle。
- Pause 立即禁止新 Cycle，当前轮可结束；界面显示“当前轮结束后暂停”。另有“立即停止本轮”。
- 立即停止本轮先撤销写入/请求许可，再取消和等待停止，Cycle cancelled；Program paused；不能自动 resume 用户取消的 Run。
- 达到预算、tokens、有效执行时间或改动上限：冻结新请求和新写入，允许已授权的在途操作到达安全边界；保存进度，Cycle suspended，Program paused，持久化继续确认。不得自动将 Cycle 标为 partial/completed/cancelled，不能启动替代轮。
- 没发现改进：Cycle completed/no_changes，Program sleeping。
- 一次失败：记录失败并按 cadence/退避有限重试；连续三轮 failed。failed 不是 pending Decision。
- Goal、Scope、模板或模型配置变更：revision+1，撤销旧写入许可，停止并结算当前轮；保存为 paused；用户保存并确认新授权后，未来新 Cycle 用新快照。
- 单纯预算增加、降低和 cadence 修改不扩大 Scope：原授权继续有效，只更新配置、updatedAt 和审计事件，不递增授权 revision；降低预算立即影响新请求；cadence 只影响未来轮。用户明确选择“本轮继续”时，追加本轮授权额度/时间；保留原快照和独立 continuation grant，不能抹掉已消耗量。普通配置修改不自动恢复暂停轮。
- repo/worktree 内容与已观察版本不同：候选实施前重新核对；不覆盖外部改动。无法确认归属时取消相关候选，结束当前轮，下一轮重新观察。
- 模板与模型升级不改变已存在 Cycle 的快照。旧模板不可用则明确失败，不静默换脚本 resume。

### 6.1 达到上限后的继续确认

达到上限且仍有本轮工作需要超额继续时，在安全边界挂起任务，而不是丢弃任务。恰好在额度内完成全部本轮工作可以正常结算；并发达到10只让额外actor排队，不因排队要求用户扩额。先阻止新请求/新写入，已预留且已开始的有限操作可完成并保存结果；不能强行回滚已完成改进。暂停不是用户取消，不调用会让整轮永久 cancelled 的路径。现有 DWF 没有原生暂停状态，必须新增专用请求/工具准入挂起接口，不能只把 UI 文案改为“暂停”。

持久化 Cycle suspended、Program paused、pauseReason、用量、报告 cursor、检查点和继续确认。CLI 仍在线时保持 Run 与执行身份，不新增模型请求等待用户；退出导致 interrupted 时，下次按原身份恢复。未确认前禁止新 Cycle，也不自动 resume。

通过 AskUserQuestion 对用户提供：

1. **增加本轮额度或时间并继续**：明确展示增加金额/token/时间；保存本轮 continuation grant 后恢复同一 Cycle/Run。仅确认受影响上限，不能解除其他限制。
2. **调整长期默认配置并继续**：用户给出明确新值，保存配置和本轮 grant；不改变 Scope。
3. **保持暂停**：保留 pending 工作；以后再回答，无默认超时同意。
4. **结束本轮**：明确用户取消后，才结算 cancelled/partial，保留已验证提交。

临时 grant 只作用当前 Cycle；下一轮仍用 Program 配置。恢复保留已消耗量，以原上限加授权增量计算，不能重新给出一份未使用的整轮预算。每日重置、应用重启、弹窗关闭和用户无回应不算同意。重复回答/version 校验必须幂等。

连续确认不隐含永久 Unlimited。疑似卡死时先给出诊断与停止当前异常子操作、恢复检查点的方案；“继续”不能无条件启动第二执行者。无法证明旧操作安全停止时，保持暂停并说明原因。

## 7. 执行、交付与验证

创建 Program worktree 从用户明确选择的现有 HEAD 开始。分支名默认 `codex/continuous-<program-id>`。原工作区有未提交变更时不复制、不覆盖；页面明确说明本轮以 HEAD 为基础。只创建并管理本功能自己的 worktree，不清理用户 worktree。

每轮记录起始 commit。每个候选修改前建立受控检查点，限制只改当前授权路径。测试、浏览器验证和独立 Review 全部通过，才允许本地提交并标记 done。

验证失败的修改只能在“确认是本候选所写且无人外部修改”的路径中恢复；禁止全仓 hard reset 或清理未跟踪文件。归属不清时保存证据并停止该轮，不自动覆盖。已完成候选提交保留，后续失败不撤销它们。

固定版本骨架依次执行：

```text
观察/批评（只读）
 -> 结构化候选与证据
 -> 服务分类与依赖检查
 -> 选择最多3项自主候选
 -> 单builder逐项实施
 -> 可执行测试
 -> 浏览器/视觉验证
 -> 只读独立Review
 -> 每项本地提交
 -> 最终报告
```

模型不能直接声称验证通过：必须附命令、退出码、浏览器断言/截图和 reviewer 结果。目标应用无法启动或浏览器不可用时记录 unverified，该候选不能 done/提交；继续处理可独立验证的其他候选。

最大文件数和改动量按单轮累计变化检查，删除、rename、binary 均计入；第一版禁止自主修改 binary、lockfile、依赖定义和测试基础设施。禁止删除/弱化测试以制造通过。Cycle 整体不限制为一个巨大提交。

## 8. Decision Queue

Scope 默认允许 UI、UX、响应式、无障碍、视觉一致性的小改进。navigation architecture、重大信息结构、design system replacement、破坏性产品流程须决策；后端重写、数据库 migration、计费和鉴权架构替换禁止。

服务同时检查语义分类和操作能力；模型分类不是授权。未知类别默认进入决策，不扩大 allowed。

队列分开保存：

```text
候选 A Header spacing --------------------> 可实施
候选 B Mobile sidebar overflow -----------> 可实施
候选 C Settings navigation ---> Decision D -> 暂缓 C
候选 E Empty state ------------------------> 可实施
```

Decision 通过 fingerprint 去重，追加来源和证据；保留来源 Cycle、选项、推荐和相关候选。blockingScope 必须明确 candidate/path/capability，不默认覆盖整个 UI 包。

选择时过滤 forbidden、依赖 pending Decision 及与 blockingScope 重叠的候选。其余候选照常排序和实施。所有候选都依赖决策时，Cycle completed/no_changes，等待 cadence 或 resolution；不暂停 Program。

执行中发现需决策事项：专用适配器持久化 Decision，撤销该候选写入许可，返回结构化 defer；骨架跳过该候选，不 await 人类输入。普通 Workflow 的 escalation 不改变。

Resolve 使用 version 防止覆盖其他回答；resolution 和相关入队事件同事务保存。相关候选在下一轮按现仓库、Scope 和预算重新检查，不能插入正在执行的冻结计划。Dismiss 不授权实施。用户回答不自动扩大 forbidden 范围；需要改 Scope 并重新授权。

## 9. 预算和请求所有权

额度耗尽是可恢复暂停，不是任务失败。用户确认前不发起新费用；每日重置也不自动恢复因额度暂停的任务，必须取得用户的继续授权。

ContinuousService 是预算账本唯一写入者。CLI 通过注入的准入接口为每个请求尝试取得 ticket，数据库持久化预留后才能调用 provider；收齐 usage 后幂等结算。请求重试、compaction 等调用也须走该接口。

```text
CLI 请求计划
 -> Host 原子检查日/单轮额度，保存 reservation
 -> 返回 request ticket
 -> CLI 执行一次 provider 请求
 -> usage 回传
 -> Host 幂等结算
```

断开 Host 时不能在本地自行扩额；新请求拒绝。晚到 usage 仍可结算已有 ticket，不触发新执行。取消和记录结果不需要额外的模型请求。

每个请求必须有输入上限和输出上限，按价格快照保守预留。价格缺失或不能限制请求时拒绝费用限额下的自动执行，显示原因。tokens 使用相同预留机制，不能仅在全部费用发生后才检查。

计算：已结算估算费用 + 未结算保留额度 + 新预留 <= 当前额度。金额用整数微美元，不用浮点累加。不累加 amend lineage 的 spentTokens。

unknown usage 保留 reservation。重启查询 provider 或可用执行证据核对；无可靠数据时仍 unknown，只能用户显式核销，保留审计。未知预留足以耗尽限额时暂停并询问；继续必须显式增加额度或核销，不能因用户点击继续而清零未知记录。

日窗口根据请求预留时持久化的发生时间和 Program 时区统计；后来的补结算仍归入原窗口。新一天不删除旧记录。多个 Program 各有预算，UI 明示没有账户总费用上限。

## 10. 调度、锁和崩溃恢复

nextCycleAt 保存在 Program。scheduler 读取到期项并发 wake，Host Supervisor 再检查状态、额度、授权和未结束 Cycle；原子创建 Cycle 和取得 workspace lease。

同一 Program 最多一个未结束 Cycle（包括 suspended）；同一 workspaceKey 最多一个主动执行者。资源暂停后不释放 workspace 执行占用，保留 owner/epoch，防止另一轮覆盖待恢复工作；桌面退出后由持久化占用和恢复流程接管。重复 wake、Run now 和 ACK 丢失不能创建第二个 Run。manual trigger 用请求 ID，scheduled trigger 用 Program/revision/到期时间生成稳定 key。

执行 ID 在提交前保存：cycleId、executionSessionId、workflowRunId。新增内部 submitOnce 只允许受控调用指定身份；已存在时检查 parent、script hash、args 和 Cycle。不同内容同 ID 拒绝。不预插入 dwf_run，占用其 Engine 创建权。

租约 epoch 必须到达启动、请求准入、工具操作和报告提交。旧 epoch 不可写或扩额。期限默认 90 秒、30 秒续租；失去续租立刻停止新操作。过期先核对已有 owner/attachment，撤销旧许可、确认旧执行停止后才能增加 epoch 接管。无法确认则保持 interrupted，不创建替代 Run。

恢复顺序：

```text
Host启动/恢复数据库
 -> 未结束Cycle
 -> 核对原session/run/owner
 -> 仍活着：重新连接，不重复启动
 -> 已中断且可恢复：同Run resume
 -> 已完成：补导入报告/usage并结算
 -> 不可恢复：记录失败和证据
 -> 最后才处理到期Program
```

Cycle 存在但 Run 不存在：核对原执行身份未被接受后 submitOnce。ACK 丢失：查询原身份，不新生成 ID。Run completed 而 Cycle 未结束：继续 settling，不 resume。stopped(interrupted/provider) 只有原快照、原工作区和有限恢复条件成立才 resume；恢复次数达到上限则暂停并询问，不自动结束任务。errored/completed/superseded 不冒充可恢复。

节点外部副作用与 journal 不同事务：恢复前核对实际 diff/检查点。可能重复的修改不得无条件重放。无法证实安全时结束旧 Cycle，后续新轮重新观察，不强行 resume。

定时错过多轮只唤醒一次，不补跑串行旧任务。Daily 根据时区求下一次未来时点。正常退出撤销许可、取消并保存 interrupted；强制退出依赖恢复。关闭所有窗口导致 Host 不可用时暂停调度，不绕过窗口 Host 另起执行者。

### 10.1 主动探活与一小时规则

Supervisor 每 15 秒主动查询运行健康，每 30 秒执行一次 owner/lease 核对。健康快照至少包含 run/actor/request/tool 身份、最近进展序号和时间、当前操作状态、等待原因、操作 deadline、owner epoch、进程/连接可达性。快照来源是实际执行适配器，不采用模型自述。

有效执行时间默认上限 3,600,000ms，跨恢复累计。用户暂停、桌面退出和已验证的 normal_wait 不计入。normal_wait 时工作流继续等待外部操作并定期探活；不会因墙上时间超过一小时而触发时间暂停。等待结束后恢复有效时间计数，不重置累计值。

分类规则：

| 健康状态       | 所需证据                                                                                               | 行为                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| progressing    | 节点/工具阶段推进、模型流事件、有效输出或其他真实进展                                                  | 累计有效时间；达到一小时暂停并询问                                |
| normal_wait    | 具体等待的请求/工具/子任务仍有 owner，等待原因明确，未超过该操作期限，或适配器提供可核对的继续等待证据 | 等待时不累计一小时额度；继续执行和主动探活                        |
| suspected_hang | 连续 180 秒无可证实进展，且没有正常等待证据；连续 3 次主动探测仍不能证实健康                           | 保存诊断、撤销新操作、挂起并询问；不直接让 Cycle failed/cancelled |
| unreachable    | Host/CLI 不可达或无法核对 owner                                                                        | 冻结新操作，按 owner/重连恢复规则处理；不能把断连误当正常等待     |

仅有进程存活、定时 heartbeat、pending 标签或反复重复同一输出，都不足以证明 normal_wait。长命令必须有声明的操作期限或持续可验证的阶段证据；到期无进展不能永久豁免。确认正常等待的区间持久化，restart 不重算为运行时长。探活只读取状态，不调用模型，因此不为了判断 hang 消耗额外 tokens。

某个 actor 正常等待时不妨碍其他 actor 继续；只要其他 actor 仍工作，该时间仍算有效时间。只有整轮当前可执行工作全部处于已证实的正常等待，才暂停有效计时。达到时间边界时先做健康分类：normal_wait 推迟触发；无可执行等待理由的健康工作达到上限则请求用户继续。

同一时间多个探测、费用和 token 上限触发时合并一条继续确认。资源限制优先阻止新请求，即使当前 normal_wait，也不能借时间豁免绕过费用或 token 限额。

## 11. Integration 接口与报告

以下接口为新增要求，最终类型必须包括 schema 和结构化错误：

```ts
interface ContinuousExecutionPort {
  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference>;
  inspect(ref: ExecutionReference): Promise<ExecutionState>;
  resume(ref: ExecutionReference, epoch: number): Promise<void>;
  stop(ref: ExecutionReference, reason: string): Promise<void>;
  waitForQuiescence(ref: ExecutionReference): Promise<void>;
  readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch>;
}
```

新增 managed launch 不改变用户普通 Workflow 的确认规则。首次 Program 授权绑定 revision、模板 hash、Scope、预算和交付限制。实际 actor 工作目录必须是 executionPath。

保持不变：compiler、analysis、schema synthesis、lowering、Engine、AskScheduler、VM sandbox、原 DWF 表、普通 Workflow escalation、权限 mode 枚举。

最小扩展：Run service 的受控 submitOnce、停止检查、按序报告读取、create-app 装配、协议 handler。工具、模型和 escalation 使用专用注入适配器；需要普通 driver 增加接缝时，只做无默认行为变化的可选接口。

报告使用现有 report/artifact，新增版本化 `ContinuousReportV1`：candidate、decision、validation、candidate_result、cycle_result。每项 itemKey 加来源 journal sequence 去重，schema 校验后事务导入。Run 失败也导入已保存报告；不能只依赖模型最后一段总结。

当前 report 有数量/大小限制。图片和长输出为 artifact/受控引用；MVP 不添加无限日志到报告。malformed report 记录拒绝事件，不能据此 done 或提交。

专用执行接口新增 suspendAtSafeBoundary、resumeSuspended、inspectHealth，明确不等同 stop；挂起请求/工具准入与旧执行确认是同一所有者链。单轮计时不使用会直接 abort Run 的固定墙钟 timeout。

结构化错误至少包括：authorization_stale、scope_denied、budget_denied、usage_unknown、lease_lost、execution_not_quiescent、execution_identity_mismatch、template_mismatch、remote_execution_not_supported、validation_unavailable。

## 12. UI 与可观测性

现有 Automations 页面增加 `Automations | Workflows | Continuous`。继续沿用 WorkspaceMainView 的 automations 入口，不向 build/edit/yolo 添加 continuous。

Program 详情必须包含：Status、Goal、Scope、Budget、Cadence、Health/最近进展、继续确认、Current Cycle、Latest Cycles、Improvement Queue、Decision Queue、Run now、Pause、立即停止本轮、分支/提交交付位置。

费用明确标“估算”；unknown 另列。默认并发10、tokens10亿、单轮USD100、每日USD1,000、有效执行1小时；界面同时显示实际运行平台并发能力，不能隐藏较低的机器限制。显示最近探活、最近进展、正常等待原因与有效/墙钟时间。资源暂停显示待确认额度/时间，不混入产品Decision队列。Decision 数量与执行状态分开。历史能从 resolution 追到候选、实施 Cycle、Run、commit 和验证证据。Run timeline/graph 复用现有侧栏，不能用工具调用次数代替改进数。

桌面与手机按服务 snapshot 展示；局部草稿和 optimistic overlay 不是业务事实。手机重连按 replayable 语义补状态，不能重复发已接受命令。

每个 Cycle 有稳定 traceId；各 actor/session/request/tool/span 继承关联。日志使用现有 UI logger/service logger，不记录凭据、真实私密数据、内部服务地址。debug 高频记录；info 生命周期；warn 可恢复问题；error 不可恢复问题。

## 13. 实施顺序和发布条件

实施按 ticket CT-00 至 CT-10 顺序，详细范围见任务文档。先更新 spec/contract，再补行为测试，再实现；交互必须 E2E。不在当前文档阶段创建 migration、runner 或源代码。

功能默认关闭，最后完成端到端恢复和操作限制才开启。跨平台没有可验证的写入/命令限制时，该平台只提供观察，不开放自动实施；这是固定能力规则，不是待决策产品选项。

关闭功能不删除表、worktree或历史。回滚先停止唤醒、撤销写入和新模型请求、等待停止，再回退代码；不删除用户提交或原始工作区。

源码 seed graph 暂不添加指向不存在实现的节点。实现新增 source 后，CT-00/后续集成任务按技能要求补 graph 并验证路径/符号。

## 14. 当前验证状态

此前只读调研：freshness 通过；lint 0 errors/70 warnings；typecheck --dry 只检查构建计划，不是类型通过。本次文档阶段不执行功能测试，不把计划标为通过。没有 Continuous 实现，E2E 状态均为 planned。

验收完整清单、测试命令、故障注入和证据格式在 [测试文档](../testing/continuous.md)。所有第一版产品边界已由 D1-D4 和本文规则确定，无待定产品项。
