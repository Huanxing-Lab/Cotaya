// Continuous Cycle 结算的终局裁决辅助（CT-07 自 supervisorLifecycle.ts 拆出；架构
// max-file-lines 拆分，非边界变化）：资源上限挂起（§6.1）、终局 CycleResult 组装（只采信
// 过门 done）、预算/重试类失败 → 挂起原因的映射。全部纯依赖注入，无自有状态。

import { randomUUID } from "node:crypto";
import type { ContinuationRequestReason, Cycle, CycleResult, Program } from "../domain/types.js";
import { isTerminalCycleStatus } from "../domain/types.js";
import type { ContinuousBudgetDenial } from "@zcode/shared/continuous-protocol";
import {
  continuationFactsOf,
  continuationTriggersOf,
  mergeContinuationTriggers,
  type ContinuationFacts,
} from "./continuationFacts.js";
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

/**
 * CT-12 CLI 拒绝通知路径的挂起：与 suspendCycleForBudget 同一条落库链（先冻结执行侧准许、
 * 同轮唯一 pending 确认合并、program paused），但原因来自 CLI 侧准入所有者的结构化通知
 * （budget_denied/admission_closed/change_limit/retry_limit——§2.1 修复边界「CLI 通知 Host
 * 保存暂停和继续确认」），不是 Run 终态的文本映射。重复通知幂等（existing pending 复用）；
 * 多个 actor 同时超限并发通知合并进同一条 pending（reasons 追加、观测更新，不重复弹窗，
 * §5/CT-13——部分唯一索引兜底并发插入，冲突后重读复用）。
 */
export async function suspendCycleForAgentNotification(
  deps: SuspendWriteDeps,
  input: {
    cycle: Cycle;
    program: Program;
    code: "budget_denied" | "admission_closed" | "change_limit" | "retry_limit";
    limitKind?: "file_limit" | "line_limit";
    /** budget_denied 的结构化观测（wire denial 原样；CT-13 真实 limitKind/限额/需求）。 */
    denial?: ContinuousBudgetDenial;
    message: string;
  },
): Promise<string> {
  const { cycle, program, code, limitKind, denial, message } = input;
  const facts: ContinuationFacts = continuationFactsOf(code, limitKind, denial, message, program);
  const now = deps.clock.now();
  await deps.execution.suspendAtSafeBoundary(referenceOf(cycle), `${code}:${message}`);
  let existing = await deps.repository.getPendingContinuationRequest(cycle.id);
  if (existing === null) {
    const requestId = randomUUID();
    try {
      await deps.repository.insertContinuationRequest({
        id: requestId,
        programId: program.id,
        cycleId: cycle.id,
        reason: facts.reason,
        limitKind: facts.limitKind,
        reasons: [facts.reason],
        observedUsage: { triggers: [facts.trigger] },
        currentLimit: facts.currentLimit,
        recommendedExtension: facts.recommendedExtension,
        version: 1,
        status: "pending",
        createdAt: now,
      });
    } catch (error) {
      // 并发插入撞「同轮唯一 pending」部分唯一索引（多个 actor 同时超限）：重读复用既有
      // pending 合并，不把第二个 actor 的挂起通知变成失败（CT-13 合并确认）。
      existing = await deps.repository.getPendingContinuationRequest(cycle.id);
      if (existing === null) throw error;
    }
  }
  if (existing !== null) {
    // 合并（CT-13 多上限触发）：reasons 并集；观测按触发累积（同 limitKind 的重复通知以
    // 最新数字替换）；currentLimit/recommendedExtension 按字段合并——费用与 token 上限可以
    // 同时命中，合并后的确认必须同时携带两侧事实，不能后到者覆盖先到者。
    const reasons = [...existing.reasons];
    if (!reasons.includes(facts.reason)) reasons.push(facts.reason);
    const triggers = mergeContinuationTriggers(existing.observedUsage, facts.trigger);
    const currentLimit = {
      ...((existing.currentLimit as Record<string, unknown> | null) ?? {}),
      ...(facts.currentLimit as Record<string, unknown>),
    };
    const recommendedExtension = {
      ...((existing.recommendedExtension as Record<string, unknown> | null) ?? {}),
      ...(facts.recommendedExtension as Record<string, unknown>),
    };
    const unchanged =
      reasons.length === existing.reasons.length &&
      JSON.stringify(triggers) === JSON.stringify(continuationTriggersOf(existing.observedUsage)) &&
      JSON.stringify(currentLimit) === JSON.stringify(existing.currentLimit) &&
      JSON.stringify(recommendedExtension) === JSON.stringify(existing.recommendedExtension);
    if (!unchanged) {
      await deps.repository.saveContinuationRequest({
        ...existing,
        reason: facts.reason,
        reasons,
        observedUsage: { triggers },
        currentLimit,
        recommendedExtension,
        version: existing.version + 1,
      });
    }
  }
  const requestId = (existing ?? (await deps.repository.getPendingContinuationRequest(cycle.id)))!
    .id;
  // 评审修复（挂起写入的整行覆盖竞态）：入口读取的 cycle 行在 suspendAtSafeBoundary 的
  // wire 往返（秒级窗口）内可能已被同一监督循环推进（reportCursor 经报告导入、健康列经
  // 探活持久化）——用入口快照整行回写会把游标/健康列打回旧值。落库前重读最新行、保留
  // 游标与健康列的最新事实（与 applyHealthAssessment 同一写纪律）。
  // 二期评审遗留修复：仅排除 suspended 不够——往返窗口内并发的「立即停止」链
  // （supervisorControl 的 stopCurrentCycle：execution.stop→waitForQuiescence→
  // completeCycle(cancelled)＋releaseLease，全程不 bump leaseEpoch）可能已把本轮结算为
  // 终态，桌面退出也可能已保存 interrupted。终态行有终局性（§6「立即停止→cancelled」），
  // interrupted 由恢复流程接管；迟到的拒绝通知把它们翻写回 suspended 会制造幽灵开放轮
  // （部分唯一索引仍算未结束，下一次 runNow 撞 open_cycle_exists）。因此仅非终态开放轮
  // （running/preparing/settling）才合并挂起字段；suspended 仍排除（幂等不重复写）。
  if (cycle.status !== "suspended") {
    const latest = await deps.repository.getCycle(cycle.id);
    if (
      latest &&
      latest.leaseEpoch === cycle.leaseEpoch &&
      !isTerminalCycleStatus(latest.status) &&
      latest.status !== "suspended" &&
      latest.status !== "interrupted"
    ) {
      await deps.repository.saveCycle({
        ...latest,
        status: "suspended",
        pendingContinuationRequestId: requestId,
        updatedAt: now,
      });
    }
  }
  if (program.status !== "paused") {
    await deps.repository.saveProgram({
      ...program,
      status: "paused",
      statusReason: `资源上限（${code}）待继续确认`,
      updatedAt: now,
    });
  }
  return requestId;
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
  // CT-13：pricing_missing 同为「需关注」的结构化原因——挂起询问用户（修价格配置），
  // 不计入任务失败（连续失败 3 轮会让 Program failed，掩盖配置问题）。
  const budgetCodes = [
    "budget_denied",
    "admission_closed",
    "ledger_unreachable",
    "pricing_missing",
  ];
  if (budgetCodes.some((code) => text.includes(code))) return "cost_limit";
  if (text.includes("retry_limit")) return "retry_limit";
  return null;
}
