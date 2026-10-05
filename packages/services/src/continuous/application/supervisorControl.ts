// Continuous 控制面（CT-07）：Program/Cycle 的用户控制语义（规格 §6/§10）。
//   - pauseProgram：本轮结束后暂停（立即禁止新 Cycle，不取消正在执行的候选）；
//   - stopCurrentCycle：立即停止本轮（先撤销写入/请求许可，再取消并等待停止；Cycle cancelled、
//     Program paused；用户取消的 Run 不会被自动恢复——recovery 对 stopReason=user 不 resume）；
//   - continueSuspendedCycle：suspended 的同 Run 继续（自 CT-05 supervisor 移入，语义不变，
//     CT-07 增加 lease 校验/接管路径）；
//   - interruptCyclesForShutdown：正常退出时保存 interrupted（挂起而非 stop——stop 的 revoked
//     语义会封死 resume，与「下次按原身份恢复」冲突，§10）；
//   - changeProgramConfig：Goal/Scope/模板/模型变更 → revision+1、撤销旧写入许可、停止并结算
//     当前轮；单纯预算/cadence 修改不递增授权 revision（§6）。
// 与 supervisor.ts（执行编排）的边界：本文件只做控制决策与终局写入，执行经注入端口；
// 不回 import supervisor（RunNowResult/错误类放 supervisorLifecycle，避免环）。

import type { Cycle, Program } from "../domain/types.js";
import { isTerminalCycleStatus, requiresProgramReauthorization } from "../domain/types.js";
import type { ContinuousConfigChangeKind } from "../domain/types.js";
import { nextCycleAtFor } from "../domain/cadencePolicy.js";
import { continueCycleExecution } from "./supervisorResume.js";
import { ContinuousReportIngestion } from "./reportIngestion.js";
import { acquireCycleLease, requireLeaseEpoch } from "./workspaceLease.js";
import {
  ContinuousSupervisorError,
  type RunNowResult,
  type SupervisedCycleOutcome,
} from "./supervisorLifecycle.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
} from "./ports.js";

/** 控制面依赖：supervisor 交进来（attachSupervision 是 startSupervision 的窄缝）。 */
export interface CycleControlDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  clock: ContinuousClockPort;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
  /** 继续后的监督接入（supervisor.startSupervision 的窄缝，复用同一循环语义）。 */
  attachSupervision: (cycle: Cycle, program: Program) => Promise<SupervisedCycleOutcome>;
}

function referenceOf(cycle: Cycle): ExecutionReference {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

async function activateProgram(
  deps: Pick<CycleControlDeps, "repository" | "clock">,
  program: Program,
): Promise<void> {
  if (program.status === "active") return;
  await deps.repository.saveProgram({
    ...program,
    status: "active",
    ...(program.statusReason === undefined ? {} : { statusReason: undefined }),
    updatedAt: deps.clock.now(),
  });
}

/** suspended Cycle 的同 Run 继续（§6.1）：用户授权 grant 后恢复同一 Cycle/Run，不铸新执行。 */
export async function continueSuspendedCycle(
  deps: CycleControlDeps,
  cycleId: string,
  ownerId: string,
): Promise<RunNowResult> {
  const cycle = await deps.repository.getCycle(cycleId);
  if (!cycle) throw new ContinuousSupervisorError("capability_missing", `cycle 不存在: ${cycleId}`);
  if (cycle.status !== "suspended") {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `cycle ${cycleId} 状态 ${cycle.status} 非 suspended`,
    );
  }
  const pending = await deps.repository.getPendingContinuationRequest(cycleId);
  if (pending) {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `cycle ${cycleId} 继续确认尚未回答 (${pending.id})`,
    );
  }
  const requestId = cycle.pendingContinuationRequestId;
  if (requestId !== undefined) {
    const request = await deps.repository.getContinuationRequest(requestId);
    const kind = request?.resolution?.kind;
    if (
      !request ||
      request.status !== "resolved" ||
      (kind !== "continue_with_grant" && kind !== "adjust_config_and_continue")
    ) {
      throw new ContinuousSupervisorError(
        "program_not_runnable",
        `cycle ${cycleId} 缺少有效的继续授权（需要 continue_with_grant/adjust_config_and_continue）`,
      );
    }
  }
  const program = await deps.repository.getProgram(cycle.programId);
  if (!program) {
    throw new ContinuousSupervisorError("capability_missing", `program 不存在: ${cycle.programId}`);
  }
  // lease（CT-07）：suspended 保留占用——同 owner 续租；Host 重启后的过期占用按核对流程
  // 接管（同 Cycle）；他人持有则拒绝（不能新开另一轮绕过上限，E-19）。
  const lease = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId,
  });
  if (lease.status === "refused") {
    throw new ContinuousSupervisorError(
      "lease_lost",
      `workspace ${program.workspaceKey} 执行权不可得（${lease.reason}），不能继续 suspended cycle`,
    );
  }
  let current = cycle;
  if (cycle.leaseEpoch !== lease.epoch) {
    current = { ...cycle, leaseEpoch: lease.epoch };
  }
  const ref = referenceOf(current);
  const state = await deps.execution.inspect(ref);
  const resumed = await continueCycleExecution(deps, current, ref, state);
  await activateProgram(deps, program);
  return { cycle: resumed, completion: deps.attachSupervision(resumed, program) };
}
/** Pause（本轮结束后）：立即禁止新 Cycle；不取消正在执行的候选（E-11 与立即停止分开）。 */
export async function pauseProgram(
  deps: Pick<CycleControlDeps, "repository" | "clock">,
  params: { programId: string },
): Promise<Program> {
  const program = await deps.repository.getProgram(params.programId);
  if (!program) {
    throw new ContinuousSupervisorError(
      "capability_missing",
      `program 不存在: ${params.programId}`,
    );
  }
  if (program.status === "paused") return program;
  const updated: Program = {
    ...program,
    status: "paused",
    statusReason: "用户暂停（本轮结束后生效，不取消正在执行的候选）",
    updatedAt: deps.clock.now(),
  };
  await deps.repository.saveProgram(updated);
  return updated;
}
/** 显式恢复（paused/failed → active）；suspended 资源暂停必须走继续确认，不走本命令。 */
export async function resumeProgram(
  deps: Pick<CycleControlDeps, "repository" | "clock">,
  params: { programId: string },
): Promise<Program> {
  const program = await deps.repository.getProgram(params.programId);
  if (!program) {
    throw new ContinuousSupervisorError(
      "capability_missing",
      `program 不存在: ${params.programId}`,
    );
  }
  if (program.status !== "paused" && program.status !== "failed") {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `program ${program.id} 状态 ${program.status} 无需显式恢复`,
    );
  }
  const open = await deps.repository.getOpenCycle(program.id);
  if (open?.status === "suspended") {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `program ${program.id} 存在 suspended cycle ${open.id}，需先回答继续确认`,
    );
  }
  const updated: Program = {
    ...program,
    status: "active",
    statusReason: undefined,
    // failed → active 的显式重试清零失败计数（§6：连续失败需显式恢复）。
    consecutiveFailures: 0,
    updatedAt: deps.clock.now(),
  };
  await deps.repository.saveProgram(updated);
  return updated;
}

/** 导入已保存报告（停止/结算前的事实保留；§11 Run 失败也导入）。 */
async function drainReports(deps: CycleControlDeps, cycle: Cycle, program: Program): Promise<void> {
  const ingestion = new ContinuousReportIngestion({
    repository: deps.repository,
    clock: deps.clock,
  });
  for (let pages = 0; pages < 1024; pages++) {
    const current = (await deps.repository.getCycle(cycle.id)) ?? cycle;
    if (isTerminalCycleStatus(current.status)) return;
    const batch = await deps.execution.readReports(referenceOf(current), current.reportCursor);
    if (batch.items.length === 0) return;
    await ingestion.ingestBatch({
      programId: program.id,
      cycleId: cycle.id,
      items: batch.items,
      nextCursor: batch.nextCursor,
    });
  }
}

/**
 * 立即停止本轮（§6）：先撤销写入/请求许可 → cancel(user) → 等待停止（适配器 stop 的固定
 * 顺序）；Cycle cancelled、Program paused；已完成候选的提交保留。必须携带当前 lease epoch
 * ——旧 epoch 的停止请求按 lease_lost 拒绝，防止跨轮误停他人的执行。
 */
export async function stopCurrentCycle(
  deps: CycleControlDeps,
  params: { programId: string; epoch: number },
): Promise<Cycle> {
  const program = await deps.repository.getProgram(params.programId);
  if (!program) {
    throw new ContinuousSupervisorError(
      "capability_missing",
      `program 不存在: ${params.programId}`,
    );
  }
  const open = await deps.repository.getOpenCycle(program.id);
  if (!open) {
    throw new ContinuousSupervisorError(
      "program_not_runnable",
      `program ${program.id} 没有可停止的未结束 cycle`,
    );
  }
  await requireLeaseEpoch(deps, {
    workspaceKey: program.workspaceKey,
    epoch: params.epoch,
    purpose: "stop_current_cycle",
  });
  await deps.execution.stop(referenceOf(open), "user_stop");
  await deps.execution.waitForQuiescence(referenceOf(open));
  await drainReports(deps, open, program);
  const now = deps.clock.now();
  const latest = (await deps.repository.getCycle(open.id)) ?? open;
  const cancelled: Cycle = {
    ...latest,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
  };
  await deps.repository.completeCycle(cancelled, {
    status: "paused",
    statusReason: "用户立即停止本轮",
    lastCycleAt: now,
    // nextCycleAt 不重排：恢复后按原 cadence 继续；用户停止不是任务失败，失败计数不动。
    updatedAt: now,
  });
  // 终态后释放占用：epoch 校验已在停止前完成，这里按占用行归属释放（幂等）。
  const lease = await deps.repository.getLease(program.workspaceKey);
  if (lease?.cycleId === open.id) {
    await deps.repository.releaseLease(program.workspaceKey, now);
  }
  return cancelled;
}

/**
 * 正常退出（§10「正常退出撤销许可、取消并保存 interrupted」）：对执行中的 Cycle 在安全边界
 * 中断并保存 interrupted——刻意不用 stop（stop 的 revoked 语义会封死 resume，与「下次按原
 * 身份恢复」冲突）；lease 保留（持久化占用 + 恢复流程接管）。suspended 保持原状（继续确认
 * 跨重启保留）。返回被保存为 interrupted 的 cycle id 列表。
 */
export async function interruptCyclesForShutdown(
  deps: CycleControlDeps,
  workspaceKey: string,
): Promise<string[]> {
  const programs = await deps.repository.listPrograms(workspaceKey);
  const interrupted: string[] = [];
  for (const program of programs) {
    const open = await deps.repository.getOpenCycle(program.id);
    if (!open) continue;
    const ref = referenceOf(open);
    // 先停止监督写入，再中断执行；资源暂停的确认和状态跨退出保持。
    if (open.status !== "suspended" && open.status !== "interrupted") {
      await deps.repository.saveCycle({
        ...open,
        status: "interrupted",
        updatedAt: deps.clock.now(),
      });
      interrupted.push(open.id);
    }
    try {
      await deps.execution.interrupt(ref, open.leaseEpoch);
    } catch (error) {
      deps.logger?.warn?.("Continuous shutdown interrupt failed", {
        event: "continuous.shutdown.interrupt_failed",
        cycleId: open.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return interrupted;
}

/** 配置补丁：goal/scope/budget/cadence/模板；变更种类按在场字段推导（§6）。 */
export type ProgramConfigPatch = Partial<Pick<Program, "goal" | "scope" | "budget" | "cadence">> & {
  template?: { templateId: string; templateVersion: string; templateHash: string };
};

/**
 * 配置变更（§6/E-20）：Goal/Scope/模板变更 → revision+1（授权同步失效）、撤销旧写入许可、
 * 停止并结算当前轮（保存为 paused，等待用户确认新授权后未来新 Cycle 用新快照）；
 * 单纯预算增减/cadence 修改不递增授权 revision、不扩大 Scope——预算立即影响新请求
 * （admission 每次读现值），cadence 只影响未来轮（无未结束 Cycle 时才重排 nextCycleAt）。
 */
export async function changeProgramConfig(
  deps: CycleControlDeps,
  params: { programId: string; patch: ProgramConfigPatch },
): Promise<Program> {
  const { programId, patch } = params;
  const program = await deps.repository.getProgram(programId);
  if (!program) {
    throw new ContinuousSupervisorError("capability_missing", `program 不存在: ${programId}`);
  }
  const changeKinds: ContinuousConfigChangeKind[] = [];
  if (patch.goal !== undefined) changeKinds.push("goal");
  if (patch.scope !== undefined) changeKinds.push("scope");
  if (patch.template !== undefined) changeKinds.push("template");
  if (patch.budget !== undefined) changeKinds.push("budget");
  if (patch.cadence !== undefined) changeKinds.push("cadence");
  if (changeKinds.length === 0) return program;
  const needsReauthorization = changeKinds.some((kind) => requiresProgramReauthorization(kind));
  const now = deps.clock.now();
  let updated: Program = {
    ...program,
    ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
    ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
    ...(patch.budget !== undefined ? { budget: patch.budget } : {}),
    ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
    ...(patch.template !== undefined
      ? {
          templateId: patch.template.templateId,
          templateVersion: patch.template.templateVersion,
          templateHash: patch.template.templateHash,
        }
      : {}),
    updatedAt: now,
  };
  if (needsReauthorization) {
    // revision+1：Program 配置 revision 与授权 revision 同步递增——旧授权命令立即失效
    // （authorization_stale）；模板变更后 authorization.templateHash 仍指旧 hash，
    // 新 Cycle 会被授权核对拒绝，直到用户显式确认新授权（§6）。
    updated = {
      ...updated,
      revision: program.revision + 1,
      authorization: {
        ...program.authorization,
        revision: program.authorization.revision + 1,
      },
    };
    const open = await deps.repository.getOpenCycle(programId);
    if (open && open.status !== "suspended" && open.status !== "interrupted") {
      // 撤销旧写入许可并结算当前轮（用户已确认变更；停止语义同立即停止但不落 paused 之外的
      // 额外状态）。已完成候选的提交保留。
      await deps.execution.stop(referenceOf(open), "config_change");
      await deps.execution.waitForQuiescence(referenceOf(open));
      await drainReports(deps, open, program);
      const latest = (await deps.repository.getCycle(open.id)) ?? open;
      await deps.repository.completeCycle(
        { ...latest, status: "cancelled", completedAt: now, updatedAt: now },
        {
          status: "paused",
          statusReason: "配置变更待重新授权",
          lastCycleAt: now,
          updatedAt: now,
        },
      );
      const lease = await deps.repository.getLease(program.workspaceKey);
      if (lease?.cycleId === open.id) {
        await deps.repository.releaseLease(program.workspaceKey, now);
      }
    }
    updated = { ...updated, status: "paused", statusReason: "配置变更待重新授权" };
  } else if (patch.cadence !== undefined) {
    // cadence 只影响未来轮：没有未结束 Cycle 时才重排下一次到期（§6/E-20）。
    const open = await deps.repository.getOpenCycle(programId);
    if (!open) updated = { ...updated, nextCycleAt: nextCycleAtFor(updated, now) };
  }
  await deps.repository.saveProgram(updated);
  return updated;
}
