// Continuous 视图投影（CT-08）：domain 行 → wire 读面（ContinuousProgramDetailResult）。
// 纯映射、无 IO、无业务判定——排序/裁剪规则也只做「稳定展示」一种；业务语义（局部阻塞、
// 终态粘性等）不在这里重演。拆出本文件是 continuousCommandService 的 max-lines 约束，
// 不是边界变化。

import type {
  ContinuousCandidateView,
  ContinuousContinuationView,
  ContinuousCycleView,
  ContinuousDecisionView,
  ContinuousProgramDetailResult,
  ContinuousProgramView,
  ContinuousUsageSummary,
} from "@zcode/shared";
import type { Candidate, ContinuationRequest, Cycle, Decision, Program } from "../domain/types.js";
import type { UsageLedgerSummary } from "../domain/budgetPolicy.js";

/** 详情页最近 Cycle 的默认条数（§12 Latest Cycles；E-23 历史审计的最近窗口）。 */
export const CONTINUOUS_DETAIL_RECENT_CYCLES = 10;

export function programViewOf(program: Program): ContinuousProgramView {
  return {
    programId: program.id,
    workspaceKey: program.workspaceKey,
    workspacePath: program.workspacePath,
    ...(program.workspaceIdentity === undefined
      ? {}
      : { workspaceIdentity: program.workspaceIdentity }),
    ...(program.remoteSessionId === undefined ? {} : { remoteSessionId: program.remoteSessionId }),
    revision: program.revision,
    goal: program.goal,
    timeZone: program.timeZone,
    scope: program.scope,
    budget: program.budget,
    cadence: program.cadence,
    decisionPolicy: program.decisionPolicy,
    template: {
      templateId: program.templateId,
      templateVersion: program.templateVersion,
      templateHash: program.templateHash,
    },
    status: program.status,
    ...(program.statusReason === undefined ? {} : { statusReason: program.statusReason }),
    nextCycleAt: program.nextCycleAt ?? null,
    lastCycleAt: program.lastCycleAt ?? null,
    consecutiveFailures: program.consecutiveFailures,
    archivedAt: program.archivedAt ?? null,
    branchName: program.branchName ?? null,
    executionPath: program.executionPath ?? null,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

export function cycleViewOf(cycle: Cycle): ContinuousCycleView {
  return {
    cycleId: cycle.id,
    sequence: cycle.sequence,
    status: cycle.status,
    triggerKind: cycle.trigger.kind,
    healthState: cycle.healthState,
    leaseEpoch: cycle.leaseEpoch,
    resumeAttempts: cycle.resumeAttempts,
    activeDurationMs: cycle.activeDurationMs,
    normalBlockedDurationMs: cycle.normalBlockedDurationMs,
    lastProgressAt: cycle.lastProgressAt ?? null,
    lastProbeAt: cycle.lastProbeAt ?? null,
    pendingContinuationRequestId: cycle.pendingContinuationRequestId ?? null,
    workflowRunId: cycle.workflowRunId,
    executionSessionId: cycle.executionSessionId,
    traceId: cycle.traceId,
    baseCommit: cycle.baseCommit ?? null,
    startedAt: cycle.startedAt ?? null,
    completedAt: cycle.completedAt ?? null,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
    outcome: cycle.result?.outcome ?? null,
    summary: cycle.result?.summary ?? null,
    changedFiles: cycle.result?.changedFiles ?? [],
    commits: cycle.result?.commits ?? [],
  };
}

export function candidateViewOf(candidate: Candidate): ContinuousCandidateView {
  return {
    candidateId: candidate.id,
    title: candidate.title,
    rationale: candidate.rationale,
    targetPaths: candidate.targetPaths,
    impact: candidate.impact,
    confidence: candidate.confidence,
    effort: candidate.effort,
    risk: candidate.risk,
    status: candidate.status,
    sourceCycleId: candidate.sourceCycleId,
    executionCycleId: candidate.executionCycleId ?? null,
    updatedAt: candidate.updatedAt,
  };
}

export function decisionViewOf(decision: Decision): ContinuousDecisionView {
  const resolution = decision.resolution;
  return {
    decisionId: decision.id,
    title: decision.title,
    context: decision.context,
    options: decision.options,
    ...(decision.recommendation === undefined ? {} : { recommendation: decision.recommendation }),
    classification: decision.classification,
    ...(decision.blockingScope === undefined ? {} : { blockingScope: decision.blockingScope }),
    status: decision.status,
    version: decision.version,
    ...(resolution === undefined
      ? {}
      : {
          resolution: {
            // dismissed 行的 resolution 只有 resolvedAt（无 optionId/text）；resolved 行按
            // 是否携带 optionId 区分选项/文字回答——kind 是展示投影，不是新的业务状态。
            kind:
              decision.status === "dismissed"
                ? ("dismissed" as const)
                : resolution.optionId !== undefined
                  ? ("option" as const)
                  : ("text" as const),
            ...(resolution.optionId === undefined ? {} : { optionId: resolution.optionId }),
            ...(resolution.text === undefined ? {} : { text: resolution.text }),
            resolvedAt: resolution.resolvedAt,
          },
        }),
    sourceCycleIds: (decision.sources ?? []).map((source) => source.cycleId),
    updatedAt: decision.updatedAt,
  };
}

export function continuationViewOf(request: ContinuationRequest): ContinuousContinuationView {
  return {
    requestId: request.id,
    cycleId: request.cycleId,
    version: request.version,
    status: request.status,
    reason: request.reason,
    reasons: request.reasons,
    limitKind: request.limitKind,
    observedUsage: request.observedUsage,
    currentLimit: request.currentLimit,
    recommendedExtension: request.recommendedExtension,
    createdAt: request.createdAt,
  };
}

export function usageViewOf(summary: UsageLedgerSummary): ContinuousUsageSummary {
  return {
    settledCostMicros: summary.settledCostMicros,
    unsettledCostMicros: summary.unsettledCostMicros,
    settledTokens: summary.settledTokens,
    unsettledTokens: summary.unsettledTokens,
  };
}

/** 详情结果的稳定组装（字段齐全度由类型保证；这里只集中默认值）。 */
export function assembleProgramDetail(input: {
  program: Program;
  currentCycle: Cycle | null;
  recentCycles: Cycle[];
  candidates: Candidate[];
  decisions: Decision[];
  continuationRequest: ContinuationRequest | null;
  dailyUsage: UsageLedgerSummary;
  cycleUsage: UsageLedgerSummary | null;
  lease: {
    epoch: number;
    ownerId: string | null;
    cycleId: string | null;
    expiresAt: number | null;
  } | null;
  platformConcurrency: number;
  at: number;
}): ContinuousProgramDetailResult {
  return {
    program: programViewOf(input.program),
    currentCycle: input.currentCycle ? cycleViewOf(input.currentCycle) : null,
    recentCycles: input.recentCycles.map(cycleViewOf),
    candidates: input.candidates.map(candidateViewOf),
    decisions: input.decisions.map(decisionViewOf),
    continuationRequest: input.continuationRequest
      ? continuationViewOf(input.continuationRequest)
      : null,
    dailyUsage: usageViewOf(input.dailyUsage),
    cycleUsage: input.cycleUsage ? usageViewOf(input.cycleUsage) : null,
    lease: input.lease,
    platformConcurrency: input.platformConcurrency,
    at: input.at,
  };
}
