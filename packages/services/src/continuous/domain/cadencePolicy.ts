// Continuous cadence 领域规则（CT-05 起的最小实现；CT-07 周期/租约 ticket 扩展本文件：
// stable trigger key、错过多轮合并、临时恢复退避曲线）。纯函数：不做 IO、不读时钟（时刻由调用方注入）。
// 规则来源：docs/specs/continuous.md §2（退避默认值）、§10（nextCycleAt 保存在 Program；daily 按
// Program 持久化时区求下一次未来时点；manual trigger 用请求 ID、scheduled trigger 用
// Program/revision/到期时间生成稳定 key；错过多轮只唤醒一次，不补跑串行旧任务）。

import type { Program } from "./types.js";

/**
 * manual 触发的 trigger key（§10）：请求 ID 即幂等键——同一请求的重发/ACK 丢失命中同一
 * Cycle/Run，绝不靠新随机 ID 补偿（E-16）。
 */
export function manualTriggerKey(requestId: string): string {
  return `manual:${requestId}`;
}

/**
 * scheduled 触发的 trigger key（§10）：Program/授权 revision/到期时间三元组生成稳定 key。
 * 同一到期窗口的重复 wake（scheduler 每 tick 重发、重启后的补唤醒）都命中同一行；
 * 错过多个窗口时由于到期时间取 Program 持久化的 nextCycleAt，也只产生一个 key/一次执行。
 */
export function scheduledTriggerKey(
  program: Pick<Program, "id" | "revision">,
  dueAt: number,
): string {
  return `scheduled:${program.id}:${program.revision}:${dueAt}`;
}

/** 临时恢复退避曲线（§2：首次 30 秒，第二次 120 秒；超限暂停询问，不无限自动重试）。 */
export const CONTINUOUS_RECOVERY_BACKOFF_MS = [30_000, 120_000] as const;

/**
 * 第 failedAttempts 次临时恢复失败后的下一次尝试延迟：
 * 1 → 30s；2 → 120s；≥3 → null（超限：不再自动重试，交由暂停询问，R-10）。
 */
export function recoveryBackoffMs(failedAttempts: number): number | null {
  if (failedAttempts < 1) return 0;
  const index = failedAttempts - 1;
  return index < CONTINUOUS_RECOVERY_BACKOFF_MS.length
    ? CONTINUOUS_RECOVERY_BACKOFF_MS[index]!
    : null;
}

/**
 * 到期判定（§10）：nextCycleAt 已过且 Program 可被调度唤醒（active/sleeping、未归档）。
 * paused/failed/completed 需显式恢复，scheduler 与到期处理都不唤醒它们。
 */
export function isProgramDue(
  program: Pick<Program, "status" | "nextCycleAt" | "archivedAt">,
  now: number,
): boolean {
  return (
    program.archivedAt === undefined &&
    (program.status === "active" || program.status === "sleeping") &&
    program.nextCycleAt !== undefined &&
    program.nextCycleAt <= now
  );
}

/**
 * 下一轮到期时间。
 * interval：本轮结束后 N 小时；daily：按 Program 持久化时区的下一个未来本地时点
 * （先按 UTC 猜候选时刻，再用该时刻的时区偏移修正——DST 边界安全）。
 */
export function nextCycleAtFor(program: Program, now: number): number {
  if (program.cadence.kind === "interval") {
    return now + Math.round(program.cadence.hoursAfterCycleEnd * 3_600_000);
  }
  const [hours, minutes] = program.cadence.localTime.split(":").map((part) => Number(part));
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const base = new Date(now + dayOffset * 86_400_000);
    const utcGuess = Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      hours!,
      minutes!,
      0,
      0,
    );
    const candidate = utcGuess - timeZoneOffsetMs(program.timeZone, utcGuess);
    if (candidate > now) return candidate;
  }
  return now + 86_400_000;
}

function timeZoneOffsetMs(timeZone: string, atMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(atMs));
    const get = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return asUtc - Math.floor(atMs / 1000) * 1000;
  } catch {
    // 非法时区（Program 持久化的 timeZone 坏值）：退 UTC 偏移 0，不递归不炸结算。
    return 0;
  }
}
