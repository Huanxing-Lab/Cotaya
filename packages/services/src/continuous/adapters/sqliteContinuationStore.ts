// Continuous 继续确认 SQL（CT-04）：continuous_continuation_request 的落库与读取。
// 规格 §5/§6.1：同 Cycle 至多一条 pending（部分唯一索引兜底，不靠内存锁）；version 乐观
// 并发（重复/旧 version 回答拒绝）；本轮 grant 是已 resolved 请求的增量快照，准入只读。
// 行编解码在本文件内（sqliteCodecs 已到行数上限）：schema 与领域类型同源，不复制第二份词表。

import { z } from "zod";
import type { ContinuationGrant, ContinuationRequest } from "../domain/types.js";
import { inContinuousTransaction, type ContinuousDatabaseSync } from "./sqliteConnection.js";

// ── JSON 字段 schema（运行时校验；词表复用领域类型推导）──

const continuationReasonSchema = z.enum([
  "cost_limit",
  "token_limit",
  "time_limit",
  "change_limit",
  "retry_limit",
  "resume_limit",
  "suspected_hang",
  "health_unknown",
]);

const continuationLimitKindSchema = z.enum([
  "cost",
  "token",
  "time",
  "change",
  "retry",
  "resume",
  "health",
]);

const continuationGrantSchema = z.strictObject({
  costMicros: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  activeMs: z.number().int().positive().optional(),
});

const continuationResolutionSchema = z.strictObject({
  kind: z.enum(["continue_with_grant", "adjust_config_and_continue", "stay_paused", "end_cycle"]),
  resolvedAt: z.number().int().nonnegative(),
  grant: continuationGrantSchema.optional(),
  configAdjustment: z
    .strictObject({
      perCycleCostUsdMicros: z.number().int().positive().optional(),
      perCycleTokens: z.number().int().positive().optional(),
      activeExecutionLimitMs: z.number().int().positive().optional(),
      dailyCostUsdMicros: z.number().int().positive().nullable().optional(),
    })
    .optional(),
});

/**
 * request_json：limitKind 与 reasons 一起入体（CT-01 建表没有独立列，规格 §5 的字段清单
 * 同样只列 reason/status/request_json）；observedUsage/currentLimit/recommendedExtension
 * 是自由 JSON 事实（展示用）。
 */
const continuationRequestBodySchema = z.strictObject({
  limitKind: continuationLimitKindSchema,
  reasons: z.array(continuationReasonSchema).min(1),
  observedUsage: z.unknown(),
  currentLimit: z.unknown(),
  recommendedExtension: z.unknown(),
});

interface ContinuationRow {
  id: string;
  program_id: string;
  cycle_id: string;
  reason: string;
  version: number;
  status: string;
  request_json: string;
  resolution_json: string | null;
  created_at: number;
  resolved_at: number | null;
}

function codecError(field: string, cause: unknown): Error {
  return Object.assign(new Error(`continuous sqlite codec: ${field} 校验失败`), {
    kind: "continuous_codec_invalid",
    field,
    cause,
  });
}

function parseJson<T>(field: string, schema: z.ZodType<T>, raw: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw codecError(field, error);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw codecError(field, parsed.error);
  return parsed.data;
}

function encodeContinuation(request: ContinuationRequest): ContinuationRow {
  const body = continuationRequestBodySchema.safeParse({
    limitKind: request.limitKind,
    reasons: request.reasons,
    observedUsage: request.observedUsage,
    currentLimit: request.currentLimit,
    recommendedExtension: request.recommendedExtension,
  });
  if (!body.success) throw codecError("request_json", body.error);
  return {
    id: request.id,
    program_id: request.programId,
    cycle_id: request.cycleId,
    reason: request.reason,
    version: request.version,
    status: request.status,
    request_json: JSON.stringify(body.data),
    resolution_json:
      request.resolution === undefined
        ? null
        : (() => {
            const parsed = continuationResolutionSchema.safeParse(request.resolution);
            if (!parsed.success) throw codecError("resolution_json", parsed.error);
            return JSON.stringify(parsed.data);
          })(),
    created_at: request.createdAt,
    resolved_at: request.resolvedAt ?? null,
  };
}

function decodeContinuation(row: ContinuationRow): ContinuationRequest {
  const body = parseJson("request_json", continuationRequestBodySchema, row.request_json);
  return {
    id: row.id,
    programId: row.program_id,
    cycleId: row.cycle_id,
    reason: row.reason as ContinuationRequest["reason"],
    limitKind: body.limitKind,
    reasons: body.reasons,
    observedUsage: body.observedUsage,
    currentLimit: body.currentLimit,
    recommendedExtension: body.recommendedExtension,
    version: row.version,
    status: row.status as ContinuationRequest["status"],
    resolution:
      row.resolution_json === null
        ? undefined
        : parseJson("resolution_json", continuationResolutionSchema, row.resolution_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export function insertContinuationRequestReady(
  db: ContinuousDatabaseSync,
  request: ContinuationRequest,
): void {
  const row = encodeContinuation(request);
  db.prepare(
    `INSERT INTO continuous_continuation_request
     (id, program_id, cycle_id, reason, version, status, request_json,
      resolution_json, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.program_id,
    row.cycle_id,
    row.reason,
    row.version,
    row.status,
    row.request_json,
    row.resolution_json,
    row.created_at,
    row.resolved_at,
  );
}

export function getContinuationRequestReady(
  db: ContinuousDatabaseSync,
  requestId: string,
): ContinuationRequest | null {
  const row = db
    .prepare("SELECT * FROM continuous_continuation_request WHERE id = ?")
    .get(requestId);
  return row ? decodeContinuation(row as unknown as ContinuationRow) : null;
}

export function getPendingContinuationRequestReady(
  db: ContinuousDatabaseSync,
  cycleId: string,
): ContinuationRequest | null {
  const row = db
    .prepare(
      "SELECT * FROM continuous_continuation_request WHERE cycle_id = ? AND status = 'pending'",
    )
    .get(cycleId);
  return row ? decodeContinuation(row as unknown as ContinuationRow) : null;
}

/** 乐观 version：行 version 领先于携带值（另一回答已前进）时拒绝覆盖。 */
export function saveContinuationRequestReady(
  db: ContinuousDatabaseSync,
  request: ContinuationRequest,
): void {
  const row = encodeContinuation(request);
  inContinuousTransaction(db, () => {
    const stored = db
      .prepare("SELECT version FROM continuous_continuation_request WHERE id = ?")
      .get(request.id) as { version: number } | undefined;
    if (!stored)
      throw Object.assign(new Error(`continuation request 不存在: ${request.id}`), {
        kind: "not_found",
      });
    if (stored.version > request.version)
      throw Object.assign(new Error(`continuation request version 冲突: ${request.id}`), {
        kind: "version_conflict",
      });
    const result = db
      .prepare(
        `UPDATE continuous_continuation_request
         SET reason = ?, version = ?, status = ?, request_json = ?,
             resolution_json = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(
        row.reason,
        row.version,
        row.status,
        row.request_json,
        row.resolution_json,
        row.resolved_at,
        row.id,
      );
    if (Number(result.changes) !== 1)
      throw Object.assign(new Error(`continuation request 不存在: ${request.id}`), {
        kind: "not_found",
      });
  });
}

/** 本轮全部已 resolved 请求携带的 grant（准入的增量来源；不重置消耗量）。 */
export function listCycleContinuationGrantsReady(
  db: ContinuousDatabaseSync,
  cycleId: string,
): ContinuationGrant[] {
  const rows = db
    .prepare(
      "SELECT * FROM continuous_continuation_request WHERE cycle_id = ? AND status = 'resolved'",
    )
    .all(cycleId) as unknown as ContinuationRow[];
  const grants: ContinuationGrant[] = [];
  for (const row of rows) {
    const request = decodeContinuation(row);
    if (request.resolution?.grant !== undefined) grants.push(request.resolution.grant);
  }
  return grants;
}
