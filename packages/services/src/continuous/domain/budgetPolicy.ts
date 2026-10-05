// Continuous 预算领域规则（CT-04）：纯函数，无 IO、不 await 外部世界。
// 规则来源：docs/specs/continuous.md §2（默认值/Unlimited）、§6.1（grant 增量不重置消耗）、
// §9（预留计算/日窗口/unknown）。原子准入的**执行**（事务内汇总+落库）在 adapters 的
// sqliteUsageStore；本文件只提供它调用的判定与窗口数学，供 application/adapters 复用。

import type { ContinuousBudgetPolicy } from "@zcode/shared";
import type { ContinuationGrant } from "./types.js";

/**
 * 账本汇总（一段窗口/一个 Cycle 内）：已结算按实际值、未结算（reserved/unknown）按预留值。
 * CT-13 起 unknown 单列（拒绝观测的「已用/预留/unknown 三分」）；reserved 部分 =
 * unsettled - unknown，不另设第二份合计事实。
 */
export interface UsageLedgerSummary {
  settledCostMicros: number;
  unsettledCostMicros: number;
  settledTokens: number;
  unsettledTokens: number;
  /** unknown 行按预留值计入的部分（不清零、不删除，§9）。 */
  unknownCostMicros: number;
  unknownTokens: number;
}

/** 准入校验用的有效上限（已并入本轮 grant 增量；dailyCostUsdMicros null = Unlimited）。 */
export interface BudgetAdmissionLimits {
  dailyCostMicros: number | null;
  cycleCostMicros: number;
  cycleTokens: number;
}

export type BudgetAdmissionDenialLimit =
  | "daily_cost"
  | "cycle_cost"
  | "cycle_tokens"
  | "unsafe_integer";

/** 拒绝时的观测快照（AskUserQuestion 的 observedUsage 事实来源）。 */
export interface BudgetAdmissionObservation {
  cycle: UsageLedgerSummary;
  daily?: UsageLedgerSummary;
  /** 拒绝时刻的有效上限（含 grant 增量；CT-13：拒绝观测必须携带当前限额）。 */
  limits: BudgetAdmissionLimits;
  /** 本请求需求（预留值）。 */
  reservedCostMicros: number;
  reservedTokens: number;
}

export interface BudgetAdmissionDecision {
  ok: boolean;
  limitKind?: BudgetAdmissionDenialLimit;
  observed?: BudgetAdmissionObservation;
}

/**
 * 准入判定（规格 §9）：已结算估算费用 + 未结算保留额度 + 新预留 <= 当前额度。
 * 两个口径分开：cycleSummary 供单轮费用/token；dailySummary 供日费用（Unlimited 时缺席）。
 * 金额与 token 全程整数；任何一侧累加超出安全整数即拒绝（E-34：大整数无截断）。
 * Unlimited 只跳过日额度；单轮限制仍生效。
 */
export function evaluateBudgetAdmission(input: {
  cycleSummary: UsageLedgerSummary;
  dailySummary?: UsageLedgerSummary;
  limits: BudgetAdmissionLimits;
  reservedCostMicros: number;
  reservedTokens: number;
}): BudgetAdmissionDecision {
  const { cycleSummary, dailySummary, limits, reservedCostMicros, reservedTokens } = input;
  const observed: BudgetAdmissionObservation = {
    cycle: cycleSummary,
    ...(dailySummary === undefined ? {} : { daily: dailySummary }),
    limits,
    reservedCostMicros,
    reservedTokens,
  };
  const deny = (limitKind: BudgetAdmissionDenialLimit): BudgetAdmissionDecision => ({
    ok: false,
    limitKind,
    observed,
  });
  // 非法输入按拒绝处理（保守侧）：预留必须是非负安全整数。
  if (
    !Number.isSafeInteger(reservedCostMicros) ||
    reservedCostMicros < 0 ||
    !Number.isSafeInteger(reservedTokens) ||
    reservedTokens < 0
  ) {
    return deny("unsafe_integer");
  }
  if (limits.dailyCostMicros !== null) {
    const base = dailySummary ?? { settledCostMicros: 0, unsettledCostMicros: 0 };
    const dayTotal = base.settledCostMicros + base.unsettledCostMicros + reservedCostMicros;
    if (dayTotal > limits.dailyCostMicros) return deny("daily_cost");
    if (!Number.isSafeInteger(dayTotal)) return deny("unsafe_integer");
  }
  const cycleCostTotal =
    cycleSummary.settledCostMicros + cycleSummary.unsettledCostMicros + reservedCostMicros;
  if (cycleCostTotal > limits.cycleCostMicros) return deny("cycle_cost");
  if (!Number.isSafeInteger(cycleCostTotal)) return deny("unsafe_integer");
  const cycleTokenTotal =
    cycleSummary.settledTokens + cycleSummary.unsettledTokens + reservedTokens;
  if (cycleTokenTotal > limits.cycleTokens) return deny("cycle_tokens");
  if (!Number.isSafeInteger(cycleTokenTotal)) return deny("unsafe_integer");
  return { ok: true };
}

/** 把本轮全部继续 grant 的增量并入基础预算，得到准入/计时用的有效上限。不重置任何消耗量。 */
export function mergeContinuationGrants(
  budget: Pick<
    ContinuousBudgetPolicy,
    "dailyCostUsdMicros" | "perCycleCostUsdMicros" | "perCycleTokens" | "activeExecutionLimitMs"
  >,
  grants: ContinuationGrant[],
): BudgetAdmissionLimits & { activeExecutionLimitMs: number } {
  let costMicros = 0;
  let tokens = 0;
  let activeMs = 0;
  for (const grant of grants) {
    costMicros += grant.costMicros ?? 0;
    tokens += grant.tokens ?? 0;
    activeMs += grant.activeMs ?? 0;
  }
  return {
    // 日额度不因本轮 grant 扩大（规格 §6.1：仅确认受影响上限；v1 grant 只作用于单轮）。
    dailyCostMicros: budget.dailyCostUsdMicros,
    cycleCostMicros: budget.perCycleCostUsdMicros + costMicros,
    cycleTokens: budget.perCycleTokens + tokens,
    activeExecutionLimitMs: budget.activeExecutionLimitMs + activeMs,
  };
}

export interface DayWindow {
  /** 窗口起始（含），epoch ms。 */
  startMs: number;
  /** 窗口结束（不含）；DST 日为 23/25 小时，不是固定 24h。 */
  endMs: number;
  /** 窗口键（Program 时区下的本地日期 YYYY-MM-DD）。 */
  key: string;
}

function timeZoneDayKey(atMs: number, timeZone: string): string {
  // en-CA 给出 YYYY-MM-DD；只取日期事实，不引入本地化文案。
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(atMs);
}

/**
 * 求某时刻所属的 Program 时区日窗口（规格 §9：按预留时持久化的发生时间统计，后来的补结算
 * 仍归原窗口）。DST 安全：先用 Intl 取本地日期键，再在毫秒轴上二分窗口两侧边界——
 * 不用「±24h」近似（夏令时切换日会差一小时）。
 */
export function dayWindowFor(occurredAtMs: number, timeZone: string): DayWindow {
  const key = timeZoneDayKey(occurredAtMs, timeZone);
  const dayOf = (atMs: number): string => timeZoneDayKey(atMs, timeZone);
  // 起始边界：[occurredAt - 26h, occurredAt] 内最早属于 key 的时刻。occurredAt 本身属于 key，
  // 且 26h 内至多一次 false→true 转换（一天 ≤ 25h），谓词在该区间单调，二分找左界。
  let low = occurredAtMs - 26 * 3_600_000;
  let high = occurredAtMs;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dayOf(mid) === key) high = mid;
    else low = mid + 1;
  }
  const startMs = low;
  // 结束边界：[occurredAt, occurredAt + 26h] 内第一个「不再属于 key」的时刻。
  let endLow = occurredAtMs;
  let endHigh = occurredAtMs + 26 * 3_600_000;
  while (dayOf(endHigh) === key) endHigh += 3_600_000;
  while (endLow < endHigh) {
    const mid = Math.floor((endLow + endHigh) / 2);
    if (dayOf(mid) === key) endLow = mid + 1;
    else endHigh = mid;
  }
  return { startMs, endMs: endLow, key };
}

/** 校验 Program 时区可用（创建与准入前调用；非法时区在此失败，不静默回退 UTC）。 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(0);
  } catch (error) {
    throw Object.assign(new Error(`continuous program timezone 非法: ${timeZone}`), {
      kind: "invalid_timezone",
      cause: error,
    });
  }
}
