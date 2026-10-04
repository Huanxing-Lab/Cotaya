# Continuous module contract

Invariants that types cannot express (rules: `docs/specs/continuous.md`):

- `IContinuousService` 是唯一业务写入者；Host 持有一个实例，UI 只经
  `packages/ui/src/hooks` 消费 snapshot/命令，不建第二份接受队列。
- 所有命令前必须查询 capability（`supportsManagedCycles`）；旧 CLI/旧 Host 返回
  结构化 `capability_missing`，远程第一版返回 `remote_execution_not_supported`，
  均不得回退普通 prompt 自主执行，也不得被旧 capability 位误触发。
- `workspacePath` 指原始仓库（身份与展示），`executionPath` 指 Program worktree
  （实际执行 cwd）；身份 key 一律 `workspaceIdentity?.trim() || workspacePath`。
- Pause（本轮结束后）与立即停止本轮（撤销写入→取消→等待停止）是两个命令，
  语义与撤销顺序不同；资源上限挂起（suspend）又与两者不同，不能互相冒充。
- pending Decision 不改变 Program 状态、不默认阻止当前 Cycle；blockingScope 必须
  明确 candidate/path/capability，不默认覆盖整个 UI 包。
- Goal/Scope/模板/模型配置变更需要重新授权（revision+1，撤销旧写入许可）；
  单纯预算增减与 cadence 修改不递增授权 revision、不扩大 Scope。
- 金额一律整数微美元；unknown usage 保留 reservation，不得静默清零。
- 预算账本的唯一写入路径是 `ContinuousBudgetAdmission`（application/budgetAdmission）：
  原子准入（事务内汇总+判定+落库）、幂等结算（同值重放 no-op、不同值冲突）、unknown 显式核销。
  CLI 侧预算闸门（bootstrap continuous-model-budget）只铸造 requestKey 并转发，不保存金额事实。
- 继续确认（`ContinuousContinuationService`）与产品 Decision Queue 分开：同 Cycle 至多一条
  pending（合并多上限触发）；resolve 按 version 乐观校验，grant 是**增量**——不重置已消耗量、
  不铸新 Run、不解除其他限制。
- 健康字段（`activeDurationMs`/`normalBlockedDurationMs`/`lastProgressAt`/`lastProbeAt`/
  `healthState`）的唯一写入者是 `ContinuousHealthMonitor`；离线/重启缺口不计入有效时长，
  suspected_hang 只挂起询问、不直接 failed/cancelled。
- 本模块不得导入 AgentRuntime 或 CLI 具体实现；执行经 `application/ports.ts`
  的注入端口（adapters 由 CLI bootstrap 侧实现）。
