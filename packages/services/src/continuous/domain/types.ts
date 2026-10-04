// Continuous 领域类型：Program/Cycle/Candidate/Decision/Budget/Scope（规格 §5-§8）。
// 本文件保持纯类型与纯函数：不做 IO、不 await 外部世界、不依赖 Runtime 实现。
// 状态词表与配置策略的唯一 schema 来源是 @zcode/shared 的 continuous-protocol；
// 这里推导领域类型，保证 wire 校验与领域模型不漂移。

import type {
  ContinuousBudgetPolicy,
  ContinuousCadencePolicy,
  ContinuousCandidateStatus,
  ContinuousCycleHealthState,
  ContinuousCycleStatus,
  ContinuousDecisionPolicy,
  ContinuousDecisionStatus,
  ContinuousProgramStatus,
  ContinuousScopePolicy,
} from "@zcode/shared";
// 值导入：isOpenCycleStatus 需要在运行时读取共享词表，不复制第二份状态集合。
import { CONTINUOUS_OPEN_CYCLE_STATUSES } from "@zcode/shared";

export type {
  ContinuousBudgetPolicy,
  ContinuousCadencePolicy,
  ContinuousCandidateStatus,
  ContinuousCycleHealthState,
  ContinuousCycleStatus,
  ContinuousDecisionPolicy,
  ContinuousDecisionStatus,
  ContinuousProgramStatus,
  ContinuousScopePolicy,
} from "@zcode/shared";

/** 未结束 Cycle 状态集合（含 suspended）；同一 Program 最多一个。 */
export type OpenCycleStatus = (typeof CONTINUOUS_OPEN_CYCLE_STATUSES)[number];

export interface ProgramAuthorization {
  revision: number;
  templateHash: string;
  grantedAt: string;
}

export interface Program {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  revision: number;
  goal: string;
  scope: ContinuousScopePolicy;
  budget: ContinuousBudgetPolicy;
  cadence: ContinuousCadencePolicy;
  decisionPolicy: ContinuousDecisionPolicy;
  authorization: ProgramAuthorization;
  templateId: string;
  templateVersion: string;
  templateHash: string;
  /** Program worktree（executionPath）；workspacePath 永远指原始仓库，两者不可混用。 */
  executionPath?: string;
  branchName?: string;
  status: ContinuousProgramStatus;
  statusReason?: string;
  nextCycleAt?: number;
  lastCycleAt?: number;
  consecutiveFailures: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type CycleTriggerKind = "manual" | "interval" | "daily" | "decision_resolved";

export interface CycleTrigger {
  kind: CycleTriggerKind;
}

export type CycleOutcome = "changes_verified" | "no_changes" | "partial";

export interface CycleResult {
  outcome: CycleOutcome;
  changedFiles: string[];
  commits: string[];
  evidence: unknown[];
  summary: string;
}

export type CycleHealthState = ContinuousCycleHealthState;

export interface Cycle {
  id: string;
  programId: string;
  sequence: number;
  triggerKey: string;
  trigger: CycleTrigger;
  status: ContinuousCycleStatus;
  /** 创建时的完整配置快照（Goal/Scope/Budget/Cadence/模板与模型配置）。 */
  configurationSnapshot: unknown;
  scriptText: string;
  scriptHash: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
  leaseEpoch: number;
  resumeAttempts: number;
  /** 有效执行时间（已确认正常等待、用户暂停、离线不计入）。 */
  activeDurationMs: number;
  normalBlockedDurationMs: number;
  lastProgressAt?: number;
  lastProbeAt?: number;
  healthState: CycleHealthState;
  pendingContinuationRequestId?: string;
  reportCursor: number;
  baseCommit?: string;
  result?: CycleResult;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type CandidateRisk = "low" | "medium" | "high";

export interface Candidate {
  id: string;
  programId: string;
  sourceCycleId: string;
  /** 重复发现的去重键；UNIQUE(program_id, fingerprint)。 */
  fingerprint: string;
  title: string;
  rationale: string;
  targetPaths: string[];
  impact: number;
  confidence: number;
  effort: number;
  risk: CandidateRisk;
  status: ContinuousCandidateStatus;
  executionCycleId?: string;
  evidence: unknown[];
}

export interface DecisionOption {
  id: string;
  label: string;
  consequences: string;
}

export interface DecisionBlockingScope {
  candidateIds: string[];
  paths: string[];
  capability?: string;
}

export interface DecisionResolution {
  optionId?: string;
  text?: string;
  resolvedAt: number;
}

export interface Decision {
  id: string;
  programId: string;
  sourceCycleId: string;
  fingerprint: string;
  /** optimistic concurrency：resolve/dismiss 携带 version，旧 version 拒绝。 */
  version: number;
  title: string;
  context: string;
  options: DecisionOption[];
  recommendation?: string;
  classification: "deferred" | "blocking";
  /** 必须明确 candidate/path/capability，不默认覆盖整个 UI 包。 */
  blockingScope?: DecisionBlockingScope;
  status: ContinuousDecisionStatus;
  resolution?: DecisionResolution;
}

/** 资源上限/运行健康的用户继续确认（规格 §5/§6.1；与产品 Decision Queue 分开）。 */
export type ContinuationRequestReason =
  | "cost_limit"
  | "token_limit"
  | "time_limit"
  | "change_limit"
  | "retry_limit"
  | "resume_limit"
  | "suspected_hang"
  | "health_unknown";

export interface ContinuationRequest {
  id: string;
  programId: string;
  cycleId: string;
  reason: ContinuationRequestReason;
  limitKind: "cost" | "token" | "time" | "change" | "retry" | "resume" | "health";
  observedUsage: unknown;
  currentLimit: unknown;
  recommendedExtension: unknown;
  version: number;
  status: "pending" | "resolved";
  resolution?: unknown;
  createdAt: number;
  resolvedAt?: number;
}

/** workspace 执行占用（continuous_workspace_lease）；释放后 epoch 保留、cycle/owner/expiry 同空。 */
export interface WorkspaceLease {
  workspaceKey: string;
  cycleId?: string;
  ownerId?: string;
  epoch: number;
  expiresAt?: number;
  updatedAt: number;
}

/** 审计事件（continuous_event）；event_key 幂等去重。 */
export interface ContinuousEvent {
  id?: number;
  programId: string;
  cycleId?: string;
  eventKey: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

// ── 纯领域规则（无 IO；U-02 锁定）──

export function isOpenCycleStatus(status: ContinuousCycleStatus): status is OpenCycleStatus {
  return (CONTINUOUS_OPEN_CYCLE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalCycleStatus(status: ContinuousCycleStatus): boolean {
  return !isOpenCycleStatus(status);
}

/** 需要撤销旧授权并重新确认的配置变更（§6）；单纯预算增减/cadence 修改不扩大 Scope。 */
export type ContinuousConfigChangeKind =
  | "goal"
  | "scope"
  | "template"
  | "model"
  | "budget"
  | "cadence";

export function requiresProgramReauthorization(change: ContinuousConfigChangeKind): boolean {
  return change === "goal" || change === "scope" || change === "template" || change === "model";
}

/** 命令携带的授权 revision 落后于 Program 当前 revision 时必须拒绝（authorization_stale）。 */
export function isAuthorizationStale(
  program: Pick<Program, "authorization">,
  usedRevision: number,
): boolean {
  return usedRevision !== program.authorization.revision;
}

/**
 * pending Decision 不改变 Program 状态、不默认阻止当前 Cycle（§6/§8）：
 * Decision 只通过 blockingScope 局部过滤候选，Program 永不因 Decision 暂停。
 * 该函数恒返回 false 是锁定规则，不是待实现分支。
 */
export function decisionBlocksProgram(
  decision: Pick<Decision, "status" | "classification" | "blockingScope">,
): boolean {
  void decision;
  return false;
}
