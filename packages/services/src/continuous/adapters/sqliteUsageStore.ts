// Continuous 使用账本 SQL（CT-01 建表 / CT-04 准入）。
// 职责：
//   - reservation 落库与**幂等**结算（规格 §9：晚到/重复 usage 按 requestKey 幂等——
//     同值重放 no-op，不同值冲突拒绝；R-07「重复结算最多一次」）；
//   - unknown 标记（无 usage 证据的终局保留 reservation，不清零、不删除）；
//   - 原子准入（I-07/E-33）：事务内 SUM 账本 → 领域判定（budgetPolicy 纯函数）→ INSERT，
//     三者同一 BEGIN IMMEDIATE 事务，并发请求不超发，不靠内存锁。
// usage 行编解码随行存放：usage_json 是自由 JSON 事实，经 codecs 的受控入口校验。

import type { UsageRecord, UsageSettlementPatch } from "../domain/types.js";
import {
  evaluateBudgetAdmission,
  type BudgetAdmissionDenialLimit,
  type BudgetAdmissionLimits,
  type UsageLedgerSummary,
} from "../domain/budgetPolicy.js";
import { decodeJsonValue, encodeJsonValue } from "./sqliteCodecs.js";
import type { UsageRow } from "./sqliteRowTypes.js";
import {
  inContinuousTransaction,
  isSqliteConstraintError,
  type ContinuousDatabaseSync,
} from "./sqliteConnection.js";

function encodeUsage(record: UsageRecord): UsageRow {
  return {
    id: record.id,
    cycle_id: record.cycleId,
    request_key: record.requestKey,
    state: record.state,
    provider: record.provider,
    model: record.model,
    pricing_version: record.pricingVersion,
    usage_json: record.usage === undefined ? null : encodeJsonValue("usage_json", record.usage),
    reserved_cost_micros: record.reservedCostMicros,
    estimated_cost_micros: record.estimatedCostMicros ?? null,
    reserved_tokens: record.reservedTokens,
    actual_tokens: record.actualTokens ?? null,
    occurred_at: record.occurredAt,
    updated_at: record.updatedAt,
  };
}

function decodeUsage(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    requestKey: row.request_key,
    state: row.state as UsageRecord["state"],
    provider: row.provider,
    model: row.model,
    pricingVersion: row.pricing_version,
    usage: row.usage_json === null ? undefined : decodeJsonValue("usage_json", row.usage_json),
    reservedCostMicros: row.reserved_cost_micros,
    estimatedCostMicros: row.estimated_cost_micros ?? undefined,
    reservedTokens: row.reserved_tokens,
    actualTokens: row.actual_tokens ?? undefined,
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
  };
}

export function insertUsageRecordReady(db: ContinuousDatabaseSync, record: UsageRecord): void {
  const row = encodeUsage(record);
  db.prepare(
    `INSERT INTO continuous_usage
     (id, cycle_id, request_key, state, provider, model, pricing_version, usage_json,
      reserved_cost_micros, estimated_cost_micros, reserved_tokens, actual_tokens,
      occurred_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.cycle_id,
    row.request_key,
    row.state,
    row.provider,
    row.model,
    row.pricing_version,
    row.usage_json,
    row.reserved_cost_micros,
    row.estimated_cost_micros,
    row.reserved_tokens,
    row.actual_tokens,
    row.occurred_at,
    row.updated_at,
  );
}

/**
 * 幂等结算：reserved/unknown → settled；已 settled 且同值 → no-op（晚到重放，R-07）；
 * 已 settled 且不同值 → already_settled 冲突（同一 requestKey 两份 usage 是账本错误，大声失败）。
 */
export function settleUsageRecordReady(
  db: ContinuousDatabaseSync,
  patch: UsageSettlementPatch,
): void {
  const existing = getUsageRecordReady(db, patch.requestKey);
  if (existing === null) {
    throw Object.assign(new Error(`usage reservation 不存在: ${patch.requestKey}`), {
      kind: "not_found",
    });
  }
  if (existing.state === "settled") {
    if (
      existing.actualTokens === patch.actualTokens &&
      existing.estimatedCostMicros === patch.estimatedCostMicros
    ) {
      return;
    }
    throw Object.assign(
      new Error(`usage reservation 已按不同值结算，拒绝重复结算: ${patch.requestKey}`),
      { kind: "already_settled" },
    );
  }
  const result = db
    .prepare(
      `UPDATE continuous_usage
       SET state = 'settled', actual_tokens = ?, estimated_cost_micros = ?, usage_json = ?,
           updated_at = ?
       WHERE request_key = ?`,
    )
    .run(
      patch.actualTokens,
      patch.estimatedCostMicros,
      patch.usage === undefined ? null : encodeJsonValue("usage_json", patch.usage),
      patch.updatedAt,
      patch.requestKey,
    );
  if (Number(result.changes) !== 1)
    throw Object.assign(new Error(`usage reservation 不存在: ${patch.requestKey}`), {
      kind: "not_found",
    });
}

/** unknown 标记：仅 reserved → unknown；settled/unknown 原样（幂等，不清零不删行）。 */
export function markUsageUnknownReady(
  db: ContinuousDatabaseSync,
  requestKey: string,
  updatedAt: number,
): void {
  db.prepare(
    `UPDATE continuous_usage SET state = 'unknown', updated_at = ?
     WHERE request_key = ? AND state = 'reserved'`,
  ).run(updatedAt, requestKey);
}

export function getUsageRecordReady(
  db: ContinuousDatabaseSync,
  requestKey: string,
): UsageRecord | null {
  const row = db.prepare("SELECT * FROM continuous_usage WHERE request_key = ?").get(requestKey);
  return row ? decodeUsage(row as unknown as UsageRow) : null;
}

interface UsageSumRow {
  settled_cost: number | null;
  unsettled_cost: number | null;
  settled_tokens: number | null;
  unsettled_tokens: number | null;
}

/**
 * 账本汇总（规格 §9 计算式）：settled 行计 estimated/actual，reserved+unknown 行计预留。
 * program 范围经 cycle JOIN 过滤（日窗口是 Program 级事实）；窗口按 occurred_at（预留时
 * 持久化的发生时间）——晚到补结算不改行归属窗口。
 */
export function summarizeUsageReady(
  db: ContinuousDatabaseSync,
  query: {
    programId: string;
    cycleId?: string;
    windowFromMs?: number;
    windowToMs?: number;
  },
): UsageLedgerSummary {
  const conditions = ["c.program_id = ?"];
  const params: (string | number)[] = [query.programId];
  if (query.cycleId !== undefined) {
    conditions.push("u.cycle_id = ?");
    params.push(query.cycleId);
  }
  if (query.windowFromMs !== undefined) {
    conditions.push("u.occurred_at >= ?");
    params.push(query.windowFromMs);
  }
  if (query.windowToMs !== undefined) {
    conditions.push("u.occurred_at < ?");
    params.push(query.windowToMs);
  }
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN u.state = 'settled' THEN u.estimated_cost_micros ELSE 0 END) AS settled_cost,
         SUM(CASE WHEN u.state != 'settled' THEN u.reserved_cost_micros ELSE 0 END) AS unsettled_cost,
         SUM(CASE WHEN u.state = 'settled' THEN u.actual_tokens ELSE 0 END) AS settled_tokens,
         SUM(CASE WHEN u.state != 'settled' THEN u.reserved_tokens ELSE 0 END) AS unsettled_tokens
       FROM continuous_usage u
       JOIN continuous_cycle c ON c.id = u.cycle_id
       WHERE ${conditions.join(" AND ")}`,
    )
    .get(...params) as UsageSumRow | undefined;
  return {
    settledCostMicros: row?.settled_cost ?? 0,
    unsettledCostMicros: row?.unsettled_cost ?? 0,
    settledTokens: row?.settled_tokens ?? 0,
    unsettledTokens: row?.unsettled_tokens ?? 0,
  };
}

export type UsageReservationAdmission =
  | { status: "admitted"; record: UsageRecord }
  | {
      status: "denied";
      denial: {
        limitKind: BudgetAdmissionDenialLimit;
        cycleSummary: UsageLedgerSummary;
        dailySummary?: UsageLedgerSummary;
      };
    };

/**
 * 原子准入：BEGIN IMMEDIATE 事务内「汇总（单轮 + 日窗口两个口径）→ 领域判定 → INSERT」。
 * 拒绝是业务结果：整体回滚后返回 denial（含观测快照，AskUserQuestion 的事实来源）。
 * UNIQUE(request_key) 兜底重复 requestKey（约束冲突映射 duplicate_request_key——幂等重发
 * 同一 requestKey 的调用方应先 getUsageRecord 判重）。
 */
export function admitUsageReservationReady(
  db: ContinuousDatabaseSync,
  input: {
    programId: string;
    reservation: UsageRecord;
    limits: BudgetAdmissionLimits;
    window: { fromMs: number; toMs: number };
  },
): UsageReservationAdmission {
  return inContinuousTransaction(db, () => {
    const cycleSummary = summarizeUsageReady(db, {
      programId: input.programId,
      cycleId: input.reservation.cycleId,
    });
    const dailySummary =
      input.limits.dailyCostMicros === null
        ? undefined
        : summarizeUsageReady(db, {
            programId: input.programId,
            windowFromMs: input.window.fromMs,
            windowToMs: input.window.toMs,
          });
    const decision = evaluateBudgetAdmission({
      cycleSummary,
      ...(dailySummary === undefined ? {} : { dailySummary }),
      limits: input.limits,
      reservedCostMicros: input.reservation.reservedCostMicros,
      reservedTokens: input.reservation.reservedTokens,
    });
    if (!decision.ok) {
      return {
        status: "denied",
        denial: {
          // evaluateBudgetAdmission 拒绝时恒带 limitKind；缺席只可能是实现漂移，保守按 unsafe。
          limitKind: decision.limitKind ?? "unsafe_integer",
          cycleSummary,
          ...(dailySummary === undefined ? {} : { dailySummary }),
        },
      };
    }
    try {
      insertUsageRecordReady(db, input.reservation);
    } catch (error) {
      if (isSqliteConstraintError(error))
        throw Object.assign(new Error(`usage request_key 重复: ${input.reservation.requestKey}`), {
          kind: "duplicate_request_key",
          cause: error,
        });
      throw error;
    }
    return { status: "admitted", record: input.reservation };
  });
}
