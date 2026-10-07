/**
 * continuous 模块公开契约：Continuous 长期自主改进的 service 接口、命令与结构化错误。
 * 只允许从这里 import；domain/application/adapters 细节都在模块内部。
 * CT-00 仅锁定契约（不装配实现）：Host 组装与持久化从 CT-01 起，功能默认关闭。
 * 规则来源：docs/specs/continuous.md；命令 wire schema 在 @zcode/shared continuous-protocol。
 */

import type { Candidate, Cycle, Decision, Program } from "./domain/types.js";
import type { IContinuousQueryService } from "./contract-interfaces.js";
import type {
  ContinuousArchiveProgramParams,
  ContinuousCapabilityResult,
  ContinuousCreateProgramParams,
  ContinuousDismissDecisionParams,
  ContinuousPauseProgramParams,
  ContinuousResolveContinuationParams,
  ContinuousResolveContinuationResult,
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
  ContinuousProgramDetailParams,
  ContinuousProgramDetailResult,
  ContinuousResolveContinuationParams,
  ContinuousResolveContinuationResult,
  ContinuousResolveDecisionParams,
  ContinuousResumeProgramParams,
  ContinuousRunNowParams,
  ContinuousSnapshotResult,
  ContinuousStopCurrentCycleParams,
  ContinuousTemplatesParams,
  ContinuousTemplatesResult,
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
  DecisionSourceRecord,
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
// CT-05：手动完整 Cycle 的编排与报告导入。supervisor 是 Cycle 执行编排/结算的唯一写者
// （预算账本与健康字段的所有者仍是 CT-04 的两个服务）；reportIngestion 是报告进队列的
// 唯一入口（schema 校验 → 单事务导入 → done 三阶段验证门）。
export type {
  ContinuousSupervisorDeps,
  ContinuousTemplateSource,
  RunNowResult,
} from "./application/supervisor.js";
export { ContinuousSupervisor, ContinuousSupervisorError } from "./application/supervisor.js";
export type { SupervisedCycleOutcome } from "./application/supervisorLifecycle.js";
export { nextCycleAtFor } from "./domain/cadencePolicy.js";
export type {
  IngestedCandidateResult,
  ReportBatchInput,
  ReportIngestionDeps,
  ReportIngestionOutcome,
  ReportRejection,
} from "./application/reportIngestion.js";
export { ContinuousReportIngestion } from "./application/reportIngestion.js";
export type {
  BlockingDecision,
  CandidateDeferralEntry,
  CandidateExclusionReason,
  CandidateSelection,
  CandidateSelectionEntry,
  CandidateSelectionInput,
  SelectableCandidate,
} from "./domain/candidatePolicy.js";
export { candidateScore, selectCandidates } from "./domain/candidatePolicy.js";
// CT-06：Decision Queue 的纯规则与应用服务。decisionService 是 resolve/dismiss 与执行中
// 决策持久化的唯一写入者（resolution 与入队事件同事务；Dismiss 不授权实施）；decisionPolicy
// 是分类双检查/局部阻塞/合并/version 裁决的单一实现（candidatePolicy 复用其阻塞谓词）。
export type {
  BlockableCandidate,
  CandidateClassificationAction,
  ContinuousModelClassification,
  DecisionResolutionInput,
  DecisionResolutionPlan,
} from "./domain/decisionPolicy.js";
export {
  CONTINUOUS_MODEL_CLASSIFICATIONS,
  decisionBlocksCandidate,
  evaluateCandidateClassification,
  mergeDecisionOnRediscovery,
  planDecisionResolution,
} from "./domain/decisionPolicy.js";
export { continuousDecisionRowId } from "./application/continuousIds.js";
export type {
  ContinuousDecisionServiceDeps,
  DecisionAnswerResult,
  EscalationDecisionInput,
} from "./application/decisionService.js";
export {
  ContinuousDecisionService,
  DecisionVersionConflictError,
} from "./application/decisionService.js";
// CT-07：周期、执行权与恢复。cadencePolicy 是 trigger key/到期判定/退避曲线的单一实现；
// workspaceLease 是 lease 裁决唯一入口（epoch 单调、过期先核对旧 owner、旧 epoch 副作用拒绝）；
// recovery 是重启核对与到期启动的编排（先未结束 Cycle 后到期、同 Run 有限恢复、退避超限询问）；
// supervisorControl 是控制面（暂停/立即停止/继续/退出保存 interrupted/配置变更授权处理）。
export {
  CONTINUOUS_RECOVERY_BACKOFF_MS,
  isProgramDue,
  manualTriggerKey,
  recoveryBackoffMs,
  scheduledTriggerKey,
} from "./domain/cadencePolicy.js";
export {
  CONTINUOUS_LEASE_RENEW_INTERVAL_MS,
  CONTINUOUS_LEASE_TERM_MS,
  ContinuousLeaseLostError,
  acquireCycleLease,
  releaseCycleLease,
  renewCycleLease,
  requireLeaseEpoch,
} from "./application/workspaceLease.js";
export type { LeaseAcquireResult, WorkspaceLeaseDeps } from "./application/workspaceLease.js";
export type { CycleControlDeps, ProgramConfigPatch } from "./application/supervisorControl.js";
export {
  changeProgramConfig,
  continueSuspendedCycle,
  interruptCyclesForShutdown,
  pauseProgram,
  resumeProgram,
  stopCurrentCycle,
} from "./application/supervisorControl.js";
export type {
  ContinuousRecoveryDeps,
  RecoveryAction,
  RecoveryReport,
} from "./application/recovery.js";
export { ContinuousRecoveryService } from "./application/recovery.js";
// 到期唤醒的只读查询面（桌面 scheduler 经 @zcode/services/node 消费；只查询不派发）。
export type { ContinuousDueProgram } from "./adapters/continuousWakeSource.js";
export { ContinuousWakeSource } from "./adapters/continuousWakeSource.js";
// CT-08：IContinuousService 命令面的唯一实现（Host 装配后经 ServiceChannels.Continuous 暴露）。
// 只做归属校验、错误映射与视图投影；业务判定全部沿用 CT-01…07 的服务栈。
// continuousViews 是 domain 行 → wire 读面的纯投影（无 IO、无业务规则）；
// continuousCommandErrors 是命令层结构化错误的单一映射。
export type { ContinuousCommandServiceDeps } from "./application/continuousCommandService.js";
export { ContinuousCommandService } from "./application/continuousCommandService.js";
// 关闭态 stub（一期未决 4 修复）：Host 未开启 Continuous 时注册到同一 channel，capability
// 立即回答 supported:false、其余命令 fail closed——取代「channel 未注册」的沉默关闭位。
export { ContinuousDisabledService } from "./application/continuousDisabledService.js";
export { ContinuousCommandError } from "./application/continuousCommandErrors.js";
export { CONTINUOUS_DETAIL_RECENT_CYCLES } from "./application/continuousViews.js";
// CT-12：Host 装配（ServiceChannels.Continuous + wake handler + CLI→Host 请求处理）。
// assembleContinuousHost 只做构造与接线：repository/预算准入/继续确认/supervisor/recovery
// 全部是既有服务；wire 执行端口经注入的 ContinuousAgentTransport 发 v4 命令（services 不
// import zcode-agent 实现——分层边界），模板来源是 shared 的版本化注册表。
export type {
  AssembledContinuousHost,
  AssembleContinuousHostDeps,
} from "./adapters/hostAssembly.js";
export { assembleContinuousHost } from "./adapters/hostAssembly.js";
export type {
  ContinuousAgentTransport,
  ContinuousAgentCommandAck,
} from "./application/agentTransport.js";
export { CONTINUOUS_AGENT_CAPABILITY_FAULT } from "./application/agentTransport.js";
export type {
  ContinuousAgentRequestHandlerDeps,
  ContinuousAgentRequestOutcome,
} from "./application/agentRequests.js";
export { handleContinuousAgentRequest } from "./application/agentRequests.js";
export type { WireExecutionPortDeps } from "./adapters/wireExecutionPort.js";
export {
  createWireContinuousExecutionPort,
  type WireContinuousExecutionPort,
} from "./adapters/wireExecutionPort.js";
export {
  buildManagedRunRegistration,
  ContinuousRegistrationPayloadError,
} from "./application/registrationPayload.js";

// ── CT-08：接口本体与 RPC 描述符在 contract-interfaces.ts（叶子文件，避免 contract ↔
// 实现的 import 环；命令面 10+1 方法与查询面 2 方法分接口是 max-public-methods 拆分）。
// 对外仍只暴露 contract.ts（模块 publicEntrypoints 不变）。
export { IContinuousService } from "./contract-interfaces.js";
export type { IContinuousQueryService, IContinuousServiceFacade } from "./contract-interfaces.js";
