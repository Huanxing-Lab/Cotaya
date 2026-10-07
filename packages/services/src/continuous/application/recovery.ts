// Continuous 恢复与到期编排（CT-07；规格 §10 恢复顺序）。
//
// recoverWorkspace（Host 启动/恢复数据库后调用）：
//   1. 先核对全部未结束 Cycle——仍活着重新连接不重复启动；已中断且可恢复同 Run resume；
//      已完成补导入报告并结算；不可恢复记录失败和证据；suspended 保持（继续确认跨重启/
//      跨日保留，用户同意前不恢复）；
//   2. 最后才处理到期 Program（§10 明确顺序；睡眠错过多轮只唤醒一次，不排队补跑）。
// handleWake（scheduler→Main→Host 转发来的唤醒）：同一顺序的单 Program 版本——先核对
//   未结束 Cycle 再看到期；重复 wake 由 trigger key UNIQUE 与「一个 Program 一条未结束
//   Cycle」约束幂等吸收（E-16/E-18）。
// 临时失败（执行面断联/暂不可用）的退避：30s/120s 两次内自动重试（经注入 schedule），
// 超限暂停询问（resume_limit 继续确认），不无限自动重试（§2/R-10）。用户取消的 Run
// （stopReason=user）不自动恢复：崩溃窗口内补落 cancelled（E-11/R-10）。
//
// 纯库类：无后台线程；退避定时器经 Clock.schedule 注入（缺省 setTimeout unref），
// 退避尝试计数为实例内状态（跨重启从头计——每次启动本身就是一次新的核对机会）。

import type { Cycle, Program } from "../domain/types.js";
import { isProgramDue, recoveryBackoffMs, scheduledTriggerKey } from "../domain/cadencePolicy.js";
import { acquireCycleLease } from "./workspaceLease.js";
import {
  failCycleWithEvidence,
  finalizeUserStoppedCycle,
  settleRecoveredCycle,
  suspendCycleForResumeLimit,
  type RecoverySettlementDeps,
} from "./recoverySettlement.js";
import { ContinuousSupervisorError } from "./supervisorLifecycle.js";
import type { ContinuousSupervisor, RunNowResult } from "./supervisor.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
  HealthSnapshot,
  WorkspacePreparationPort,
} from "./ports.js";

/** 单个未结束 Cycle 的核对结论（审计事件 cycle.recovery 记同一词表）。 */
export type RecoveryAction =
  | "reattached"
  | "resubmitted"
  | "resumed"
  | "settled"
  | "cancelled_finalized"
  | "kept_suspended"
  | "kept_interrupted"
  | "suspend_ask"
  | "failed"
  | "backoff_scheduled";

export interface ContinuousRecoveryDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  supervisor: ContinuousSupervisor;
  clock: ContinuousClockPort;
  /**
   * 恢复前的 workspace 重核对（R-03）：resume 前重新 resolve worktree/HEAD——外部改动在
   * 恢复路径重核对，不盲目重放节点副作用；候选级 diff/检查点核对归 CT-02 的恢复面。
   */
  workspace: WorkspacePreparationPort;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
}

export interface RecoveryReport {
  workspaceKey: string;
  reconciled: Array<{ cycleId: string; action: RecoveryAction; detail?: string }>;
  startedCycleIds: string[];
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

export class ContinuousRecoveryService {
  /** 退避尝试计数（cycleId → 连续临时失败次数）；实例内状态，见文件头。 */
  private readonly transientFailures = new Map<string, number>();

  constructor(private readonly deps: ContinuousRecoveryDeps) {}

  /** Host 启动/数据库恢复：先全部未结束 Cycle，最后到期 Program（§10 顺序）。 */
  async recoverWorkspace(workspaceKey: string): Promise<RecoveryReport> {
    const programs = await this.deps.repository.listPrograms(workspaceKey);
    const reconciled: RecoveryReport["reconciled"] = [];
    for (const program of programs) {
      const open = await this.deps.repository.getOpenCycle(program.id);
      if (!open) continue;
      reconciled.push(await this.reconcileCycle(program, open));
    }
    const startedCycleIds: string[] = [];
    const now = this.deps.clock.now();
    for (const program of programs) {
      if (!isProgramDue(program, now)) continue;
      const started = await this.startDue(program);
      if (started !== null) startedCycleIds.push(started.cycle.id);
    }
    return { workspaceKey, reconciled, startedCycleIds };
  }

  /** scheduler wake 入口（Host 路由）：先核对未结束 Cycle，再处理到期。 */
  async handleWake(programId: string): Promise<void> {
    const program = await this.deps.repository.getProgram(programId);
    if (!program) return; // wake 是建议性信号：program 不存在即无事可做
    const open = await this.deps.repository.getOpenCycle(programId);
    if (open) {
      await this.reconcileCycle(program, open);
      return;
    }
    if (!isProgramDue(program, this.deps.clock.now())) return;
    await this.startDue(program);
  }

  /** 到期启动：稳定 trigger key（Program/revision/到期时间）；不可启动的竞态安静跳过。 */
  private async startDue(program: Program): Promise<RunNowResult | null> {
    const dueAt = program.nextCycleAt;
    if (dueAt === undefined) return null;
    try {
      return await this.deps.supervisor.launchManagedCycle({
        programId: program.id,
        triggerKey: scheduledTriggerKey(program, dueAt),
        triggerKind: program.cadence.kind === "daily" ? "daily" : "interval",
        requestId: `due-${dueAt}`,
      });
    } catch (error) {
      if (
        error instanceof ContinuousSupervisorError &&
        (error.code === "open_cycle_exists" ||
          error.code === "lease_lost" ||
          error.code === "program_not_runnable")
      ) {
        // 重复 wake 撞开放 Cycle / workspace 被其它执行者占用 / 状态竞态：本轮跳过，
        // 不排队补跑（错过多轮只唤醒一次）。
        return null;
      }
      throw error;
    }
  }

  // ── 未结束 Cycle 的核对（§10 决策表）──────────────────────────

  private async reconcileCycle(
    program: Program,
    cycle: Cycle,
  ): Promise<{ cycleId: string; action: RecoveryAction; detail?: string }> {
    // suspended：不自动恢复——pending 继续确认与用量跨重启/跨日保留（R-11/E-32），
    // 用户同意前不恢复（continueSuspendedCycle 才是入口）。
    if (cycle.status === "suspended") {
      return { cycleId: cycle.id, action: "kept_suspended" };
    }
    const ref = referenceOf(cycle);
    let state: ExecutionState;
    try {
      state = await this.deps.execution.inspect(ref);
    } catch (error) {
      // 执行面暂不可用（断联/启动竞态）：退避重试，超限暂停询问。
      return await this.retryWithBackoff(program, cycle, error);
    }
    const live = (await this.deps.repository.getCycle(cycle.id)) ?? cycle;

    // preparing 且 Run 从未被接受（提交前崩溃，R-01）：按原身份重新 submitOnce——
    // 身份三元组来自 Cycle 行，不重新派生、不生成新 ID（ACK 丢失同理查原身份）。
    if (state.status === "pending" && live.status !== "settling") {
      try {
        await this.deps.supervisor.submitExistingCycle(live);
        return { cycleId: live.id, action: "resubmitted" };
      } catch (error) {
        if (error instanceof ContinuousSupervisorError && error.code === "lease_lost") {
          return { cycleId: live.id, action: "kept_interrupted", detail: "workspace 占用不可得" };
        }
        return await this.retryWithBackoff(program, live, error);
      }
    }

    // 执行仍活着：重新接入监督，不重复启动（§10「仍活着：重新连接」）。
    if (state.status === "running") {
      let health: HealthSnapshot;
      try {
        health = await this.deps.execution.inspectHealth(ref);
      } catch (error) {
        return await this.retryWithBackoff(program, live, error);
      }
      if (!health.reachable) {
        // journal 行 running 但执行者不可达（强杀）：按已中断处理——同 Run 有限条件 resume。
        return await this.resumeInterrupted(program, live, state);
      }
      const lease = await acquireCycleLease(
        {
          repository: this.deps.repository,
          execution: this.deps.execution,
          clock: this.deps.clock,
        },
        { workspaceKey: program.workspaceKey, cycleId: live.id, ownerId: this.ownerId() },
      );
      if (lease.status === "refused") {
        // 旧执行者仍活着/占用未过期：不启动第二写入者，保持现状（R-06/E-19）。
        return {
          cycleId: live.id,
          action: "kept_interrupted",
          detail: `lease 不可得（${lease.reason}）`,
        };
      }
      let current = live;
      if (live.leaseEpoch !== lease.epoch) {
        current = { ...live, leaseEpoch: lease.epoch, status: "running" };
        await this.deps.repository.saveCycle(current);
      }
      this.deps.supervisor.attachSupervision(current, program).catch(() => {
        // 监督失败由 supervisor 内部告警；核对结论已成立。
      });
      return { cycleId: live.id, action: "reattached" };
    }

    if (state.status === "stopped") {
      // 用户取消不自动恢复（§6/E-11/R-10）：停止路径崩溃在 settle 前的，补落 cancelled。
      if (state.stopReason === "user") {
        return await finalizeUserStoppedCycle(this.settlementDeps(), { program, cycle: live });
      }
      return await this.resumeInterrupted(program, live, state);
    }

    // completed/errored（含 settling 重放）：继续 settling，不 resume（R-05）。
    return await settleRecoveredCycle(this.settlementDeps(), { program, cycle: live, state });
  }

  private settlementDeps(): RecoverySettlementDeps {
    return {
      repository: this.deps.repository,
      execution: this.deps.execution,
      clock: this.deps.clock,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    };
  }

  private ownerId(): string {
    // 与 supervisor 实例一致的 owner 标识：通过受控属性读取（attach 面避免再开一条构造缝）。
    return this.deps.supervisor.ownerId();
  }

  /** stopped(interrupted/provider) 的有限条件恢复（R-10）：原快照、原身份、次数未超限。 */
  private async resumeInterrupted(
    program: Program,
    cycle: Cycle,
    state: ExecutionState,
  ): Promise<{ cycleId: string; action: RecoveryAction; detail?: string }> {
    const maxResume = program.budget.maxResumeAttempts;
    if (cycle.resumeAttempts >= maxResume) {
      // 恢复次数超限：暂停并询问，不自动结束任务（§10/R-10）。
      await suspendCycleForResumeLimit(this.settlementDeps(), {
        program,
        cycle,
        observed: {
          resumeAttempts: cycle.resumeAttempts,
          maxResumeAttempts: maxResume,
          stopReason: state.stopReason ?? null,
        },
      });
      return { cycleId: cycle.id, action: "suspend_ask" };
    }
    const lease = await acquireCycleLease(
      { repository: this.deps.repository, execution: this.deps.execution, clock: this.deps.clock },
      { workspaceKey: program.workspaceKey, cycleId: cycle.id, ownerId: this.ownerId() },
    );
    if (lease.status === "refused") {
      return {
        cycleId: cycle.id,
        action: "kept_interrupted",
        detail: `lease 不可得（${lease.reason}）`,
      };
    }
    const now = this.deps.clock.now();
    // R-03：恢复前重新核对 workspace（resolve worktree/HEAD）——外部改动不盲目重放；
    // 候选级 diff/检查点核对由 CT-02 的恢复面承担，这里只保证执行基线仍可解析。
    await this.deps.workspace.prepare({
      programId: program.id,
      workspacePath: program.workspacePath,
      baseCommit: "HEAD",
      branchName: program.branchName ?? `codex/continuous-${program.id}`,
    });
    // 提交前持久化：resume 次数与（可能的）接管 epoch 先落库，再恢复同 Run（§10）。
    const resumed: Cycle = {
      ...cycle,
      status: "running",
      resumeAttempts: cycle.resumeAttempts + 1,
      leaseEpoch: lease.epoch,
      updatedAt: now,
    };
    await this.deps.repository.saveCycle(resumed);
    try {
      await this.deps.execution.resume(referenceOf(resumed), lease.epoch);
    } catch (error) {
      // 不可恢复（如 not_resumable）：记录失败和证据，不冒充可恢复（§10）。
      await failCycleWithEvidence(this.settlementDeps(), { program, cycle: resumed, error });
      return { cycleId: cycle.id, action: "failed" };
    }
    this.deps.supervisor.attachSupervision(resumed, program).catch(() => {
      // 同上：监督失败由 supervisor 告警。
    });
    return { cycleId: cycle.id, action: "resumed" };
  }

  /** 临时失败的退避：30s/120s 自动重试，超限暂停询问（§2；不无限自动重试）。 */
  private async retryWithBackoff(
    program: Program,
    cycle: Cycle,
    error: unknown,
  ): Promise<{ cycleId: string; action: RecoveryAction; detail?: string }> {
    const attempts = (this.transientFailures.get(cycle.id) ?? 0) + 1;
    this.transientFailures.set(cycle.id, attempts);
    const message = error instanceof Error ? error.message : String(error);
    const backoff = recoveryBackoffMs(attempts);
    if (backoff === null) {
      await suspendCycleForResumeLimit(this.settlementDeps(), {
        program,
        cycle,
        observed: { attempts, message },
      });
      return { cycleId: cycle.id, action: "suspend_ask", detail: message };
    }
    const schedule = this.deps.clock.schedule ?? defaultSchedule;
    schedule(() => {
      void (async () => {
        const fresh = await this.deps.repository.getCycle(cycle.id);
        const freshProgram = await this.deps.repository.getProgram(program.id);
        if (!fresh || !freshProgram) return;
        await this.reconcileCycle(freshProgram, fresh);
      })().catch((retryError: unknown) => {
        this.deps.logger?.warn?.("Continuous recovery retry failed", {
          event: "continuous.recovery.retry_failed",
          cycleId: cycle.id,
          errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
        });
      });
    }, backoff);
    return { cycleId: cycle.id, action: "backoff_scheduled", detail: message };
  }
}
