// Continuous Cycle 结算的终局裁决辅助（CT-07 自 supervisorLifecycle.ts 拆出；架构
// max-file-lines 拆分，非边界变化）：资源上限挂起（§6.1）、终局 CycleResult 组装（只采信
// 过门 done）、预算/重试类失败 → 挂起原因的映射。全部纯依赖注入，无自有状态。

import { randomUUID } from "node:crypto";
import type { Cycle, CycleResult, Program } from "../domain/types.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";
import type { ReportAccumulator, SupervisedCycleOutcome } from "./supervisorTypes.js";

/** 资源挂起写入需要的依赖子集（settleCycle 交进来）。 */
export interface SuspendWriteDeps {
  repository: ContinuousRepositoryPort;
  /**
   * 评审修复：挂起语义必须落到执行端口——只写 DB 不调 suspendAtSafeBoundary 时，CLI 适配器
   * 的本地准许状态停留在 open，用户回答 continue 后 resumeSuspended 必抛 not_suspended，
   * 「挂起冻结新请求 / 继续解冻」的执行侧半边完全断裂（规格 §6.1/§11）。
   */
  execution: Pick<ContinuousExecutionPort, "suspendAtSafeBoundary">;
  clock: Pick<ContinuousClockPort, "now">;
}

function referenceOf(cycle: Cycle): ExecutionReference {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

/** 资源上限挂起：cycle suspended + program paused + 同轮唯一 pending 继续确认（§6.1/§5）。 */
export async function suspendCycleForBudget(
  deps: SuspendWriteDeps,
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
  // 先冻结执行侧准许再落库：适配器 admission → suspended（Resume 走 resumeSuspended 解冻；
  // 装配后 CT-04 预算闸门在同一状态上拒绝新请求）。Run 已终态时该调用仍安全——适配器只
  // 翻内存准许状态，不触碰引擎。
  await deps.execution.suspendAtSafeBoundary(referenceOf(cycle), reason);
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
export function buildCycleResult(
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

/**
 * 预算/重试类失败 → 挂起原因；其余失败按任务失败处理。
 * 已知边界（评审确认，如实记录）：这是对 Run 终态 failureCode 的文本映射（尽力），发生在
 * Run 已经 errored 之后——「在请求被拒的瞬间于安全边界挂起、Run 保持可恢复」需要引擎侧
 * 预算拒绝语义（结算为 stopped+resumable 或支持 errored 同 Run 重启），当前 DWF 引擎两者
 * 皆无；因此 continue 后若 Run 已 errored，监督会按同一条终态再次进入挂起确认。真实
 * provider 链路的端到端闭环归 CT-09 后续（见 docs/release/continuous.md 已知边界）。
 */
export function budgetSuspensionReason(state: ExecutionState): "cost_limit" | "retry_limit" | null {
  const text = `${state.failureCode ?? ""} ${state.stopReason ?? ""}`;
  const budgetCodes = ["budget_denied", "admission_closed", "ledger_unreachable"];
  if (budgetCodes.some((code) => text.includes(code))) return "cost_limit";
  if (text.includes("retry_limit")) return "retry_limit";
  return null;
}
