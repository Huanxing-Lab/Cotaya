import type { Cycle } from "../domain/types.js";
import type { ContinuousDatabaseSync } from "./sqliteConnection.js";

export function updateCycleHealthReady(db: ContinuousDatabaseSync, cycle: Cycle): boolean {
  // 探活可能晚于取消到达。条件更新仅碰健康列，不能把旧整行写回 running。
  const result = db
    .prepare(`UPDATE continuous_cycle SET
    active_duration_ms = MAX(active_duration_ms, ?),
    normal_blocked_duration_ms = MAX(normal_blocked_duration_ms, ?),
    health_state = ?, last_progress_at = CASE WHEN ? IS NULL THEN last_progress_at ELSE MAX(COALESCE(last_progress_at, 0), ?) END,
    last_probe_at = ?, updated_at = MAX(updated_at, ?)
    WHERE id = ? AND status = 'running' AND lease_epoch = ?
    AND (last_probe_at IS NULL OR last_probe_at <= ?)`)
    .run(
      cycle.activeDurationMs,
      cycle.normalBlockedDurationMs,
      cycle.healthState,
      cycle.lastProgressAt ?? null,
      cycle.lastProgressAt ?? null,
      cycle.lastProbeAt ?? 0,
      cycle.updatedAt,
      cycle.id,
      cycle.leaseEpoch,
      cycle.lastProbeAt ?? 0,
    );
  return Number(result.changes) === 1;
}
