import type { Cycle } from "../domain/types.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";
import { ContinuousSupervisorError } from "./supervisorLifecycle.js";

export async function continueCycleExecution(
  deps: {
    repository: ContinuousRepositoryPort;
    execution: ContinuousExecutionPort;
    clock: ContinuousClockPort;
  },
  cycle: Cycle,
  ref: ExecutionReference,
  state: ExecutionState,
): Promise<Cycle> {
  // 旧预算错误不能通过打开内存准入复活；已完成的在途工作只做结算。
  if (state.status === "errored" || (state.status === "stopped" && !state.resumable)) {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `Run ${state.runId} 已不可恢复，请结束旧轮后显式启动新轮`,
    );
  }
  const resumed: Cycle = { ...cycle, status: "running", updatedAt: deps.clock.now() };
  // Host 账本只给 running 轮预留。必须先落库，后唤醒模型等待者，否则刚继续又被拒绝。
  await deps.repository.saveCycle(resumed);
  try {
    if (state.status === "stopped") await deps.execution.resume(ref, cycle.leaseEpoch);
    else if (state.status !== "completed")
      await deps.execution.resumeSuspended(ref, cycle.leaseEpoch);
  } catch (error) {
    const latest = await deps.repository.getCycle(cycle.id);
    if (latest?.status === "running") {
      await deps.repository.saveCycle({
        ...latest,
        status: "suspended",
        updatedAt: deps.clock.now(),
      });
    }
    throw error;
  }
  return resumed;
}
