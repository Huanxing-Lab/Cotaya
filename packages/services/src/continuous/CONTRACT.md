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
- `ContinuousSupervisor`（CT-05）是 Cycle 执行编排与结算的唯一写者：Run now 全链路
  （授权核对 → worktree 准备 → Cycle 快照（脚本 bytes/hash）→ submitOnce → 报告增量导入
  → settling（Run 失败也导入已保存报告）→ 选择复核 → 终态 Cycle 与 nextCycleAt 同事务）。
  每个 Cycle 实例内至多一条监督循环；重放的 Run now 复用同一 completion，不重复结算。
- `ContinuousReportIngestion`（CT-05）是报告进队列的唯一入口：V1 schema 校验后单事务导入
  （队列/关联/事件/cursor 同事务，I-03 语义）；malformed 条目记 `report.rejected` 事件、
  不丢批次内其余条目；`candidate_result` 的 done 只有在 tests/browser/review 三阶段
  validation 事实（本批 + 已导入事件）全 passed 时才被采信——模型自述不能覆盖验证事实。
  候选/决策行 id 由 fingerprint 确定派生（UNIQUE(program_id,fingerprint) 的稳定主键）。
- `ContinuousDecisionService`（CT-06）是 Decision 回答与执行中决策持久化的唯一写入者：
  resolve/dismiss 按 version 乐观校验（同 version 同答案重放幂等 no-op、旧 version/异答
  version_conflict）；resolution 与入队事件（decision.resolved/dismissed、
  decision.candidates_requeued）经 `applyDecisionResolution` 单事务落库；dismiss 的关联
  未终态候选同事务 rejected（不授权实施，重复上报不重开）；resolve 不改当前执行计划——
  关联候选在未来 Cycle 的选择期按现仓库、Scope、预算重新核对。
- 决策行的重复发现按 fingerprint 合并（`mergeDecisionOnRediscovery`）：首见身份与
  resolution/version 稳定、来源（sources）按 cycleId 去重追加、blockingScope 取并集且
  仍然局部；终态不重开。候选行终态（done/rejected）不被重复上报重置。
- 分类是**双检查**（`evaluateCandidateClassification`）：操作能力（forbidden/allowed 路径）
  独立于模型标签先行裁决；模型分类不是授权，未知类别默认进入决策（unknownToDecision
  锁定），决策回答不扩大 allowed/forbidden（Scope 变更需重新授权）。
- 局部阻塞谓词唯一实现是 `decisionBlocksCandidate`（candidatePolicy 选择期过滤复用）：
  candidateIds/paths 命中才阻塞，capability 不单独阻塞，空 scope 阻塞零候选——
  pending Decision 从不暂停 Program（`decisionBlocksProgram` 恒 false）。
- workspace lease 的裁决唯一入口是 `application/workspaceLease`（CT-07）：epoch 单调（正常
  释放保留 epoch、cycle/owner/expiry 同空）；同 Cycle 同 owner 重入只续租不抬 epoch；
  过期不直接接管——先核对旧 owner/attachment（旧执行者仍可达且 Run 未终态 → 拒绝，不启动
  第二写入者），撤销旧许可并确认停止后才允许 epoch+1 接管；旧 epoch 的副作用一律
  `lease_lost` 拒绝（`requireLeaseEpoch` 守卫）。expires_at 是续租期限，不是进程死亡证明；
  suspended Cycle 保留占用（不释放），防止另一轮覆盖待恢复工作。
- 周期唤醒链路只转发不派发（CT-07）：scheduler 进程经 `ContinuousWakeSource` 只读到期查询
  （本模块 adapters 层，不写任何表、不保存派发状态），wake 经 main 按身份转发给窗口
  Host；`ContinuousRecoveryService.handleWake` 先核对未结束 Cycle 再处理到期——重复 wake
  由 trigger key UNIQUE（`scheduledTriggerKey` = Program/revision/到期时间）与「一个
  Program 一条未结束 Cycle」约束幂等吸收；错过多轮只唤醒一次（结算后 nextCycleAt 取下一个
  未来时点，不排队补跑）。恢复顺序（§10）由 `ContinuousRecoveryService` 唯一编排：先全部
  未结束 Cycle（活着重连/中断同 Run 有限 resume/completed 只结算/不可恢复保存证据/
  suspended 保持），最后到期 Program；临时失败按 30s/120s 退避，超限暂停询问
  （resume_limit 继续确认），用户取消（stopReason=user）不自动恢复。
- 控制面语义（`application/supervisorControl`，CT-07）：Pause（本轮结束后）与立即停止
  （撤销→取消→等待停止→cancelled+paused，必须携带当前 lease epoch）是两个命令；
  正常退出保存 interrupted（挂起而非 stop——stop 的 revoked 语义会封死 resume）；
  Goal/Scope/模板变更 revision+1 并结算当前轮为 paused（旧授权立即失效），单纯预算/cadence
  修改不递增授权 revision、cadence 只影响未来轮。
- 本模块不得导入 AgentRuntime 或 CLI 具体实现；执行经 `application/ports.ts`
  的注入端口（adapters 由 CLI bootstrap 侧实现）；固定模板（bootstrap
  `continuous-templates`）经 Host 注入的 `ContinuousTemplateSource` 进入，模板 hash 与
  Program 授权绑定不符时 `template_mismatch` 明确失败，不静默换脚本。
