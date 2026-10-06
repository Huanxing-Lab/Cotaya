// Continuous 终态结算与 workspace 租约 SQL（CT-01）。
// completeCycleReady：§5「Cycle 结束、Program 失败计数和 nextCycleAt 同事务提交」，
// 任一 UPDATE 未命中即整体回滚（I-03/R-08 的存储层前提）。
// 租约：epoch 单调不减；正常释放 cycle/owner/expiry 同时置空而 epoch 保留（§5/§10），
// CHECK 约束兜底「三者同有或同空」，不把 expires_at 当进程死亡证明。

import { isTerminalCycleStatus } from "../domain/types.js";
import type { Cycle, ProgramCompletionPatch, WorkspaceLease } from "../domain/types.js";
import { CONTINUOUS_OPEN_CYCLE_STATUSES } from "@zcode/shared";
import { decodeCycle, encodeCycle } from "./sqliteCodecs.js";
import type { CycleRow, LeaseRow } from "./sqliteRowTypes.js";
import {
  inContinuousTransaction,
  updateRowByKey,
  type ContinuousDatabaseSync,
} from "./sqliteConnection.js";

// ── Cycle 读面（自 sqliteRepository.ts 移入：repository 文件行数超架构上限；移动不是
// 复制，SQL 与解码逐字保持）──

export function getOpenCycleReady(db: ContinuousDatabaseSync, programId: string): Cycle | null {
  const statuses = CONTINUOUS_OPEN_CYCLE_STATUSES as readonly string[];
  const placeholders = statuses.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT * FROM continuous_cycle WHERE program_id = ? AND status IN (${placeholders})`)
    .get(programId, ...statuses);
  return row ? decodeCycle(row as unknown as CycleRow) : null;
}

/**
 * CT-16：按执行会话反查 Cycle——重启后 wire 端口会话路由的持久化事实源（实例内
 * session→workspace 映射只活到进程退出；§10「恢复前从持久化快照重建」的读侧配套）。
 * 同会话优先未结束行（执行会话按 Cycle 独占，这里只是确定性兜底）。
 */
export function getCycleByExecutionSessionReady(
  db: ContinuousDatabaseSync,
  executionSessionId: string,
): Cycle | null {
  const statuses = CONTINUOUS_OPEN_CYCLE_STATUSES as readonly string[];
  const placeholders = statuses.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT * FROM continuous_cycle WHERE execution_session_id = ? ` +
        `ORDER BY (status IN (${placeholders})) DESC, created_at DESC LIMIT 1`,
    )
    .get(executionSessionId, ...statuses);
  return row ? decodeCycle(row as unknown as CycleRow) : null;
}

export function getCycleByTriggerKeyReady(
  db: ContinuousDatabaseSync,
  programId: string,
  triggerKey: string,
): Cycle | null {
  const row = db
    .prepare("SELECT * FROM continuous_cycle WHERE program_id = ? AND trigger_key = ?")
    .get(programId, triggerKey);
  return row ? decodeCycle(row as unknown as CycleRow) : null;
}

export function getLatestCycleSequenceReady(db: ContinuousDatabaseSync, programId: string): number {
  const row = db
    .prepare("SELECT MAX(sequence) AS latest FROM continuous_cycle WHERE program_id = ?")
    .get(programId) as { latest: number | null };
  return row.latest ?? 0;
}

/** CT-08 UI 详情页读面：sequence 倒序的最近行（含终态）；limit 上限防误查全表。 */
export function listRecentCyclesReady(
  db: ContinuousDatabaseSync,
  programId: string,
  limit: number,
): Cycle[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const rows = db
    .prepare("SELECT * FROM continuous_cycle WHERE program_id = ? ORDER BY sequence DESC LIMIT ?")
    .all(programId, boundedLimit);
  return rows.map((row) => decodeCycle(row as unknown as CycleRow));
}

// lease 行没有 JSON 字段，纯列映射随租约 SQL 存放（specs §5：释放后 epoch 保留）。
function decodeLease(row: LeaseRow): WorkspaceLease {
  return {
    workspaceKey: row.workspace_key,
    cycleId: row.cycle_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    epoch: row.epoch,
    expiresAt: row.expires_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function completeCycleReady(
  db: ContinuousDatabaseSync,
  cycle: Cycle,
  programPatch: ProgramCompletionPatch,
): void {
  // 防御性终态校验：状态迁移合法性由 service/领域层负责，这里拒绝明显违规的组合。
  if (!isTerminalCycleStatus(cycle.status))
    throw Object.assign(new Error(`cycle 尚未终态，不能结算: ${cycle.id}`), {
      kind: "cycle_not_terminal",
    });
  inContinuousTransaction(db, () => {
    if (updateRowByKey(db, "continuous_cycle", encodeCycle(cycle), "id") !== 1)
      throw Object.assign(new Error(`continuous_cycle 不存在: ${cycle.id}`), {
        kind: "not_found",
      });
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (programPatch.status !== undefined) {
      sets.push("status = ?");
      args.push(programPatch.status);
    }
    if (programPatch.statusReason !== undefined) {
      sets.push("status_reason = ?");
      args.push(programPatch.statusReason);
    }
    if (programPatch.nextCycleAt !== undefined) {
      sets.push("next_cycle_at = ?");
      args.push(programPatch.nextCycleAt);
    }
    if (programPatch.lastCycleAt !== undefined) {
      sets.push("last_cycle_at = ?");
      args.push(programPatch.lastCycleAt);
    }
    if (programPatch.consecutiveFailures !== undefined) {
      sets.push("consecutive_failures = ?");
      args.push(programPatch.consecutiveFailures);
    }
    sets.push("updated_at = ?");
    args.push(programPatch.updatedAt, cycle.programId);
    const programResult = db
      .prepare(`UPDATE continuous_program SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    if (Number(programResult.changes) !== 1)
      throw Object.assign(new Error(`continuous_program 不存在: ${cycle.programId}`), {
        kind: "not_found",
      });
  });
}

export function getLeaseReady(
  db: ContinuousDatabaseSync,
  workspaceKey: string,
): WorkspaceLease | null {
  const row = db
    .prepare("SELECT * FROM continuous_workspace_lease WHERE workspace_key = ?")
    .get(workspaceKey);
  return row ? decodeLease(row as unknown as LeaseRow) : null;
}

export function acquireLeaseReady(db: ContinuousDatabaseSync, lease: WorkspaceLease): void {
  const { cycleId, ownerId, expiresAt } = lease;
  if (cycleId === undefined || ownerId === undefined || expiresAt === undefined)
    throw Object.assign(new Error("acquire 租约必须同时提供 cycle/owner/expiry"), {
      kind: "lease_invalid",
    });
  inContinuousTransaction(db, () => {
    const existing = db
      .prepare("SELECT epoch FROM continuous_workspace_lease WHERE workspace_key = ?")
      .get(lease.workspaceKey) as { epoch: number } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO continuous_workspace_lease
         (workspace_key, cycle_id, owner_id, epoch, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(lease.workspaceKey, cycleId, ownerId, lease.epoch, expiresAt, lease.updatedAt);
      return;
    }
    // epoch 单调：接管必须携带更大的 epoch；相等或回退一律拒绝，防止旧执行者覆盖新占用。
    if (lease.epoch <= existing.epoch)
      throw Object.assign(
        new Error(
          `lease epoch 冲突: 期望 > ${existing.epoch}，收到 ${lease.epoch}（${lease.workspaceKey}）`,
        ),
        { kind: "epoch_conflict" },
      );
    const result = db
      .prepare(
        `UPDATE continuous_workspace_lease
         SET cycle_id = ?, owner_id = ?, epoch = ?, expires_at = ?, updated_at = ?
         WHERE workspace_key = ?`,
      )
      .run(cycleId, ownerId, lease.epoch, expiresAt, lease.updatedAt, lease.workspaceKey);
    if (Number(result.changes) !== 1)
      throw Object.assign(new Error(`workspace lease 更新失败: ${lease.workspaceKey}`), {
        kind: "not_found",
      });
  });
}

export function renewLeaseReady(
  db: ContinuousDatabaseSync,
  input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
    expiresAt: number;
    updatedAt: number;
  },
): void {
  // 续租只允许当前 owner/epoch：WHERE 同时匹配三者，未命中即失去续租（§10）。
  const result = db
    .prepare(
      `UPDATE continuous_workspace_lease
       SET expires_at = ?, updated_at = ?
       WHERE workspace_key = ? AND owner_id = ? AND epoch = ? AND cycle_id IS NOT NULL`,
    )
    .run(input.expiresAt, input.updatedAt, input.workspaceKey, input.ownerId, input.epoch);
  if (Number(result.changes) !== 1)
    throw Object.assign(
      new Error(`lease 续租未命中（owner/epoch 不匹配或已释放）: ${input.workspaceKey}`),
      { kind: "lease_not_found" },
    );
}

export function releaseLeaseReady(
  db: ContinuousDatabaseSync,
  workspaceKey: string,
  updatedAt: number,
): void {
  inContinuousTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE continuous_workspace_lease
         SET cycle_id = NULL, owner_id = NULL, expires_at = NULL, updated_at = ?
         WHERE workspace_key = ?`,
      )
      .run(updatedAt, workspaceKey);
    if (Number(result.changes) !== 1)
      throw Object.assign(new Error(`workspace lease 不存在: ${workspaceKey}`), {
        kind: "lease_not_found",
      });
    // epoch 故意不在 SET 列表里：正常释放保留单调 epoch（规格 §5）。
  });
}
