// 探活由 watchCycle 串行调用，避免第二个定时器覆盖报告游标或继续确认状态。
import type { Cycle, Program } from "../domain/types.js";
import { ContinuousContinuationService } from "./continuationService.js";
import type { HealthAssessment } from "./healthMonitor.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
} from "./ports.js";
import type { ExecutionReference } from "./ports.js";

export async function applyHealthAssessment(
  deps: {
    repository: ContinuousRepositoryPort;
    execution: ContinuousExecutionPort;
    clock: ContinuousClockPort;
  },
  ref: ExecutionReference,
  program: Program,
  assessment: HealthAssessment,
): Promise<void> {
  if (assessment.action.kind === "none" && assessment.classification !== "unreachable") return;
  const cycle = await deps.repository.getCycle(ref.cycleId);
  if (!cycle || cycle.status !== "running") return;
  const reason =
    assessment.classification === "unreachable"
      ? "执行进程不可达"
      : assessment.action.kind === "suspected_hang"
        ? "suspected_hang"
        : "time_limit";
  await deps.execution.suspendAtSafeBoundary(ref, reason);
  const now = deps.clock.now();
  const latest = await deps.repository.getCycle(cycle.id);
  if (!latest || latest.status !== "running") return;
  const suspended: Cycle = {
    ...latest,
    status: assessment.classification === "unreachable" ? "interrupted" : "suspended",
    updatedAt: now,
  };
  await deps.repository.saveCycle(suspended);
  if (assessment.classification !== "unreachable") {
    await new ContinuousContinuationService(deps).openRequest({
      cycle: suspended,
      reason: assessment.action.kind === "suspected_hang" ? "suspected_hang" : "time_limit",
      limitKind: assessment.action.kind === "suspected_hang" ? "health" : "time",
      observedUsage: assessment.action,
      currentLimit: { activeExecutionLimitMs: assessment.effectiveLimitMs },
      recommendedExtension: { activeMs: 3_600_000 },
    });
  }
  const currentProgram = (await deps.repository.getProgram(program.id)) ?? program;
  await deps.repository.saveProgram({
    ...currentProgram,
    status: "paused",
    statusReason: reason,
    updatedAt: now,
  });
}
