// Continuous 恢复流程的终局写入面（CT-07 自 recovery.ts 拆出；架构 max-file-lines 拆分，
// 非边界变化）：Run 终态但 Cycle 未结束的补结算（R-05）、用户停止的崩溃窗口收尾（E-11）、
// 恢复受限的暂停询问（resume_limit 继续确认）、不可恢复的失败与证据（R-10）、占用释放。
// 决策表（先核对什么、何时 resume）留在 recovery.ts；本文件只负责按决策落库。

import { randomUUID } from "node:crypto";
import type { Cycle, Program } from "../domain/types.js";
import { nextCycleAtFor } from "../domain/cadencePolicy.js";
import {
  createAccumulator,
  settleCycle,
  type SupervisedCycleOutcome,
} from "./supervisorLifecycle.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
} from "./ports.js";

/** 终局写入需要的依赖子集（recovery 交进来；测试可独立注入）。 */
export interface RecoverySettlementDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  clock: ContinuousClockPort;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
}

function referenceOf(cycle: Cycle): ExecutionReference {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

/** Run 终态但 Cycle 未结束：drain 已保存报告并结算（R-05；失败也导入，§11）。 */
export async function settleRecoveredCycle(
  deps: RecoverySettlementDeps,
  input: { program: Program; cycle: Cycle; state: ExecutionState },
): Promise<{ cycleId: string; action: "settled"; detail: string }> {
  const { program, cycle, state } = input;
  const outcome: SupervisedCycleOutcome = await settleCycle(deps, {
    cycle,
    program,
    ref: referenceOf(cycle),
    finalState: state,
    accumulator: createAccumulator(),
  });
  // 终态释放占用（settleCycle 不碰 lease；与监督循环同一收尾语义）。
  if (outcome.cycleStatus !== "suspended") {
    await releaseLeaseIfHeld(deps, program, cycle.id);
  }
  return { cycleId: cycle.id, action: "settled", detail: `cycle=${outcome.cycleStatus}` };
}

/** 用户停止的崩溃窗口收尾：cancelled + paused，不计失败、不自动恢复（E-11/R-10）。 */
export async function finalizeUserStoppedCycle(
  deps: RecoverySettlementDeps,
  input: { program: Program; cycle: Cycle },
): Promise<{ cycleId: string; action: "cancelled_finalized" }> {
  const { program, cycle } = input;
  const now = deps.clock.now();
  const live = (await deps.repository.getCycle(cycle.id)) ?? cycle;
  await deps.repository.completeCycle(
    { ...live, status: "cancelled", completedAt: now, updatedAt: now },
    {
      status: "paused",
      statusReason: "用户停止（恢复流程收尾）",
      lastCycleAt: now,
      updatedAt: now,
    },
  );
  await releaseLeaseIfHeld(deps, program, cycle.id);
  return { cycleId: cycle.id, action: "cancelled_finalized" };
}

/** 恢复受限的暂停询问：cycle suspended + program paused + 同轮唯一 pending 继续确认。 */
export async function suspendCycleForResumeLimit(
  deps: RecoverySettlementDeps,
  input: { program: Program; cycle: Cycle; observed: unknown },
): Promise<void> {
  const { program, cycle, observed } = input;
  const now = deps.clock.now();
  const existing = await deps.repository.getPendingContinuationRequest(cycle.id);
  let requestId = existing?.id;
  if (requestId === undefined) {
    requestId = randomUUID();
    await deps.repository.insertContinuationRequest({
      id: requestId,
      programId: program.id,
      cycleId: cycle.id,
      reason: "resume_limit",
      limitKind: "resume",
      reasons: ["resume_limit"],
      observedUsage: observed,
      currentLimit: { maxResumeAttempts: program.budget.maxResumeAttempts },
      recommendedExtension: { resumeAttempts: 1 },
      version: 1,
      status: "pending",
      createdAt: now,
    });
  }
  const live = (await deps.repository.getCycle(cycle.id)) ?? cycle;
  await deps.repository.saveCycle({
    ...live,
    status: "suspended",
    pendingContinuationRequestId: requestId,
    updatedAt: now,
  });
  await deps.repository.saveProgram({
    ...program,
    status: "paused",
    statusReason: "恢复受限（resume_limit）待继续确认",
    updatedAt: now,
  });
}

/** 不可恢复：终态 failed + 证据事件；失败计数与 Program failed 按 §6 连续三轮规则。 */
export async function failCycleWithEvidence(
  deps: RecoverySettlementDeps,
  input: { program: Program; cycle: Cycle; error: unknown },
): Promise<void> {
  const { program, cycle, error } = input;
  const now = deps.clock.now();
  const message = error instanceof Error ? error.message : String(error);
  await deps.repository.appendEvent({
    programId: program.id,
    cycleId: cycle.id,
    eventKey: `recovery-failed:${cycle.id}`,
    type: "cycle.recovery_failed",
    payload: { message, resumeAttempts: cycle.resumeAttempts },
    createdAt: now,
  });
  const live = (await deps.repository.getCycle(cycle.id)) ?? cycle;
  const consecutiveFailures = program.consecutiveFailures + 1;
  await deps.repository.completeCycle(
    { ...live, status: "failed", completedAt: now, updatedAt: now },
    {
      status: consecutiveFailures >= 3 ? "failed" : "sleeping",
      ...(consecutiveFailures >= 3 ? { statusReason: "连续失败达到上限，需显式恢复" } : {}),
      nextCycleAt: nextCycleAtFor(program, now),
      lastCycleAt: now,
      consecutiveFailures,
      updatedAt: now,
    },
  );
  await releaseLeaseIfHeld(deps, program, cycle.id);
}

/** 该 Cycle 仍持有占用时释放（终态后的收尾；epoch 保留）。 */
export async function releaseLeaseIfHeld(
  deps: RecoverySettlementDeps,
  program: Program,
  cycleId: string,
): Promise<void> {
  try {
    const lease = await deps.repository.getLease(program.workspaceKey);
    if (lease?.cycleId === cycleId) {
      await deps.repository.releaseLease(program.workspaceKey, deps.clock.now());
    }
  } catch (error) {
    deps.logger?.warn?.("Continuous recovery lease release failed", {
      event: "continuous.recovery.lease_release_failed",
      cycleId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
