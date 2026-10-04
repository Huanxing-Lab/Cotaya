// Continuous 使用账本 SQL（CT-01）：reservation 落库与幂等结算的最小持久化。
// 准入（原子检查额度、逐次预留）由 CT-04 budgetAdmission 在此之上构建；
// 本文件只保证行完整落库与「按 requestKey 结算」两个事实。
// usage 行编解码随行存放：usage_json 是自由 JSON 事实，经 codecs 的受控入口校验。

import type { UsageRecord, UsageSettlementPatch } from "../domain/types.js";
import { decodeJsonValue, encodeJsonValue } from "./sqliteCodecs.js";
import type { UsageRow } from "./sqliteRowTypes.js";
import type { ContinuousDatabaseSync } from "./sqliteConnection.js";

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

export function settleUsageRecordReady(
  db: ContinuousDatabaseSync,
  patch: UsageSettlementPatch,
): void {
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

export function getUsageRecordReady(
  db: ContinuousDatabaseSync,
  requestKey: string,
): UsageRecord | null {
  const row = db.prepare("SELECT * FROM continuous_usage WHERE request_key = ?").get(requestKey);
  return row ? decodeUsage(row as unknown as UsageRow) : null;
}
