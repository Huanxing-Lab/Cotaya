// 探活由 watchCycle 串行调用，避免第二个定时器覆盖报告游标或继续确认状态。
// CT-14：unreachable（探活分类/RPC 通信期限超时）冻结新操作——不发 wire 挂起（同一断链
// 上只会同样卡住），直接保存 interrupted 与证据事件、Program paused，由恢复流程核对
//（docs/specs/continuous.md §10.1 unreachable 行为；发布文档 §2.1 修复边界）。
import type { Cycle, Program } from "../domain/types.js";
import { ContinuousContinuationService } from "./continuationService.js";
import type { HealthAssessment } from "./healthMonitor.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
} from "./ports.js";
import type { ExecutionReference } from "./ports.js";

/** 失联冻结：保存 interrupted + 证据事件 + Program paused；不触碰报告游标与确认指针。 */
export async function freezeCycleForUnreachableExecution(
  deps: {
    repository: ContinuousRepositoryPort;
    clock: ContinuousClockPort;
    logger?: { warn?: (message: string, meta?: unknown) => void };
  },
  ref: ExecutionReference,
  detail: { reason: string; observed?: unknown; expectedEpoch: number },
): Promise<void> {
  const cycle = await deps.repository.getCycle(ref.cycleId);
  // 执行权已改变（新监督者接管）或轮已不在 running：旧观察不能覆盖新状态/游标/确认
  //（CT-14 验收「中途暂停/取消/执行权改变不被旧快照覆盖」）。
  if (!cycle || cycle.status !== "running" || cycle.leaseEpoch !== detail.expectedEpoch) return;
  const now = deps.clock.now();
  await deps.repository.saveCycle({ ...cycle, status: "interrupted", updatedAt: now });
  await deps.repository
    .appendEvent({
      programId: cycle.programId,
      cycleId: cycle.id,
      eventKey: `execution-unreachable:${cycle.id}:${cycle.leaseEpoch}:${now}`,
      type: "cycle.execution_unreachable",
      payload: { reason: detail.reason, observed: detail.observed ?? null },
      createdAt: now,
    })
    .catch(() => {
      // 审计尽力而为：证据事件失败不能阻塞 interrupted 落库（冻结必须完成）。
    });
  const program = await deps.repository.getProgram(cycle.programId);
  if (program) {
    await deps.repository.saveProgram({
      ...program,
      status: "paused",
      statusReason: detail.reason,
      updatedAt: now,
    });
  }
  deps.logger?.warn?.("Continuous execution unreachable; froze cycle for recovery", {
    event: "continuous.supervisor.execution_unreachable",
    module: "services.continuous",
    cycleId: cycle.id,
    reason: detail.reason,
  });
}

export async function applyHealthAssessment(
  deps: {
    repository: ContinuousRepositoryPort;
    execution: ContinuousExecutionPort;
    clock: ContinuousClockPort;
    logger?: { warn?: (message: string, meta?: unknown) => void };
  },
  ref: ExecutionReference,
  program: Program,
  assessment: HealthAssessment,
): Promise<void> {
  if (assessment.classification === "unreachable") {
    // 传输已知断开：suspendAtSafeBoundary 会卡在同一断链上（CT-14：监督循环不能永远
    // 等一次 RPC）。CLI 侧登记/账本断联各自 fail closed；这里只落库冻结与证据。
    const current = await deps.repository.getCycle(ref.cycleId);
    if (!current || current.status !== "running") return;
    await freezeCycleForUnreachableExecution(deps, ref, {
      reason: "执行进程不可达",
      expectedEpoch: current.leaseEpoch,
      observed: { classification: assessment.classification, snapshot: assessment.snapshot },
    });
    return;
  }
  if (assessment.action.kind === "none") return;
  const cycle = await deps.repository.getCycle(ref.cycleId);
  if (!cycle || cycle.status !== "running") return;
  const reason = assessment.action.kind === "suspected_hang" ? "suspected_hang" : "time_limit";
  await deps.execution.suspendAtSafeBoundary(ref, reason);
  const now = deps.clock.now();
  const latest = await deps.repository.getCycle(cycle.id);
  if (!latest || latest.status !== "running") return;
  const suspended: Cycle = {
    ...latest,
    status: "suspended",
    updatedAt: now,
  };
  await deps.repository.saveCycle(suspended);
  await new ContinuousContinuationService(deps).openRequest({
    cycle: suspended,
    reason: assessment.action.kind === "suspected_hang" ? "suspected_hang" : "time_limit",
    limitKind: assessment.action.kind === "suspected_hang" ? "health" : "time",
    observedUsage: assessment.action,
    currentLimit: { activeExecutionLimitMs: assessment.effectiveLimitMs },
    recommendedExtension: { activeMs: 3_600_000 },
  });
  const currentProgram = (await deps.repository.getProgram(program.id)) ?? program;
  await deps.repository.saveProgram({
    ...currentProgram,
    status: "paused",
    statusReason: reason,
    updatedAt: now,
  });
}
