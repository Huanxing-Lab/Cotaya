// Continuous 监督循环的执行面（CT-07 自 supervisor.ts 拆出；架构 max-file-lines 拆分，
// 非边界变化）：轮询报告增量导入 → 执行终态 → settling（终局裁决仍在 supervisorLifecycle）
// → 终态释放 workspace lease。续租节流（30 秒）与失去租约的 interrupted 落库也在这里。
// 全部经注入依赖执行，无自有状态；supervisor.startSupervision 负责实例内单飞（每 Cycle
// 至多一条循环），本文件不做去重。

import { ContinuousHealthMonitor, CONTINUOUS_PROBE_INTERVAL_MS } from "./healthMonitor.js";
import { applyHealthAssessment, freezeCycleForUnreachableExecution } from "./supervisorHealth.js";
import { ContinuousSupervisorError } from "./supervisorLifecycle.js";
import type { Cycle, Program } from "../domain/types.js";
import { isTerminalCycleStatus } from "../domain/types.js";
import { ContinuousReportIngestion } from "./reportIngestion.js";
import {
  CONTINUOUS_LEASE_RENEW_INTERVAL_MS,
  renewCycleLease,
  releaseCycleLease,
  type WorkspaceLeaseDeps,
} from "./workspaceLease.js";
import {
  accumulateInto,
  createAccumulator,
  settleCycle,
  type ReportAccumulator,
  type SupervisedCycleOutcome,
} from "./supervisorLifecycle.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousReportItem,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";

/** 监督循环需要的依赖子集（supervisor 交进来；测试可独立注入）。 */
export interface CycleWatchDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  clock: ContinuousClockPort;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
  /** 轮询间隔（缺省 500ms）。 */
  pollIntervalMs?: number;
}

/** Run 终态判定（pending/running 继续轮询）。 */
export function isTerminalExecution(status: ExecutionState["status"]): boolean {
  return status === "completed" || status === "errored" || status === "stopped";
}

/**
 * CT-14：读操作（报告/快照）的通信失联——保存 interrupted 与证据、Program paused 后
 * 退出监督循环，交恢复核对。不能把异常抛给上层后丢下无人监督的 running 轮，也不能在
 * 断链上继续轮询（每次 RPC 都要重新等满期限，循环空转）。
 */
function isCommunicationFailure(error: unknown): boolean {
  return error instanceof ContinuousSupervisorError && error.code === "execution_unreachable";
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

function referenceOf(cycle: Cycle): ExecutionReference {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

/** 监督一轮直到终局（suspended/interrupted/终态结算三者之一）。 */
export async function watchCycle(
  deps: CycleWatchDeps,
  input: { cycle: Cycle; program: Program; ownerId: string },
): Promise<SupervisedCycleOutcome> {
  const { cycle, program, ownerId } = input;
  const leaseDeps: WorkspaceLeaseDeps = {
    repository: deps.repository,
    execution: deps.execution,
    clock: deps.clock,
  };
  const ref = referenceOf(cycle);
  const accumulator = createAccumulator();
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  let lastState: ExecutionState | undefined;
  let lastRenewAt = deps.clock.now();
  let lastProbeAt: number | undefined;
  const health = new ContinuousHealthMonitor({ ...deps, ownerEpoch: cycle.leaseEpoch });

  while (true) {
    const current = (await deps.repository.getCycle(cycle.id)) ?? cycle;
    if (current.leaseEpoch !== cycle.leaseEpoch) {
      // 已被新监督者接管：退出旧循环，不能用新 epoch 写回 interrupted 或健康字段。
      return {
        cycleId: cycle.id,
        cycleStatus: "interrupted",
        programStatus: program.status,
        reportRejections: accumulator.rejections,
      };
    }
    // suspended（资源挂起）/interrupted（退出/失去租约）由其他路径落库：监督到此为止；
    // cancelled 的占用由停止路径释放，这里兜底释放一次（幂等）。
    if (
      current.status === "suspended" ||
      current.status === "interrupted" ||
      current.status === "cancelled"
    ) {
      if (current.status === "cancelled") {
        await releaseLeaseBestEffort(deps, leaseDeps, program, ownerId, current);
      }
      return {
        cycleId: cycle.id,
        cycleStatus: current.status,
        programStatus: ((await deps.repository.getProgram(program.id)) ?? program).status,
        reportRejections: accumulator.rejections,
      };
    }
    // 续租（§10：30 秒节流；失去续租=epoch 被接管/释放）：本实例不再是写入者，保存
    // interrupted（可恢复），停止监督——绝不做旧 epoch 的副作用。
    if (deps.clock.now() - lastRenewAt >= CONTINUOUS_LEASE_RENEW_INTERVAL_MS) {
      lastRenewAt = deps.clock.now();
      if (!(await renewLeaseOrDetach(deps, leaseDeps, program, ownerId, current))) {
        return {
          cycleId: cycle.id,
          cycleStatus: "interrupted",
          programStatus: program.status,
          reportRejections: accumulator.rejections,
        };
      }
    }
    // CT-14：读取报告/执行快照的通信失联 → 冻结并退出（不抛异常、不空转、不覆盖暂停）。
    let batch;
    let state: ExecutionState;
    try {
      batch = await deps.execution.readReports(ref, current.reportCursor);
      state = await deps.execution.inspect(ref);
    } catch (error) {
      if (isCommunicationFailure(error)) {
        await freezeCycleForUnreachableExecution(deps, ref, {
          reason: "执行进程不可达（监督循环读取失败）",
          expectedEpoch: current.leaseEpoch,
          observed: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return {
          cycleId: cycle.id,
          cycleStatus: "interrupted",
          programStatus: ((await deps.repository.getProgram(program.id)) ?? program).status,
          reportRejections: accumulator.rejections,
        };
      }
      throw error;
    }
    if (batch.items.length > 0) {
      await ingest(deps, cycle, program, batch.items, batch.nextCursor, accumulator);
    }
    lastState = state;
    if (isTerminalExecution(lastState.status)) break;
    if (
      lastProbeAt === undefined ||
      deps.clock.now() - lastProbeAt >= CONTINUOUS_PROBE_INTERVAL_MS
    ) {
      lastProbeAt = deps.clock.now();
      const assessment = await health.probeOnce(ref);
      if (assessment) await applyHealthAssessment(deps, ref, program, assessment);
    }
    const schedule = deps.clock.schedule ?? defaultSchedule;
    await new Promise<void>((resolve) => {
      schedule(resolve, pollIntervalMs);
    });
  }
  await deps.execution.waitForQuiescence(ref);
  const outcome = await settleCycle(deps, {
    cycle: (await deps.repository.getCycle(cycle.id)) ?? cycle,
    program,
    ref,
    finalState: lastState!,
    accumulator,
  });
  // 终态释放占用（epoch 保留）；suspended/interrupted 保留占用等继续确认/恢复接管（§10）。
  if (isTerminalCycleStatus(outcome.cycleStatus)) {
    await releaseLeaseBestEffort(deps, leaseDeps, program, ownerId, cycle);
  }
  return outcome;
}

async function renewLeaseOrDetach(
  deps: CycleWatchDeps,
  leaseDeps: WorkspaceLeaseDeps,
  program: Program,
  ownerId: string,
  cycle: Cycle,
): Promise<boolean> {
  try {
    await renewCycleLease(leaseDeps, {
      workspaceKey: program.workspaceKey,
      ownerId,
      epoch: cycle.leaseEpoch,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = deps.clock.now();
    await deps.repository.saveCycle({ ...cycle, status: "interrupted", updatedAt: now });
    await deps.repository
      .appendEvent({
        programId: program.id,
        cycleId: cycle.id,
        eventKey: `lease-lost:${cycle.id}:${cycle.leaseEpoch}`,
        type: "cycle.lease_lost",
        payload: { epoch: cycle.leaseEpoch, ownerId, message },
        createdAt: now,
      })
      .catch(() => {
        // 审计尽力而为：lease 已丢，不能因审计失败阻塞 interrupted 落库路径。
      });
    deps.logger?.warn?.("Continuous workspace lease lost during supervision", {
      event: "continuous.supervisor.lease_lost",
      module: "services.continuous",
      cycleId: cycle.id,
      message,
    });
    return false;
  }
}

async function releaseLeaseBestEffort(
  deps: CycleWatchDeps,
  leaseDeps: WorkspaceLeaseDeps,
  program: Program,
  ownerId: string,
  cycle: Cycle,
): Promise<void> {
  try {
    await releaseCycleLease(leaseDeps, {
      workspaceKey: program.workspaceKey,
      ownerId,
      epoch: cycle.leaseEpoch,
    });
  } catch (error) {
    deps.logger?.warn?.("Continuous lease release failed", {
      event: "continuous.supervisor.lease_release_failed",
      module: "services.continuous",
      cycleId: cycle.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ingest(
  deps: CycleWatchDeps,
  cycle: Cycle,
  program: Program,
  items: ContinuousReportItem[],
  nextCursor: number,
  accumulator: ReportAccumulator,
): Promise<void> {
  const outcome = await new ContinuousReportIngestion({
    repository: deps.repository,
    clock: deps.clock,
  }).ingestBatch({
    programId: program.id,
    cycleId: cycle.id,
    items,
    nextCursor,
  });
  accumulateInto(accumulator, outcome);
}
