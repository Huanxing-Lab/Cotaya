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
import type { ContinuousErrorCode } from "@zcode/shared";
import type { Cycle, Program } from "../domain/types.js";
import { isTerminalCycleStatus } from "../domain/types.js";
import { selectCandidates } from "../domain/candidatePolicy.js";
import type { ReportAccumulator, RunNowResult, SupervisedCycleOutcome } from "./supervisorTypes.js";
export type { ReportAccumulator, RunNowResult, SupervisedCycleOutcome } from "./supervisorTypes.js";
import { nextCycleAtFor } from "../domain/cadencePolicy.js";
import {
  budgetSuspensionReason,
  buildCycleResult,
  suspendCycleForBudget,
} from "./supervisorSettlement.js";
import { ContinuousReportIngestion, type ReportIngestionOutcome } from "./reportIngestion.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";

/**
 * supervisor 链路的结构化错误（词表含 open_cycle_exists/program_not_runnable 两个编排层
 * 语义；CT-07 起控制面复用同一错误类）。放本文件避免 supervisor↔supervisorControl 循环引用。
 */
export class ContinuousSupervisorError extends Error {
  constructor(
    readonly code:
      | import("@zcode/shared").ContinuousErrorCode
      | "open_cycle_exists"
      | "program_not_runnable",
    message: string,
  ) {
    super(message);
    this.name = "ContinuousSupervisorError";
  }
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
    /** manual=请求 ID；interval/daily=稳定到期 key（cadencePolicy 派生，§10）。 */
    triggerKind: Cycle["trigger"]["kind"];
    requestId: string;
    baseCommit: string;
    template: { scriptText: string; scriptHash?: string } | null;
    now: number;
  },
): Promise<
  | { ok: true; cycle: Cycle }
  | { ok: false; code: ContinuousErrorCode | "open_cycle_exists"; message: string }
> {
  const { program, triggerKey, triggerKind, requestId, baseCommit, template, now } = input;
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
    trigger: { kind: triggerKind },
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
      trigger: { kind: triggerKind, requestId },
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
  try {
    await repository.insertCycle(cycle);
  } catch (error) {
    // CT-07：到期启动与上一轮结算并发时（恢复流程读到尚未推进 nextCycleAt 的 Program，
    // 而旧 Cycle 恰在检查后落终态），INSERT 撞 UNIQUE(program_id,trigger_key)——该到期窗口
    // 已启动过，按「错过多轮只唤醒一次」语义跳过（open_cycle_exists 由调用方安静吸收），
    // 不能把幂等竞态当成故障抛出。修复依据：docs/specs/continuous.md §10 重复 wake/错过多轮。
    if ((error as { errcode?: number }).errcode === 2067) {
      return {
        ok: false,
        code: "open_cycle_exists",
        message: `trigger 窗口已启动过（UNIQUE 命中）: ${triggerKey}`,
      };
    }
    throw error;
  }
  return { ok: true, cycle };
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
  if (isTerminalCycleStatus(liveCycle.status)) {
    // CT-07 修复：结算非原子窗口内另一写入者（立即停止/恢复流程/同库另一实例）已落终态时，
    // 本分支不得再用自己的结论覆盖（用户取消被翻成 completed、paused 被翻成 sleeping 都是
    // 真实竞态）。以先落库的终态为准，本结算只上报导入事实。
    return {
      cycleId: cycle.id,
      cycleStatus: liveCycle.status,
      programStatus: liveProgram.status,
      ...(liveCycle.result === undefined ? {} : { result: liveCycle.result }),
      reportRejections: accumulator.rejections,
    };
  }
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
    // CT-07 修复：结算期间用户已 Pause 的 Program 保持 paused（§6「当前轮可结束」），不能被
    // 这里无条件翻成 sleeping——否则 Pause 语义退化为「只取消未开始的部分」。恢复依据：
    // settle 以库内 liveProgram 为准（paused 状态是用户事实，nextCycleAt 照常保存，paused
    // Program 不会被到期查询唤醒，直到显式恢复）。
    status: programFailed ? "failed" : liveProgram.status === "paused" ? "paused" : "sleeping",
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
    programStatus: programFailed
      ? "failed"
      : liveProgram.status === "paused"
        ? "paused"
        : "sleeping",
    ...(result === undefined ? {} : { result }),
    reportRejections: accumulator.rejections,
  };
}
