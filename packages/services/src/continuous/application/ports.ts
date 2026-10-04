// Continuous app 层端口：ContinuousService（CT-01 起的唯一业务写入者）只依赖这些接口，
// IO/进程/存储由 adapters 实现并在 Host 注入。业务规则不得绕过端口直接触碰存储或执行器。
// 端口签名锁定规格 §7/§9/§10/§11；实现 ticket：CT-01(Repository)、CT-02(WorkspacePreparation)、
// CT-03(Execution)、CT-04(RequestAdmission/Clock 扩展)。

import type { Candidate, Cycle, Decision, Program } from "../domain/types.js";

// ── Repository：长期状态持久化（tasks-index 新表，独立于 DWF journal）──
export interface ContinuousRepositoryPort {
  insertProgram(program: Program): Promise<void>;
  getProgram(programId: string): Promise<Program | null>;
  /** 全量替换保存；并发写由 Program.revision 乐观校验拒绝（CT-01 落地）。 */
  saveProgram(program: Program): Promise<void>;
  listPrograms(workspaceKey: string): Promise<Program[]>;
  insertCycle(cycle: Cycle): Promise<void>;
  saveCycle(cycle: Cycle): Promise<void>;
  /** 同一 Program 最多一个未结束 Cycle（部分唯一索引保证，不靠内存 mutex）。 */
  getOpenCycle(programId: string): Promise<Cycle | null>;
  saveCandidate(candidate: Candidate): Promise<void>;
  listQueueableCandidates(programId: string): Promise<Candidate[]>;
  saveDecision(decision: Decision): Promise<void>;
  listPendingDecisions(programId: string): Promise<Decision[]>;
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

export interface WorkspacePreparationPort {
  prepare(request: WorkspacePreparationRequest): Promise<WorkspacePreparationResult>;
  /** 只释放本功能自己的 worktree 管理；保留分支与提交，不清理用户 worktree。 */
  release(programId: string): Promise<void>;
}

// ── Clock：可注入时间（测试用可控时钟；生产为系统时钟）──
export interface ContinuousClockPort {
  now(): number;
  /** 创建 Program 时读取系统 IANA 时区并持久化；后续以 Program 时区为准。 */
  timeZone(): string;
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
