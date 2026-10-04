// Continuous cadence 领域规则（CT-05 起的最小实现；CT-07 周期/租约 ticket 扩展本文件：
// stable trigger key、错过多轮合并、退避曲线）。纯函数：不做 IO、不读时钟（时刻由调用方注入）。
// 规则来源：docs/specs/continuous.md §10（nextCycleAt 保存在 Program；daily 按 Program
// 持久化时区求下一次未来时点）。

import type { Program } from "./types.js";

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
