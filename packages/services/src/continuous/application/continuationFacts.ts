// 继续确认的事实映射与合并（CT-13，自 supervisorSettlement.ts 拆出——架构 max-file-lines
// 拆分，非边界变化）：CLI 拒绝通知 → 继续确认字段（reason/limitKind/观测/限额/推荐增量），
// 以及多上限触发合并进同一条 pending 时的 triggers 累积语义。纯依赖注入，无自有状态。
//
// 词表唯一来源：domain types 的 ContinuationRequestReason/limitKind 与 wire 的
// continuousBudgetDenial.limitKind——本文件只做映射，不建第二套翻译。

import type { ContinuationRequest, ContinuationRequestReason, Program } from "../domain/types.js";
import type { ContinuousBudgetDenial } from "@zcode/shared/continuous-protocol";

/** 继续确认的 limitKind 投影词表（domain types 的同一份，不建第二套翻译）。 */
export type ContinuationLimitKind = ContinuationRequest["limitKind"];

/** 继续确认的单次触发观测（合并确认的最小事实单元，CT-13）。 */
export interface ContinuationTrigger {
  code: string;
  limitKind?: string;
  message?: string;
  denial?: ContinuousBudgetDenial;
}

/** 读取既有 observedUsage 的 triggers 数组（旧形态/空值折算为空数组，读面兼容）。 */
export function continuationTriggersOf(observed: unknown): ContinuationTrigger[] {
  const list = (observed as { triggers?: unknown } | null)?.triggers;
  return Array.isArray(list)
    ? (list.filter((item) => typeof item === "object" && item !== null) as ContinuationTrigger[])
    : [];
}

/** 合并触发：同 limitKind（无 denial 时同 code）以最新观测替换，否则累积。 */
export function mergeContinuationTriggers(
  prior: unknown,
  next: ContinuationTrigger,
): ContinuationTrigger[] {
  const triggers = [...continuationTriggersOf(prior)];
  const keyOf = (trigger: ContinuationTrigger): string =>
    trigger.denial?.limitKind ?? trigger.limitKind ?? trigger.code;
  const index = triggers.findIndex((trigger) => keyOf(trigger) === keyOf(next));
  if (index >= 0) triggers[index] = next;
  else triggers.push(next);
  return triggers;
}

/** 拒绝通知 → 继续确认字段映射的产物（suspendCycleForAgentNotification 消费）。 */
export interface ContinuationFacts {
  reason: ContinuationRequestReason;
  limitKind: ContinuationLimitKind;
  /** 单次触发的观测（合并确认时按 limitKind 去重累积成 triggers 数组）。 */
  trigger: ContinuationTrigger;
  currentLimit: unknown;
  recommendedExtension: unknown;
}

/**
 * 拒绝通知 → 继续确认字段映射（CT-13）：reason/limitKind 来自**真实**触发（denial.limitKind
 * 或 retry_limit/change_limit code），观测携带结构化 denial；recommendedExtension 给
 * 「恰好让本请求通过」的增量（用户可自行加码），不假装知道用户想要多少。
 */
export function continuationFactsOf(
  code: "budget_denied" | "admission_closed" | "change_limit" | "retry_limit",
  limitKind: "file_limit" | "line_limit" | undefined,
  denial: ContinuousBudgetDenial | undefined,
  message: string,
  program: Program,
): ContinuationFacts {
  if (code === "retry_limit") {
    // 单请求尝试上限的继续授权语义（CT-13）：用户显式继续后该请求链获得新的尝试预算。
    return {
      reason: "retry_limit",
      limitKind: "retry",
      trigger: { code, message },
      currentLimit: { maxModelRequestAttempts: program.budget.maxModelRequestAttempts },
      recommendedExtension: { attempts: program.budget.maxModelRequestAttempts },
    };
  }
  if (code === "change_limit") {
    return {
      reason: "change_limit",
      limitKind: "change",
      trigger: { code, ...(limitKind === undefined ? {} : { limitKind }) },
      currentLimit: {
        perCycleMaxFiles: program.budget.perCycleMaxFiles,
        perCycleMaxChangedLines: program.budget.perCycleMaxChangedLines,
      },
      recommendedExtension: {
        maxFiles: program.budget.perCycleMaxFiles,
        maxChangedLines: program.budget.perCycleMaxChangedLines,
      },
    };
  }
  if (denial !== undefined) {
    return denialFactsOf(code, denial);
  }
  // 无结构化观测（admission_closed / 旧版 CLI 的 budget_denied）：保持既有保守投影。
  return {
    reason: "cost_limit",
    limitKind: "cost",
    trigger: { code, ...(limitKind === undefined ? {} : { limitKind }) },
    currentLimit: { perCycleCostUsdMicros: program.budget.perCycleCostUsdMicros },
    recommendedExtension: { costMicros: program.budget.perCycleCostUsdMicros },
  };
}

/** 带 denial 的映射：token/日费用/单轮费用三个真实上限口径分别成案。 */
function denialFactsOf(
  code: "budget_denied" | "admission_closed" | "change_limit" | "retry_limit",
  denial: ContinuousBudgetDenial,
): ContinuationFacts {
  const cycleOverflowMicros =
    denial.cycleSummary.settledCostMicros +
    denial.cycleSummary.reservedCostMicros +
    denial.cycleSummary.unknownCostMicros +
    denial.request.reservedCostMicros -
    denial.currentLimit.cycleCostMicros;
  if (denial.limitKind === "cycle_tokens") {
    const overflowTokens =
      denial.cycleSummary.settledTokens +
      denial.cycleSummary.reservedTokens +
      denial.cycleSummary.unknownTokens +
      denial.request.reservedTokens -
      denial.currentLimit.cycleTokens;
    return {
      reason: "token_limit",
      limitKind: "token",
      trigger: { code, denial },
      currentLimit: { perCycleTokens: denial.currentLimit.cycleTokens },
      recommendedExtension: {
        tokens: Math.max(overflowTokens, denial.request.reservedTokens, 1),
      },
    };
  }
  if (denial.limitKind === "daily_cost" && denial.dailySummary !== undefined) {
    const dailyOverflow =
      denial.dailySummary.settledCostMicros +
      denial.dailySummary.reservedCostMicros +
      denial.dailySummary.unknownCostMicros +
      denial.request.reservedCostMicros -
      (denial.currentLimit.dailyCostMicros ?? 0);
    return {
      reason: "cost_limit",
      limitKind: "cost",
      trigger: { code, denial },
      currentLimit: { dailyCostUsdMicros: denial.currentLimit.dailyCostMicros ?? 0 },
      recommendedExtension: {
        costMicros: Math.max(dailyOverflow, denial.request.reservedCostMicros, 1),
      },
    };
  }
  // cycle_cost / unsafe_integer：单轮费用上限（unsafe_integer 不可由 grant 修复，仍按
  // 费用上限口径询问并展示真实观测——不静默换成其他限制）。
  return {
    reason: "cost_limit",
    limitKind: "cost",
    trigger: { code, denial },
    currentLimit: { perCycleCostUsdMicros: denial.currentLimit.cycleCostMicros },
    recommendedExtension: {
      costMicros: Math.max(cycleOverflowMicros, denial.request.reservedCostMicros, 1),
    },
  };
}
