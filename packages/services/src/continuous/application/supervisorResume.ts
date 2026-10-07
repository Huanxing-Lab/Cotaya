import type { Cycle } from "../domain/types.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";
import { ContinuousSupervisorError } from "./supervisorLifecycle.js";

/**
 * 详情读面的执行状态窄缝（CT-13）：开放 Cycle 的执行可恢复性——errored/不可恢复 stopped
 * Run 的预算轮据实显示「不可恢复，可结束旧轮后显式新开轮」（programDetail 投影消费）。
 * 行缺失或执行面不可达返回 null：读面不编造事实、不因读失败阻塞整个详情。
 */
export async function inspectCycleExecutionOf(
  deps: {
    repository: Pick<ContinuousRepositoryPort, "getCycle">;
    execution: Pick<ContinuousExecutionPort, "inspect">;
  },
  cycleId: string,
): Promise<ExecutionState | null> {
  const cycle = await deps.repository.getCycle(cycleId);
  if (!cycle) return null;
  try {
    return await deps.execution.inspect({
      cycleId: cycle.id,
      executionSessionId: cycle.executionSessionId,
      workflowRunId: cycle.workflowRunId,
      traceId: cycle.traceId,
    });
  } catch {
    return null;
  }
}

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
