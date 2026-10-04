/**
 * continuous 模块公开契约：Continuous 长期自主改进的 service 接口、命令与结构化错误。
 * 只允许从这里 import；domain/application/adapters 细节都在模块内部。
 * CT-00 仅锁定契约（不装配实现）：Host 组装与持久化从 CT-01 起，功能默认关闭。
 * 规则来源：docs/specs/continuous.md；命令 wire schema 在 @zcode/shared continuous-protocol。
 */

import type { Candidate, Cycle, Decision, Program } from "./domain/types.js";
import type {
  ContinuousArchiveProgramParams,
  ContinuousCapabilityResult,
  ContinuousCommandContext,
  ContinuousCreateProgramParams,
  ContinuousDismissDecisionParams,
  ContinuousPauseProgramParams,
  ContinuousResolveDecisionParams,
  ContinuousResumeProgramParams,
  ContinuousRunNowParams,
  ContinuousSnapshotResult,
  ContinuousStopCurrentCycleParams,
} from "@zcode/shared";

export type {
  ContinuousArchiveProgramParams,
  ContinuousCapabilityResult,
  ContinuousCommandContext,
  ContinuousCreateProgramParams,
  ContinuousDismissDecisionParams,
  ContinuousError,
  ContinuousErrorCode,
  ContinuousPauseProgramParams,
  ContinuousResolveDecisionParams,
  ContinuousResumeProgramParams,
  ContinuousRunNowParams,
  ContinuousSnapshotResult,
  ContinuousStopCurrentCycleParams,
} from "@zcode/shared";
export {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
  CONTINUOUS_ERROR_CODES,
  CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
  CONTINUOUS_METHODS,
  continuousErrorSchema,
  isContinuousError,
  supportsManagedCycles,
} from "@zcode/shared";

export type {
  Candidate,
  ContinuationGrant,
  ContinuationRequest,
  ContinuationRequestReason,
  ContinuationRequestResolution,
  Cycle,
  CycleHealthState,
  CycleOutcome,
  CycleResult,
  CycleTrigger,
  CycleTriggerKind,
  Decision,
  DecisionBlockingScope,
  DecisionOption,
  DecisionResolution,
  Program,
  ProgramAuthorization,
  WorkspaceLease,
} from "./domain/types.js";
export {
  decisionBlocksProgram,
  isAuthorizationStale,
  isOpenCycleStatus,
  isTerminalCycleStatus,
  requiresProgramReauthorization,
} from "./domain/types.js";
export type {
  BudgetAdmissionDenialLimit,
  BudgetAdmissionLimits,
  DayWindow,
  UsageLedgerSummary,
} from "./domain/budgetPolicy.js";
export { dayWindowFor, mergeContinuationGrants } from "./domain/budgetPolicy.js";
export type {
  AdmissionRequest,
  AdmissionTicket,
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ContinuousReportItem,
  ExecutionReference,
  ExecutionState,
  HealthSnapshot,
  ManagedCycleInput,
  ReportBatch,
  RequestAdmissionPort,
  UsageSettlement,
  WorkspacePreparationPort,
  WorkspacePreparationRequest,
  WorkspacePreparationResult,
} from "./application/ports.js";
// CT-04 应用服务（Host 组装进 supervisor，CT-05）：预算准入/继续确认/健康监控。
// 预算账本唯一写入路径 = ContinuousBudgetAdmission → repository（CLI 侧只经端口转发）。
export type {
  ContinuationAnswer,
  ContinuousContinuationServiceDeps,
  OpenContinuationInput,
} from "./application/continuationService.js";
export { ContinuousContinuationService } from "./application/continuationService.js";
export type { ContinuousBudgetAdmissionDeps } from "./application/budgetAdmission.js";
export { ContinuousBudgetAdmission } from "./application/budgetAdmission.js";
export type {
  ContinuousHealthClassification,
  ContinuousHealthMonitorDeps,
  HealthAssessment,
} from "./application/healthMonitor.js";
export {
  ContinuousHealthMonitor,
  CONTINUOUS_HANG_PROBE_CONFIRMATIONS,
  CONTINUOUS_HANG_THRESHOLD_MS,
  CONTINUOUS_PROBE_INTERVAL_MS,
} from "./application/healthMonitor.js";

/**
 * Continuous 服务接口（Host 持有唯一实例；业务写入唯一路径）。
 * 所有命令先过 capability 检查（supportsManagedCycles），旧 CLI/远程第一版返回
 * 结构化 capability_missing / remote_execution_not_supported，不回退普通 prompt 执行。
 * Pause 与立即停止本轮是两个命令：前者本轮结束后生效，后者撤销写入→取消→等待停止。
 */
export interface IContinuousService {
  /** 声明 managed cycle capability；必须先查询，未支持时不得调用其余命令。 */
  capability(): ContinuousCapabilityResult;
  /** workspace 维度的事实快照；UI 只消费 snapshot，不在本地另建接受队列。 */
  snapshot(context: ContinuousCommandContext): Promise<ContinuousSnapshotResult>;
  /** 初次创建：绑定 Goal/Scope/Budget/Cadence/模板 hash 与首次授权（D4：仅本地 workspace）。 */
  createProgram(params: ContinuousCreateProgramParams): Promise<Program>;
  /** 手动触发一轮；requestId 幂等，重复触发不得创建第二个 Cycle。 */
  runNow(params: ContinuousRunNowParams): Promise<Cycle>;
  /** 本轮结束后暂停；不取消正在执行的候选。 */
  pauseProgram(params: ContinuousPauseProgramParams): Promise<Program>;
  /** 显式恢复（paused/failed）；suspended 资源暂停必须走继续确认，不走本命令。 */
  resumeProgram(params: ContinuousResumeProgramParams): Promise<Program>;
  /** 立即停止本轮：先撤销写入/请求许可，再取消并等待停止；必须携带当前 lease epoch。 */
  stopCurrentCycle(params: ContinuousStopCurrentCycleParams): Promise<Cycle>;
  /** 回答 Decision；version 防覆盖，resolution 只影响未来 Cycle（§8）。 */
  resolveDecision(params: ContinuousResolveDecisionParams): Promise<void>;
  /** 不授权实施；不自动扩大 forbidden 范围。 */
  dismissDecision(params: ContinuousDismissDecisionParams): Promise<void>;
  /** 归档前必须没有主动执行；不级联清除审计历史。 */
  archiveProgram(params: ContinuousArchiveProgramParams): Promise<void>;
}
