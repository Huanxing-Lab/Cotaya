// Continuous Cycle 生命周期面（CT-05）：从 supervisor.ts 拆出的创建与终局裁决
// （架构 max-file-lines 400 上限的拆分，不是边界变化）。与 supervisor.ts（链路编排）的边界：
//   - supervisor 负责「跑到终态」：提交、轮询导入、等待 quiescence、幂等重放；
//   - 本文件负责「首尾两端写什么」：Cycle 快照构造（脚本 bytes/hash + 执行身份 + 配置快照，
//     §6/§10）与终局结算——drain 已保存报告（Run 失败也导入，§11）、资源挂起（§6.1）、
//     选择复核与理由保存（§7/§8）、done 候选落队列（E-12 门）、终态 Cycle 与 Program
//     nextCycleAt 同事务（completeCycle，CT-01）。
// 全部经注入依赖执行（repository/clock/execution），无自有状态；不回 import supervisor
// （SupervisedCycleOutcome 类型也因此住在这里，避免环）。

import { createHash, randomUUID } from "node:crypto";
import type {
  ContinuousErrorCode,
  ContinuousReportCandidateResultItem,
  ContinuousReportCycleResultItem,
} from "@zcode/shared";
import type { Cycle, CycleResult, Program } from "../domain/types.js";
import { selectCandidates } from "../domain/candidatePolicy.js";
import { nextCycleAtFor } from "../domain/cadencePolicy.js";
import { ContinuousReportIngestion, type ReportIngestionOutcome } from "./reportIngestion.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";

/** 监督一轮的终局结论（supervisor 的 completion 以它 resolve）。 */
export interface SupervisedCycleOutcome {
  cycleId: string;
  cycleStatus: Cycle["status"];
  programStatus: Program["status"];
  result?: CycleResult;
  /** 导入侧拒绝的报告条数（malformed/未过 done 门；细节在拒绝事件里）。 */
  reportRejections: number;
}

/** 生命周期操作需要的依赖子集（supervisor 交进来；测试可独立注入）。 */
export interface CycleSettlementDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  clock: Pick<ContinuousClockPort, "now">;
}

/** 执行身份：从 (programId, triggerKey) 确定派生——提交前保存，崩溃重试同身份（规格 §10）。 */
function deriveExecutionIds(programId: string, triggerKey: string) {
  const digest = createHash("sha256").update(`${programId}:${triggerKey}`, "utf8").digest("hex");
  return {
    executionSessionId: `ctexec-${digest.slice(0, 24)}`,
    workflowRunId: `dwfrun-ct-${digest.slice(24, 48)}`,
    traceId: `trace-ct-${digest.slice(48, 64)}`,
  };
}

/**
 * Cycle 快照构造（preparing 行）：脚本 bytes/hash、配置快照、执行身份三元组。
 * 模板 hash 与 Program 授权绑定不符 → template_mismatch / authorization_stale（§6：
 * 模板与模型升级不改变已存在 Cycle 的快照；旧模板不可用明确失败，不静默换脚本 resume）。
 * 拒绝用与 supervisor 相同的结构化错误类（code 稳定），因此这里自行构造轻量错误对象。
 */
export async function createManagedCycleRecord(
  repository: ContinuousRepositoryPort,
  input: {
    program: Program;
    triggerKey: string;
    requestId: string;
    baseCommit: string;
    template: { scriptText: string; scriptHash?: string } | null;
    now: number;
  },
): Promise<{ ok: true; cycle: Cycle } | { ok: false; code: ContinuousErrorCode; message: string }> {
  const { program, triggerKey, requestId, baseCommit, template, now } = input;
  if (!template) {
    return {
      ok: false,
      code: "template_mismatch",
      message: `模板不存在: ${program.templateId}@${program.templateVersion}（旧模板不可用则明确失败，不静默换脚本）`,
    };
  }
  const scriptHash =
    template.scriptHash ?? createHash("sha256").update(template.scriptText, "utf8").digest("hex");
  if (scriptHash !== program.templateHash) {
    return {
      ok: false,
      code: "template_mismatch",
      message: `模板 hash 与 Program 授权不符: ${program.templateId}@${program.templateVersion}`,
    };
  }
  if (program.authorization.templateHash !== program.templateHash) {
    return {
      ok: false,
      code: "authorization_stale",
      message: `program ${program.id} 授权绑定 hash 与模板配置不一致，需重新授权`,
    };
  }
  const ids = deriveExecutionIds(program.id, triggerKey);
  const cycle: Cycle = {
    id: randomUUID(),
    programId: program.id,
    sequence: (await repository.getLatestCycleSequence(program.id)) + 1,
    triggerKey,
    trigger: { kind: "manual" },
    status: "preparing",
    configurationSnapshot: {
      goal: program.goal,
      scope: program.scope,
      budget: program.budget,
      cadence: program.cadence,
      decisionPolicy: program.decisionPolicy,
      template: {
        id: program.templateId,
        version: program.templateVersion,
        hash: program.templateHash,
      },
      trigger: { kind: "manual", requestId },
    },
    scriptText: template.scriptText,
    scriptHash,
    executionSessionId: ids.executionSessionId,
    workflowRunId: ids.workflowRunId,
    traceId: ids.traceId,
    leaseEpoch: 0,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    baseCommit,
    createdAt: now,
    updatedAt: now,
  };
  // 并发窗口的第二个写入者由 UNIQUE(trigger_key)/开放 Cycle 部分唯一索引在数据库层拒绝。
  await repository.insertCycle(cycle);
  return { ok: true, cycle };
}

/** 跨批次累计导入结论（监督循环与 settling 共用）。 */
export interface ReportAccumulator {
  candidateResults: Map<
    string,
    { item: ContinuousReportCandidateResultItem; doneAccepted: boolean }
  >;
  cycleResult?: ContinuousReportCycleResultItem;
  itemKeyOfCandidateId: Map<string, string>;
  rejections: number;
}

export function createAccumulator(): ReportAccumulator {
  return {
    candidateResults: new Map(),
    itemKeyOfCandidateId: new Map(),
    rejections: 0,
  };
}

export function accumulateInto(
  accumulator: ReportAccumulator,
  outcome: ReportIngestionOutcome,
): void {
  for (const [key, entry] of outcome.candidateResults) accumulator.candidateResults.set(key, entry);
  if (outcome.cycleResult !== undefined) accumulator.cycleResult = outcome.cycleResult;
  for (const [itemKey, candidateId] of outcome.itemKeyToCandidateId) {
    accumulator.itemKeyOfCandidateId.set(candidateId, itemKey);
  }
  accumulator.rejections += outcome.rejected.length;
}

/**
 * settling：终态前导入全部已保存报告（Run 失败也导入，§11），再原子结算（§10 恢复顺序表）。
 * 返回值即 SupervisedCycleOutcome（completed/failed/suspended 三种终局）。
 */
export async function settleCycle(
  deps: CycleSettlementDeps,
  input: {
    cycle: Cycle;
    program: Program;
    ref: ExecutionReference;
    finalState: ExecutionState;
    accumulator: ReportAccumulator;
  },
): Promise<SupervisedCycleOutcome> {
  const { cycle, program, ref, finalState, accumulator } = input;
  // settle 期间的最新事实（consecutiveFailures 等以库内为准，不用监督开始时的快照）。
  const liveProgram = (await deps.repository.getProgram(program.id)) ?? program;
  const now = deps.clock.now();
  await deps.repository.saveCycle({ ...cycle, status: "settling", updatedAt: now });

  const ingestion = new ContinuousReportIngestion({
    repository: deps.repository,
    clock: deps.clock,
  });
  for (let pages = 0; pages < 1024; pages++) {
    const current = (await deps.repository.getCycle(cycle.id)) ?? cycle;
    const batch = await deps.execution.readReports(ref, current.reportCursor);
    if (batch.items.length === 0) break;
    accumulateInto(
      accumulator,
      await ingestion.ingestBatch({
        programId: program.id,
        cycleId: cycle.id,
        items: batch.items,
        nextCursor: batch.nextCursor,
      }),
    );
  }

  // 资源上限挂起（§6.1）：预算/重试类失败是可恢复暂停，不是任务失败——不 cancel、不 failed。
  if (finalState.status === "errored" && budgetSuspensionReason(finalState) !== null) {
    return await suspendCycleForBudget(deps, {
      cycle,
      program: liveProgram,
      finalState,
      accumulator,
    });
  }

  // 有限候选选择复核（§7/§8）：对导入后的队列跑产品规则，保存选择理由（审计事件）。
  const queue = await deps.repository.listQueueableCandidates(program.id);
  const pendingDecisions = await deps.repository.listPendingDecisions(program.id);
  const selection = selectCandidates({
    candidates: queue,
    scope: program.scope,
    pendingDecisions,
    maxImprovements: program.budget.perCycleMaxImprovements,
  });
  await deps.repository.appendEvent({
    programId: program.id,
    cycleId: cycle.id,
    eventKey: `cycle-selection:${cycle.id}`,
    type: "cycle.selection",
    payload: { rationale: selection.rationale },
    createdAt: deps.clock.now(),
  });

  // done 候选落终态：只有过了导入侧三阶段验证门的结果才允许 done（E-12 防线）。
  for (const candidate of queue) {
    const key = accumulator.itemKeyOfCandidateId.get(candidate.id);
    if (key === undefined) continue;
    const result = accumulator.candidateResults.get(key);
    if (!result) continue;
    if (result.doneAccepted && result.item.status === "done") {
      await deps.repository.saveCandidate({
        ...candidate,
        status: "done",
        executionCycleId: cycle.id,
        updatedAt: deps.clock.now(),
      });
    } else if (result.item.status === "rejected") {
      await deps.repository.saveCandidate({
        ...candidate,
        status: "rejected",
        updatedAt: deps.clock.now(),
      });
    }
  }

  const doneResults = [...accumulator.candidateResults.values()].filter(
    (entry) => entry.doneAccepted && entry.item.status === "done",
  );
  const attempted = accumulator.candidateResults.size;
  const result = buildCycleResult(accumulator, doneResults, attempted, finalState);
  const failed = finalState.status !== "completed";
  const settledAt = deps.clock.now();
  // 结算行以库内最新为准（settling 期间 cursor/健康字段可能又被推进）。
  const liveCycle = (await deps.repository.getCycle(cycle.id)) ?? cycle;
  const consecutiveFailures = failed ? liveProgram.consecutiveFailures + 1 : 0;
  const programFailed = failed && consecutiveFailures >= 3;
  const terminalCycle: Cycle = {
    ...liveCycle,
    status: failed ? "failed" : "completed",
    completedAt: settledAt,
    updatedAt: settledAt,
    ...(result === undefined ? {} : { result }),
  };
  await deps.repository.completeCycle(terminalCycle, {
    status: programFailed ? "failed" : "sleeping",
    ...(programFailed ? { statusReason: "连续失败达到上限，需显式恢复" } : {}),
    nextCycleAt: nextCycleAtFor(liveProgram, settledAt),
    lastCycleAt: settledAt,
    // 失败累计、成功清零（§6：连续 3 个失败 Cycle → failed，需显式恢复）。
    consecutiveFailures,
    updatedAt: settledAt,
  });
  return {
    cycleId: cycle.id,
    cycleStatus: terminalCycle.status,
    programStatus: programFailed ? "failed" : "sleeping",
    ...(result === undefined ? {} : { result }),
    reportRejections: accumulator.rejections,
  };
}

/** 资源上限挂起：cycle suspended + program paused + 同轮唯一 pending 继续确认（§6.1/§5）。 */
async function suspendCycleForBudget(
  deps: CycleSettlementDeps,
  input: {
    cycle: Cycle;
    program: Program;
    finalState: ExecutionState;
    accumulator: ReportAccumulator;
  },
): Promise<SupervisedCycleOutcome> {
  const { cycle, program, finalState, accumulator } = input;
  const reason = budgetSuspensionReason(finalState)!;
  const now = deps.clock.now();
  const existing = await deps.repository.getPendingContinuationRequest(cycle.id);
  let requestId = existing?.id;
  if (requestId === undefined) {
    requestId = randomUUID();
    await deps.repository.insertContinuationRequest({
      id: requestId,
      programId: program.id,
      cycleId: cycle.id,
      reason,
      limitKind: reason === "retry_limit" ? "retry" : "cost",
      reasons: [reason],
      observedUsage: {
        failureCode: finalState.failureCode ?? null,
        stopReason: finalState.stopReason ?? null,
      },
      currentLimit: { perCycleCostUsdMicros: program.budget.perCycleCostUsdMicros },
      recommendedExtension: { costMicros: program.budget.perCycleCostUsdMicros },
      version: 1,
      status: "pending",
      createdAt: now,
    });
  }
  const suspended: Cycle = {
    ...cycle,
    status: "suspended",
    pendingContinuationRequestId: requestId,
    updatedAt: now,
  };
  await deps.repository.saveCycle(suspended);
  await deps.repository.saveProgram({
    ...program,
    status: "paused",
    statusReason: `资源上限（${reason}）待继续确认`,
    updatedAt: now,
  });
  return {
    cycleId: cycle.id,
    cycleStatus: "suspended",
    programStatus: "paused",
    reportRejections: accumulator.rejections,
  };
}

/** 终局 CycleResult：changedFiles/commits 只采信过门的 done 结果；cycle_result 只提供叙事。 */
function buildCycleResult(
  accumulator: ReportAccumulator,
  doneResults: Array<{ item: { changedFiles: string[]; commits: string[] } }>,
  attempted: number,
  finalState: ExecutionState,
): CycleResult | undefined {
  if (doneResults.length === 0 && accumulator.cycleResult === undefined && attempted === 0) {
    return finalState.status === "completed"
      ? {
          outcome: "no_changes",
          changedFiles: [],
          commits: [],
          evidence: [],
          summary: "本轮未发现可自主实施的改进",
        }
      : undefined;
  }
  const changedFiles = [...new Set(doneResults.flatMap((entry) => entry.item.changedFiles))];
  const commits = [...new Set(doneResults.flatMap((entry) => entry.item.commits))];
  const reported = accumulator.cycleResult;
  let outcome: CycleResult["outcome"];
  if (doneResults.length === 0) {
    outcome = attempted > 0 || reported?.outcome === "changes_verified" ? "partial" : "no_changes";
  } else if (reported?.outcome === "changes_verified" && attempted === doneResults.length) {
    outcome = "changes_verified";
  } else {
    outcome = "partial";
  }
  return {
    outcome,
    changedFiles,
    commits,
    evidence: reported?.evidence ?? [],
    summary:
      reported?.summary ??
      `${doneResults.length}/${attempted} 项完成验证提交${commits.length > 0 ? `（${commits.length} 个本地提交）` : ""}`,
  };
}

/** 预算/重试类失败 → 挂起原因；其余失败按任务失败处理（尽力映射，真实 provider 链路归 CT-09）。 */
export function budgetSuspensionReason(state: ExecutionState): "cost_limit" | "retry_limit" | null {
  const text = `${state.failureCode ?? ""} ${state.stopReason ?? ""}`;
  const budgetCodes = ["budget_denied", "admission_closed", "ledger_unreachable"];
  if (budgetCodes.some((code) => text.includes(code))) return "cost_limit";
  if (text.includes("retry_limit")) return "retry_limit";
  return null;
}
