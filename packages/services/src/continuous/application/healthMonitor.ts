// Continuous 主动探活与有效计时（CT-04）：15 秒探活节拍、健康分类与 1 小时有效执行上限。
// 规则来源：docs/specs/continuous.md §10.1（主动探活与一小时规则）、§2（有效执行 1 小时）。
//
// 状态所有者：本监控是 cycle.activeDurationMs / normalBlockedDurationMs / lastProgressAt /
// lastProbeAt / healthState 的唯一写入者（经 repository.saveCycle）；探活只读执行端口，
// 不调用模型（不为判断 hang 消耗 token）。
//
// 分类规则（§10.1 表）：
//   unreachable     Host/CLI 不可达（snapshot.reachable=false）→ 冻结新操作与计时归 recovery；
//   progressing     lastProgressAt 前进（真实执行适配器证据，非模型自述/heartbeat）；
//   normal_wait     waitingFor 带 owner/原因/期限且期限未过 → 不计有效时间，仍探活；
//   suspected_hang  距 lastProgressAt ≥180s 且连续 3 次主动探测不能证实健康 → 保存诊断并询问。
//
// 有效计时：两次探活间隔 delta——normal_wait 计入 normalBlockedDurationMs；unreachable
// 两者都不计（桌面退出）；其余计入 activeDurationMs。区间随 cycle 持久化，重启跨恢复累计、
// 不重算（R-12）。达到有效上限（含 grant 增量）且当前**健康工作**时报告 time_limit 动作；
// normal_wait 推迟触发（§10.1），等待结束恢复计时后再触发。全部 actor 等待才算 normal_wait
// ——快照聚合归 supervisor（CT-05）：任一 actor 有进展时 snapshot.lastProgressAt 前进。
//
// 已知边界（评审确认，如实声明）：本监控当前**没有产品调用者**（supervisor/watchCycle 不
// 启动探活循环）；且 CLI 适配器的 inspectHealth 刻意不提供 lastProgressAt/waitingFor——
// 证据源缺席时本分类对所有可达执行恒判「无进展」（progressed/waitValid 恒 false，180 秒
// 后 suspected_hang）。启用探活前必须先落地真实进展证据源（journal sequence 推进/actor
// 转录更新等），否则接线即误报（见 docs/release/continuous.md §2.1 已知边界）。

import type { Cycle } from "../domain/types.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  HealthSnapshot,
} from "./ports.js";
import { mergeContinuationGrants } from "../domain/budgetPolicy.js";

export const CONTINUOUS_PROBE_INTERVAL_MS = 15_000;
export const CONTINUOUS_HANG_THRESHOLD_MS = 180_000;
export const CONTINUOUS_HANG_PROBE_CONFIRMATIONS = 3;

export type ContinuousHealthClassification =
  | "progressing"
  | "normal_wait"
  | "suspected_hang"
  | "unreachable";

/** 探活一步的结论：分类 + 计时增量 + 需要的动作（动作执行归 supervisor/CT-05）。 */
export interface HealthAssessment {
  cycleId: string;
  classification: ContinuousHealthClassification;
  /** 本次探活新增的有效/等待时长（ms）。 */
  activeDeltaMs: number;
  normalBlockedDeltaMs: number;
  /** 累计值（探活后，已持久化）。 */
  activeDurationMs: number;
  normalBlockedDurationMs: number;
  effectiveLimitMs: number;
  action:
    | { kind: "none" }
    | {
        kind: "time_limit_reached";
        observed: { activeDurationMs: number; effectiveLimitMs: number };
      }
    | {
        kind: "suspected_hang";
        observed: { lastProgressAt?: number; probeFailedCount: number; stalledMs: number };
      };
  snapshot: HealthSnapshot;
}

export interface ContinuousHealthMonitorDeps {
  repository: ContinuousRepositoryPort;
  clock: ContinuousClockPort;
  /** 只用 inspectHealth（探活只读，不触碰 submit/resume/stop）。 */
  execution: Pick<ContinuousExecutionPort, "inspectHealth">;
  logger?: { warn?: (message: string, meta?: unknown) => void };
  probeIntervalMs?: number;
  hangThresholdMs?: number;
  hangProbeConfirmations?: number;
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * 主动探活监控。一个 Cycle 一个实例；探活失败计数是**实例内**观察状态（重启后重新累计——
 * 保守方向：旧 heartbeat 不冒充健康，重启后需再证 3 次）。计时与进展时刻全部在 cycle 行。
 */
export class ContinuousHealthMonitor {
  private readonly probeIntervalMs: number;
  private readonly hangThresholdMs: number;
  private readonly hangProbeConfirmations: number;
  private probeFailedCount = 0;
  /**
   * 实例内计时基线：区间只在本实例两次探活之间累计。重启/换实例后首个探活区间为 0——
   * 离线时间不计入有效时长（规格 §10.1/§2），持久化的 lastProbeAt 只作展示字段。
   */
  private instanceLastProbeAt: number | undefined;
  private stopProbing: (() => void) | undefined;

  constructor(private readonly deps: ContinuousHealthMonitorDeps) {
    this.probeIntervalMs = deps.probeIntervalMs ?? CONTINUOUS_PROBE_INTERVAL_MS;
    this.hangThresholdMs = deps.hangThresholdMs ?? CONTINUOUS_HANG_THRESHOLD_MS;
    this.hangProbeConfirmations =
      deps.hangProbeConfirmations ?? CONTINUOUS_HANG_PROBE_CONFIRMATIONS;
  }

  /** 启动 15 秒探活节拍（规格 §10.1）；返回停止函数。时钟经注入 schedule（测试可控）。 */
  start(ref: ExecutionReference, onAssessment: (assessment: HealthAssessment) => void): () => void {
    if (this.stopProbing) return this.stopProbing;
    let stopped = false;
    const schedule = this.deps.clock.schedule ?? defaultSchedule;
    const tick = (): void => {
      if (stopped) return;
      void this.probeOnce(ref)
        .then((assessment) => {
          if (assessment !== null) onAssessment(assessment);
        })
        .catch((error: unknown) => {
          this.deps.logger?.warn?.("Continuous health probe failed", {
            event: "continuous.health.probe_error",
            module: "services.continuous",
            cycleId: ref.cycleId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!stopped) this.stopProbing = schedule(tick, this.probeIntervalMs);
        });
    };
    this.stopProbing = schedule(tick, this.probeIntervalMs);
    return () => {
      stopped = true;
      this.stopProbing?.();
      this.stopProbing = undefined;
    };
  }

  stop(): void {
    this.stopProbing?.();
    this.stopProbing = undefined;
  }

  /** 一次探活：读快照 → 分类 → 累计区间 → 持久化 cycle 健康字段 → 返回结论。 */
  async probeOnce(ref: ExecutionReference): Promise<HealthAssessment | null> {
    const cycle = await this.deps.repository.getCycle(ref.cycleId);
    if (!cycle) return null;
    const now = this.deps.clock.now();
    const snapshot = await this.deps.execution.inspectHealth(ref);

    const previousProgressAt = cycle.lastProgressAt;
    const progressed =
      snapshot.lastProgressAt !== undefined &&
      (previousProgressAt === undefined || snapshot.lastProgressAt > previousProgressAt);
    // normal_wait 证据（§10.1）：owner/原因/期限齐全且期限未过；仅有存活/heartbeat不算。
    const waitEvidence = snapshot.waitingFor;
    const waitValid =
      waitEvidence !== undefined &&
      typeof waitEvidence.ownerId === "string" &&
      waitEvidence.ownerId.length > 0 &&
      typeof waitEvidence.reason === "string" &&
      waitEvidence.reason.length > 0 &&
      typeof waitEvidence.deadlineAt === "number" &&
      waitEvidence.deadlineAt > now;
    // 区间累计基准：本实例上一次探活（离线/重启缺口不计入有效时长，见 instanceLastProbeAt）。
    const baseline = this.instanceLastProbeAt;
    const sinceMs = baseline === undefined ? 0 : Math.max(0, now - baseline);
    this.instanceLastProbeAt = now;

    let classification: ContinuousHealthClassification;
    if (!snapshot.reachable) {
      classification = "unreachable";
      this.probeFailedCount = 0;
    } else if (progressed) {
      classification = "progressing";
      this.probeFailedCount = 0;
    } else if (waitValid) {
      classification = "normal_wait";
      this.probeFailedCount = 0;
    } else {
      this.probeFailedCount += 1;
      const stalledMs =
        now - (snapshot.lastProgressAt ?? previousProgressAt ?? cycle.startedAt ?? cycle.createdAt);
      classification =
        stalledMs >= this.hangThresholdMs && this.probeFailedCount >= this.hangProbeConfirmations
          ? "suspected_hang"
          : "progressing";
    }

    const activeDeltaMs =
      classification === "progressing" || classification === "suspected_hang" ? sinceMs : 0;
    const normalBlockedDeltaMs = classification === "normal_wait" ? sinceMs : 0;
    const activeDurationMs = cycle.activeDurationMs + activeDeltaMs;
    const normalBlockedDurationMs = cycle.normalBlockedDurationMs + normalBlockedDeltaMs;

    const program = await this.deps.repository.getProgram(cycle.programId);
    const grants = await this.deps.repository.listCycleContinuationGrants(cycle.id);
    const effectiveLimitMs = program
      ? mergeContinuationGrants(program.budget, grants).activeExecutionLimitMs
      : cycle.activeDurationMs;

    const updated: Cycle = {
      ...cycle,
      activeDurationMs,
      normalBlockedDurationMs,
      lastProbeAt: now,
      healthState: classification,
      ...(snapshot.lastProgressAt === undefined ? {} : { lastProgressAt: snapshot.lastProgressAt }),
      updatedAt: now,
    };
    await this.deps.repository.saveCycle(updated);

    let action: HealthAssessment["action"] = { kind: "none" };
    if (
      classification === "progressing" &&
      activeDurationMs >= effectiveLimitMs &&
      // 本实例至少观察过一个完整区间后才判上限（首探活区间为 0，不凭历史累计直接触发）。
      baseline !== undefined
    ) {
      action = {
        kind: "time_limit_reached",
        observed: { activeDurationMs, effectiveLimitMs },
      };
    } else if (classification === "suspected_hang") {
      action = {
        kind: "suspected_hang",
        observed: {
          lastProgressAt: updated.lastProgressAt,
          probeFailedCount: this.probeFailedCount,
          stalledMs: now - (updated.lastProgressAt ?? cycle.startedAt ?? cycle.createdAt),
        },
      };
    }

    return {
      cycleId: cycle.id,
      classification,
      activeDeltaMs,
      normalBlockedDeltaMs,
      activeDurationMs,
      normalBlockedDurationMs,
      effectiveLimitMs,
      action,
      snapshot,
    };
  }
}
