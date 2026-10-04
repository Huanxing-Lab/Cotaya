// Continuous 队列与报告导入 SQL（CT-01）：candidate/decision/关联与事件。
// applyReportImportReady 是 §5「Report 导入事件、队列修改和 cursor 同事务提交」的
// 落地点：任何一条失败（含跨 Program 复合 FK 拒绝）整体回滚，重放凭
// UNIQUE(program_id,fingerprint)/event_key 幂等不新增行（I-03）。

import { isTerminalCycleStatus } from "../domain/types.js";
import type { Candidate, ContinuousEvent, Decision, ReportImportInput } from "../domain/types.js";
import {
  decodeCandidate,
  decodeDecision,
  decodeEvent,
  encodeCandidate,
  encodeDecision,
  encodeEvent,
  type CandidateRow,
  type DecisionRow,
  type EventRow,
} from "./sqliteCodecs.js";
import { inContinuousTransaction, type ContinuousDatabaseSync } from "./sqliteConnection.js";

const CANDIDATE_UPSERT = `
  INSERT INTO continuous_candidate
    (id, program_id, source_cycle_id, fingerprint, status, body_json, execution_cycle_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (program_id, fingerprint) DO UPDATE SET
    status = excluded.status,
    body_json = excluded.body_json,
    execution_cycle_id = excluded.execution_cycle_id,
    updated_at = excluded.updated_at`;

function runCandidateUpsert(db: ContinuousDatabaseSync, candidate: Candidate): void {
  const row = encodeCandidate(candidate);
  db.prepare(CANDIDATE_UPSERT).run(
    row.id,
    row.program_id,
    row.source_cycle_id,
    row.fingerprint,
    row.status,
    row.body_json,
    row.execution_cycle_id,
    row.created_at,
    row.updated_at,
  );
}

export function saveCandidateReady(db: ContinuousDatabaseSync, candidate: Candidate): void {
  // 重复发现按 fingerprint 合并到同一行（UNIQUE(program_id,fingerprint)），
  // 不产生第二条队列记录；跨 Program 来源由复合 FK 拒绝。
  runCandidateUpsert(db, candidate);
}

export function listQueueableCandidatesReady(
  db: ContinuousDatabaseSync,
  programId: string,
): Candidate[] {
  const rows = db
    .prepare(
      `SELECT * FROM continuous_candidate
       WHERE program_id = ? AND status IN ('candidate', 'queued')
       ORDER BY created_at, id`,
    )
    .all(programId);
  return rows.map((row) => decodeCandidate(row as unknown as CandidateRow));
}

const DECISION_UPSERT = `
  INSERT INTO continuous_decision
    (id, program_id, source_cycle_id, fingerprint, version, status, body_json, resolution_json, resolved_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (program_id, fingerprint) DO UPDATE SET
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.version >= continuous_decision.version`;

export function saveDecisionReady(db: ContinuousDatabaseSync, decision: Decision): void {
  const row = encodeDecision(decision);
  const result = db
    .prepare(DECISION_UPSERT)
    .run(
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
  // ON CONFLICT 的 WHERE 拦下 version 落后的写入（changes=0 必然来自该分支）：
  // 显式抛 version_conflict，调用方必须重读最新 version 再回答（§8 resolve 防覆盖）。
  if (Number(result.changes) === 0) {
    const existing = db
      .prepare("SELECT version FROM continuous_decision WHERE program_id = ? AND fingerprint = ?")
      .get(decision.programId, decision.fingerprint) as { version: number } | undefined;
    throw Object.assign(
      new Error(
        `decision version 冲突: ${decision.id}（现存 ${existing?.version ?? "?"} > ${decision.version}）`,
      ),
      { kind: "version_conflict", currentVersion: existing?.version },
    );
  }
}

export function listPendingDecisionsReady(
  db: ContinuousDatabaseSync,
  programId: string,
): Decision[] {
  const rows = db
    .prepare("SELECT * FROM continuous_decision WHERE program_id = ? AND status = 'pending'")
    .all(programId);
  return rows.map((row) => decodeDecision(row as unknown as DecisionRow));
}

export function appendEventReady(db: ContinuousDatabaseSync, event: ContinuousEvent): void {
  const row = encodeEvent(event);
  // event_key UNIQUE：审计事件重复写入必须显式失败，导入重放走 INSERT OR IGNORE。
  db.prepare(
    `INSERT INTO continuous_event (program_id, cycle_id, event_key, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.program_id, row.cycle_id, row.event_key, row.type, row.payload_json, row.created_at);
}

export function listEventsReady(db: ContinuousDatabaseSync, programId: string): ContinuousEvent[] {
  const rows = db
    .prepare("SELECT * FROM continuous_event WHERE program_id = ? ORDER BY id")
    .all(programId);
  return rows.map((row) => decodeEvent(row as unknown as EventRow));
}

/** 同 Cycle 的已导入事件（CT-05 done 门槛的跨批次读回；type 过滤可选）。 */
export function listCycleEventsReady(
  db: ContinuousDatabaseSync,
  programId: string,
  cycleId: string,
  type?: string,
): ContinuousEvent[] {
  const rows = (
    type === undefined
      ? db
          .prepare(
            "SELECT * FROM continuous_event WHERE program_id = ? AND cycle_id = ? ORDER BY id",
          )
          .all(programId, cycleId)
      : db
          .prepare(
            "SELECT * FROM continuous_event WHERE program_id = ? AND cycle_id = ? AND type = ? ORDER BY id",
          )
          .all(programId, cycleId, type)
  ) as unknown[];
  return rows.map((row) => decodeEvent(row as EventRow));
}

export function applyReportImportReady(db: ContinuousDatabaseSync, input: ReportImportInput): void {
  inContinuousTransaction(db, () => {
    // 归属校验先于任何写入：cycle 必须属于同一 Program，跨 Program 输入立即拒绝。
    const cycle = db
      .prepare("SELECT id, status FROM continuous_cycle WHERE id = ? AND program_id = ?")
      .get(input.cycleId, input.programId) as { id: string; status: string } | undefined;
    if (!cycle)
      throw Object.assign(new Error(`continuous_cycle 不属于该 program: ${input.cycleId}`), {
        kind: "cycle_program_mismatch",
      });
    if (isTerminalCycleStatus(cycle.status as Parameters<typeof isTerminalCycleStatus>[0]))
      throw Object.assign(new Error(`终态 cycle 不接受报告导入: ${input.cycleId}`), {
        kind: "cycle_terminal",
      });
    for (const item of input.items) {
      if (item.candidate) runCandidateUpsert(db, item.candidate);
      if (item.decision) saveDecisionReady(db, item.decision);
      if (item.candidateDecisionLink) {
        const link = item.candidateDecisionLink;
        db.prepare(
          `INSERT INTO continuous_candidate_decision (program_id, candidate_id, decision_id)
           VALUES (?, ?, ?)
           ON CONFLICT (candidate_id, decision_id) DO NOTHING`,
        ).run(link.programId, link.candidateId, link.decisionId);
      }
      if (item.event) {
        const row = encodeEvent(item.event);
        // 重放去重：同 event_key 的事件不重复入库（I-03「重复不新增」）。
        db.prepare(
          `INSERT INTO continuous_event (program_id, cycle_id, event_key, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_key) DO NOTHING`,
        ).run(
          row.program_id,
          row.cycle_id,
          row.event_key,
          row.type,
          row.payload_json,
          row.created_at,
        );
      }
    }
    const result = db
      .prepare("UPDATE continuous_cycle SET report_cursor = ? WHERE id = ? AND program_id = ?")
      .run(input.nextCursor, input.cycleId, input.programId);
    if (Number(result.changes) !== 1)
      throw Object.assign(new Error(`report cursor 更新失败: ${input.cycleId}`), {
        kind: "not_found",
      });
  });
}
