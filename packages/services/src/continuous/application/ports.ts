// Continuous app 层端口：ContinuousService（CT-01 起的唯一业务写入者）只依赖这些接口，
// IO/进程/存储由 adapters 实现并在 Host 注入。业务规则不得绕过端口直接触碰存储或执行器。
// 端口签名锁定规格 §7/§9/§10/§11；实现 ticket：CT-01(Repository)、CT-02(WorkspacePreparation)、
// CT-03(Execution)、CT-04(RequestAdmission/Clock 扩展)。

import type {
  Candidate,
  ContinuationGrant,
  ContinuationRequest,
  ContinuousEvent,
  Cycle,
  Decision,
  Program,
  ProgramCompletionPatch,
  ReportImportInput,
  UsageRecord,
  UsageSettlementPatch,
  WorkspaceLease,
} from "../domain/types.js";
import type {
  BudgetAdmissionDenialLimit,
  BudgetAdmissionLimits,
  UsageLedgerSummary,
} from "../domain/budgetPolicy.js";

// ── Repository：长期状态持久化（tasks-index 新表，独立于 DWF journal）──
export interface ContinuousRepositoryPort {
  insertProgram(program: Program): Promise<void>;
  getProgram(programId: string): Promise<Program | null>;
  /** 全量替换保存；并发写由 Program.revision 乐观校验拒绝（CT-01 落地）。 */
  saveProgram(program: Program): Promise<void>;
  listPrograms(workspaceKey: string): Promise<Program[]>;
  insertCycle(cycle: Cycle): Promise<void>;
  saveCycle(cycle: Cycle): Promise<void>;
  getCycle(cycleId: string): Promise<Cycle | null>;
  /** 同一 Program 最多一个未结束 Cycle（部分唯一索引保证，不靠内存 mutex）。 */
  getOpenCycle(programId: string): Promise<Cycle | null>;
  /** 生成下一个 sequence 用；配合 UNIQUE(program_id,sequence) 在事务内原子去重。 */
  getLatestCycleSequence(programId: string): Promise<number>;
  saveCandidate(candidate: Candidate): Promise<void>;
  listQueueableCandidates(programId: string): Promise<Candidate[]>;
  saveDecision(decision: Decision): Promise<void>;
  listPendingDecisions(programId: string): Promise<Decision[]>;
  /** 审计事件；event_key UNIQUE，重复写入被数据库拒绝（导入重放走 applyReportImport）。 */
  appendEvent(event: ContinuousEvent): Promise<void>;
  /**
   * 同 Cycle 的已导入事件（按 id 升序；CT-05）。done 门槛要跨批次复核验证事实——
   * readReports 分页可能把 validation 与 candidate_result 切进两批，cursor 只保证
   * 不重读，不保证同门证据同批到达。
   */
  listCycleEvents(programId: string, cycleId: string, type?: string): Promise<ContinuousEvent[]>;
  /** 报告导入：队列/关联/事件/cursor 同事务提交；中断无半条队列（I-03）。 */
  applyReportImport(input: ReportImportInput): Promise<void>;
  /** 终态 Cycle 与 Program 的 nextCycleAt/失败计数同事务提交（I-03/R-08）。 */
  completeCycle(cycle: Cycle, programPatch: ProgramCompletionPatch): Promise<void>;
  // ── workspace 执行占用（continuous_workspace_lease；epoch 单调，释放保留）──
  getLease(workspaceKey: string): Promise<WorkspaceLease | null>;
  /** epoch 必须大于现存值；首次获取从 1 开始。违反抛 epoch_conflict。 */
  acquireLease(lease: WorkspaceLease): Promise<void>;
  /** 正常释放：cycle/owner/expiry 同步置空，epoch 保留不重置。 */
  releaseLease(workspaceKey: string, updatedAt: number): Promise<void>;
  // ── 使用账本（continuous_usage；CT-04 admission 的存储面）──
  insertUsageRecord(record: UsageRecord): Promise<void>;
  settleUsageRecord(patch: UsageSettlementPatch): Promise<void>;
  /** 按 requestKey 读账本行（幂等结算与 unknown 核对的读面）。 */
  getUsageRecord(requestKey: string): Promise<UsageRecord | null>;
  /** 无 usage 证据的终局：保留 reservation 置 unknown（已终态的行不动，幂等）。 */
  markUsageUnknown(requestKey: string, updatedAt: number): Promise<void>;
  /**
   * 账本汇总（规格 §9 计算式）：已结算按实际值、未结算（reserved/unknown）按预留值。
   * cycleId 缺省 = 整个 Program（日窗口）；windowMs 为 [from, to) 的 occurred_at 过滤。
   */
  summarizeUsage(query: {
    programId: string;
    cycleId?: string;
    windowFromMs?: number;
    windowToMs?: number;
  }): Promise<UsageLedgerSummary>;
  /**
   * 原子准入（I-07/E-33）：事务内汇总 + 领域判定 + INSERT reservation，三者同事务；
   * 拒绝时不落行并返回 denial（不抛异常——拒绝是业务结果不是故障）。
   * limits 由 application 预先算好（预算策略 + 本轮 grant），事务内不再读 Program。
   */
  admitUsageReservation(input: {
    programId: string;
    reservation: UsageRecord;
    limits: BudgetAdmissionLimits;
    window: { fromMs: number; toMs: number };
  }): Promise<
    | { status: "admitted"; record: UsageRecord }
    | {
        status: "denied";
        denial: {
          limitKind: BudgetAdmissionDenialLimit;
          cycleSummary: UsageLedgerSummary;
          dailySummary?: UsageLedgerSummary;
        };
      }
  >;
  // ── 继续确认（continuous_continuation_request；CT-04）──
  insertContinuationRequest(request: ContinuationRequest): Promise<void>;
  getContinuationRequest(requestId: string): Promise<ContinuationRequest | null>;
  /** 同 Cycle 至多一条 pending（部分唯一索引兜底；service 层先做合并）。 */
  getPendingContinuationRequest(cycleId: string): Promise<ContinuationRequest | null>;
  /** 乐观 version 保存：行 version 领先于携带值时抛 version_conflict。 */
  saveContinuationRequest(request: ContinuationRequest): Promise<void>;
  /** 本轮全部已 resolved 的继续 grant（准入的增量来源；不重置消耗量）。 */
  listCycleContinuationGrants(cycleId: string): Promise<ContinuationGrant[]>;
}

// ── Execution：现有 Dynamic Workflow 的受控执行边界（CLI bootstrap adapter 实现）──
/** 提交前持久化的执行身份；同 ID 不同内容必须拒绝（execution_identity_mismatch）。 */
export interface ManagedCycleInput {
  programId: string;
  cycleId: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
  executionPath: string;
  scriptText: string;
  scriptHash: string;
  configurationSnapshot: unknown;
}

export interface ExecutionReference {
  cycleId: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
}

export interface ExecutionState {
  runId: string;
  /** Engine 状态词表；errored/superseded 不得冒充可恢复（规格 §10）。 */
  status: "pending" | "running" | "completed" | "errored" | "stopped";
  stopReason?: string;
  failureCode?: string;
  resumable: boolean;
}

/** 版本化报告条目（ContinuousReportV1 的 item 种类，规格 §11）；itemKey 携带 journal sequence 去重。 */
export interface ContinuousReportItem {
  kind: "candidate" | "decision" | "validation" | "candidate_result" | "cycle_result";
  itemKey: string;
  journalSequence: number;
  payload: unknown;
}

export interface ReportBatch {
  items: ContinuousReportItem[];
  nextCursor: number;
}

/** 主动探活健康快照（§10.1）；来源必须是实际执行适配器，不采用模型自述。 */
export interface HealthSnapshot {
  runId: string;
  actorIds: string[];
  lastProgressAt?: number;
  /** 当前等待的操作及声明的期限；normal_wait 必须有 owner/原因/期限证据。 */
  waitingFor?: { ownerId: string; reason: string; deadlineAt: number };
  ownerEpoch: number;
  reachable: boolean;
}

export interface ContinuousExecutionPort {
  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference>;
  inspect(ref: ExecutionReference): Promise<ExecutionState>;
  resume(ref: ExecutionReference, epoch: number): Promise<void>;
  stop(ref: ExecutionReference, reason: string): Promise<void>;
  waitForQuiescence(ref: ExecutionReference): Promise<void>;
  readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch>;
  /** 资源上限挂起（§6.1/§11）：不等同 stop；不能借 stop 把整轮永久 cancelled。 */
  suspendAtSafeBoundary(ref: ExecutionReference, reason: string): Promise<void>;
  resumeSuspended(ref: ExecutionReference, epoch: number): Promise<void>;
  inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot>;
}

// ── WorkspacePreparation：Program worktree 与交付边界（CT-02）──
export interface WorkspacePreparationRequest {
  programId: string;
  /** 原始仓库路径；只用于身份与展示，实际执行在 executionPath。 */
  workspacePath: string;
  /** 用户明确选择的现有 HEAD；原工作区未提交变更不复制、不覆盖。 */
  baseCommit: string;
  branchName: string;
}

export interface WorkspacePreparationResult {
  executionPath: string;
  branchName: string;
  baseCommit: string;
}

// ── 候选检查点（规格 §7：修改前受控检查点；验证失败只恢复归属明确的本候选文件）──

/** 候选检查点元数据；baseCommit 为建立检查点时 worktree 的 HEAD。 */
export interface CandidateCheckpointMeta {
  programId: string;
  candidateId: string;
  executionPath: string;
  baseCommit: string;
  /** 归属明确的候选授权路径（相对 executionPath 的 repo 相对路径）。 */
  ownedPaths: string[];
  createdAt: number;
}

/** 候选写入归属证据：路径 + 最后一次写入后的 git blob OID（git hash-object 语义）。 */
export interface CandidateWriteFingerprint {
  path: string;
  contentOid: string;
}

export interface CandidateRestoreRequest {
  programId: string;
  candidateId: string;
  /** 候选最后写入指纹；未登记指纹的路径若相对检查点有变化，视为归属不明。 */
  candidateWrites: CandidateWriteFingerprint[];
}

/** 恢复是逐路径决策：归属不明的路径保持原样并返回 refused，不整仓回滚。 */
export interface CandidateRestoreOutcome {
  path: string;
  action: "restored" | "deleted" | "unchanged" | "refused";
  reason?:
    | "externally_modified"
    | "missing_after_write"
    | "symlink_present"
    | "modified_without_attribution";
}

export interface WorkspacePreparationPort {
  prepare(request: WorkspacePreparationRequest): Promise<WorkspacePreparationResult>;
  /** 只释放本功能自己的 worktree 管理；保留分支与提交，不清理用户 worktree。 */
  release(programId: string): Promise<void>;
  /** 候选修改前建立检查点；ownedPaths 必须已通过执行策略的路径检查。 */
  createCandidateCheckpoint(request: {
    programId: string;
    candidateId: string;
    executionPath: string;
    ownedPaths: string[];
  }): Promise<CandidateCheckpointMeta>;
  /** 验证失败时恢复：只动「确认是本候选所写且无人外部修改」的路径（I-04/E-12/E-14）。 */
  restoreCandidateFiles(request: CandidateRestoreRequest): Promise<CandidateRestoreOutcome[]>;
}

// ── Clock：可注入时间（测试用可控时钟；生产为系统时钟）──
export interface ContinuousClockPort {
  now(): number;
  /** 创建 Program 时读取系统 IANA 时区并持久化；后续以 Program 时区为准。 */
  timeZone(): string;
  /** 定时器（CT-04 healthMonitor 的 15 秒探活节拍）；返回取消函数。缺省用真实 setTimeout。 */
  schedule?(callback: () => void, delayMs: number): () => void;
}

// ── RequestAdmission：模型请求准入与幂等结算（§9；ContinuousService 是账本唯一写入者）──
export interface AdmissionRequest {
  programId: string;
  cycleId: string;
  /** 请求尝试身份（request_key UNIQUE）；重试是新 attempt，逐次预留。 */
  requestKey: string;
  provider: string;
  model: string;
  pricingVersion: string;
  reservedCostMicros: number;
  reservedTokens: number;
}

export interface AdmissionTicket {
  requestKey: string;
}

export interface UsageSettlement {
  requestKey: string;
  actualTokens: number;
  estimatedCostMicros: number;
  /** provider usage 原始事实；晚到/重复结算必须幂等，unknown 保留 reservation。 */
  usage: unknown;
}

export interface RequestAdmissionPort {
  /** 原子检查日/单轮额度并持久化 reservation 后才允许调用 provider；拒绝抛 budget_denied。 */
  reserve(request: AdmissionRequest): Promise<AdmissionTicket>;
  settle(settlement: UsageSettlement): Promise<void>;
}
