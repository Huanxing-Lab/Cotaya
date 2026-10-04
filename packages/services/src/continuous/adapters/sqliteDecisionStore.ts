// Continuous 决策 SQL（CT-06）：fingerprint 去重合并、按 id 读取、候选关联读取与
// versioned resolve/dismiss 的同事务落库。
//
// 规格来源：docs/specs/continuous.md §8——重复发现按 fingerprint 合并到一行（追加来源与
// 证据、终态不重开）；resolution 和相关入队事件同事务保存；Dismiss 不授权实施（关联的
// 未终态候选一并 rejected，同事务）。
//
// 事务边界：本文件的 *Ready 函数不自行开事务——saveDecisionMergeReady 由调用方的事务
// 包住（applyReportImport 的导入事务或 repository.saveDecision 的独立事务）；
// applyDecisionResolutionReady 整体是一个事务（resolution/事件/候选状态一起提交或回滚）。
// 合并是读-改-写，靠外层事务保证原子（BEGIN IMMEDIATE 串行写者，同 CT-01 其余 store）。

import { mergeDecisionOnRediscovery } from "../domain/decisionPolicy.js";
import type { ContinuousEvent, Decision } from "../domain/types.js";
import {
  decodeJson,
  decisionBodySchema,
  decisionResolutionSchema,
  encodeJson,
  type DecisionRow,
} from "./sqliteCodecs.js";
import { inContinuousTransaction, type ContinuousDatabaseSync } from "./sqliteConnection.js";

// ── decision 行编解码（自 sqliteCodecs 移入：该文件到行数上限，同 CT-04 把 continuation
// 编解码移入对应 store 的先例；schema 仍在 sqliteCodecs 的 JSON 字段 schema 区）──

export function encodeDecision(decision: Decision): DecisionRow {
  return {
    id: decision.id,
    program_id: decision.programId,
    source_cycle_id: decision.sourceCycleId,
    fingerprint: decision.fingerprint,
    version: decision.version,
    status: decision.status,
    body_json: encodeJson("body_json", decisionBodySchema, {
      title: decision.title,
      context: decision.context,
      options: decision.options,
      recommendation: decision.recommendation,
      classification: decision.classification,
      blockingScope: decision.blockingScope,
      ...(decision.sources === undefined ? {} : { sources: decision.sources }),
    }),
    resolution_json: decision.resolution
      ? encodeJson("resolution_json", decisionResolutionSchema, decision.resolution)
      : null,
    resolved_at: decision.resolution?.resolvedAt ?? null,
    created_at: decision.createdAt,
    updated_at: decision.updatedAt,
  };
}

export function decodeDecision(row: DecisionRow): Decision {
  const body = decodeJson("body_json", decisionBodySchema, row.body_json);
  return {
    id: row.id,
    programId: row.program_id,
    sourceCycleId: row.source_cycle_id,
    fingerprint: row.fingerprint,
    version: row.version,
    ...body,
    status: row.status as Decision["status"],
    resolution: row.resolution_json
      ? decodeJson("resolution_json", decisionResolutionSchema, row.resolution_json)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 保存（或合并）一条决策：同 (program_id, fingerprint) 已有行时按 CT-06 合并语义并入
 * （来源/证据追加、blockingScope 并集、状态与 version 保持现存值），否则插入新行。
 * 与旧 upsert 的关键差异：重复发现**不再**整行覆盖 body，也**不再**对 version 落后的
 * 写入抛 version_conflict——那是 resolve 写入（applyDecisionResolutionReady）的守卫，
 * 观察侧的重复发现不参与乐观并发。
 */
export function saveDecisionMergeReady(db: ContinuousDatabaseSync, decision: Decision): void {
  const existingRow = db
    .prepare("SELECT * FROM continuous_decision WHERE program_id = ? AND fingerprint = ?")
    .get(decision.programId, decision.fingerprint) as DecisionRow | undefined;
  const row = encodeDecision(
    existingRow === undefined
      ? decision
      : mergeDecisionOnRediscovery(decodeDecision(existingRow), decision),
  );
  if (existingRow === undefined) {
    db.prepare(
      `INSERT INTO continuous_decision
        (id, program_id, source_cycle_id, fingerprint, version, status, body_json,
         resolution_json, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.program_id,
      row.source_cycle_id,
      row.fingerprint,
      row.version,
      row.status,
      row.body_json,
      row.resolution_json,
      row.resolved_at,
      row.created_at,
      row.updated_at,
    );
    return;
  }
  db.prepare(
    `UPDATE continuous_decision SET
       version = ?, status = ?, body_json = ?, resolution_json = ?, resolved_at = ?, updated_at = ?
     WHERE program_id = ? AND fingerprint = ?`,
  ).run(
    row.version,
    row.status,
    row.body_json,
    row.resolution_json,
    row.resolved_at,
    row.updated_at,
    row.program_id,
    row.fingerprint,
  );
}

export function getDecisionReady(db: ContinuousDatabaseSync, decisionId: string): Decision | null {
  const row = db.prepare("SELECT * FROM continuous_decision WHERE id = ?").get(decisionId) as
    | DecisionRow
    | undefined;
  return row === undefined ? null : decodeDecision(row);
}

/** 决策→候选关联（continuous_candidate_decision）；resolve/dismiss 的候选处置输入。 */
export function listDecisionCandidateLinksReady(
  db: ContinuousDatabaseSync,
  decisionId: string,
): Array<{ candidateId: string }> {
  const rows = db
    .prepare("SELECT candidate_id FROM continuous_candidate_decision WHERE decision_id = ?")
    .all(decisionId) as Array<{ candidate_id: string }>;
  return rows.map((row) => ({ candidateId: row.candidate_id }));
}

/** resolve/dismiss 落库输入：decision 为已组好的下一状态（version+1、resolution 就位）。 */
export interface DecisionResolutionApplyInput {
  programId: string;
  decision: Decision;
  /** 同事务写入的审计事件（resolution 与入队事件同事务，§8）。 */
  events: ContinuousEvent[];
  /**
   * dismiss 时关联未终态候选的处置：reject_blocked（不授权实施——rejected 同事务落库）；
   * resolve 只记入队事件，候选本就在队列（每轮选择期过滤，§8「进入未来 Cycle」）。
   */
  candidateDisposition: "requeue_future_cycles" | "reject_blocked";
}

export interface DecisionResolutionApplyResult {
  /** dismiss 实际落为 rejected 的候选 id（resolve 恒空）。 */
  rejectedCandidateIds: string[];
}

/**
 * versioned resolve/dismiss 的同事务落库：
 *   1. 乐观并发守卫：UPDATE ... WHERE id AND version = decision.version - 1——并发窗口内
 *      已被他人回答的行 changes=0，抛 version_conflict（调用方须重读再回答）；
 *   2. 事件逐条写入（event_key UNIQUE 幂等，重放不新增）；
 *   3. dismiss：读关联候选，未终态者 status='rejected'（body 不改——拒绝原因是决策侧事实，
 *      记在事件里），终态（done/rejected）保持不动。
 * 任何一步失败整体回滚：不出现「resolution 已保存但事件/候选没跟上」的半截状态。
 */
export function applyDecisionResolutionReady(
  db: ContinuousDatabaseSync,
  input: DecisionResolutionApplyInput,
): DecisionResolutionApplyResult {
  return inContinuousTransaction(db, () => {
    const row = encodeDecision(input.decision);
    const guard = db
      .prepare(
        `UPDATE continuous_decision SET
           version = ?, status = ?, body_json = ?, resolution_json = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND program_id = ? AND version = ?`,
      )
      .run(
        row.version,
        row.status,
        row.body_json,
        row.resolution_json,
        row.resolved_at,
        row.updated_at,
        row.id,
        row.program_id,
        row.version - 1,
      );
    if (Number(guard.changes) !== 1) {
      const existing = db
        .prepare("SELECT version FROM continuous_decision WHERE id = ?")
        .get(row.id) as { version: number } | undefined;
      throw Object.assign(
        new Error(
          `decision version 冲突: ${input.decision.id}（现存 ${existing?.version ?? "?"}，` +
            `携带基准 ${row.version - 1}）`,
        ),
        { kind: "version_conflict", currentVersion: existing?.version },
      );
    }

    for (const event of input.events) {
      db.prepare(
        `INSERT INTO continuous_event (program_id, cycle_id, event_key, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_key) DO NOTHING`,
      ).run(
        event.programId,
        event.cycleId ?? null,
        event.eventKey,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt,
      );
    }

    const rejectedCandidateIds: string[] = [];
    if (input.candidateDisposition === "reject_blocked") {
      const links = listDecisionCandidateLinksReady(db, input.decision.id);
      for (const link of links) {
        // status 谓词直接放進 SQL WHERE（未终态才落 rejected；done/rejected 不动）。
        const updated = db
          .prepare(
            `UPDATE continuous_candidate SET status = 'rejected', updated_at = ?
             WHERE id = ? AND status IN ('candidate', 'queued', 'implementing', 'deferred')`,
          )
          .run(input.decision.resolution?.resolvedAt ?? input.decision.updatedAt, link.candidateId);
        if (Number(updated.changes) === 1) rejectedCandidateIds.push(link.candidateId);
      }
    }
    return { rejectedCandidateIds };
  });
}
