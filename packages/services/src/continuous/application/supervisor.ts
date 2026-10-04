// Continuous Supervisor（CT-05）：手动完整 Cycle 的全链路编排（规格 §6/§7/§10/§11）。
//
// 链路（Run now）：Program 授权核对 → workspace 准备（CT-02）→ Cycle 快照（脚本 bytes/hash
// + 配置快照 + 执行身份提交前持久化）→ submitOnce（CT-03 受控提交，幂等）→ 轮询报告增量导入
// （reportIngestion，schema 校验后事务导入、itemKey 按 journal sequence 去重）→ Run 终态后
// settling（含「Run 失败也导入已保存报告」）→ 有限候选选择复核（candidatePolicy，保存选择
// 理由）→ 终态 Cycle 与 Program nextCycleAt 同事务（completeCycle，CT-01）→ 最终摘要 →
// sleeping。Cycle 快照构造与终局裁决在 supervisorLifecycle.ts（架构 max-file-lines 拆分，
// 非边界变化）。
//
// 状态所有者：本类是 Cycle 执行编排与结算的唯一写者（经 repository）；预算账本唯一写入者仍是
// ContinuousBudgetAdmission（CT-04），健康字段唯一写入者仍是 ContinuousHealthMonitor（CT-04）
// ——本类不重复写它们。services 不引用 AgentRuntime：执行经注入的 ContinuousExecutionPort。
//
// 已知边界（后续 ticket）：周期唤醒/租约 epoch 到每个副作用/中断恢复归 CT-07（本类的轮询与
// settle 面向手动单轮；suspended 的同 Run 恢复经 continueSuspendedCycle 提供最小实现）；
// Host/Desktop 装配与 UI 命令面归 CT-08。

import type { ContinuousErrorCode } from "@zcode/shared";
import type { Cycle, Program } from "../domain/types.js";
import { ContinuousReportIngestion } from "./reportIngestion.js";
import type { ContinuousReportItem } from "./ports.js";
import {
  accumulateInto,
  createAccumulator,
  createManagedCycleRecord,
  settleCycle,
  type ReportAccumulator,
  type SupervisedCycleOutcome,
} from "./supervisorLifecycle.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionReference,
  ExecutionState,
  WorkspacePreparationPort,
} from "./ports.js";

/** 版本化模板来源（Host 注入 bootstrap 的模板注册表；services 不 import CLI 实现）。 */
export interface ContinuousTemplateSource {
  resolve(ref: {
    templateId: string;
    templateVersion: string;
  }): { scriptText: string; scriptHash?: string } | null;
}

export class ContinuousSupervisorError extends Error {
  constructor(
    readonly code: ContinuousErrorCode | "open_cycle_exists" | "program_not_runnable",
    message: string,
  ) {
    super(message);
    this.name = "ContinuousSupervisorError";
  }
}

export interface ContinuousSupervisorDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  workspace: WorkspacePreparationPort;
  clock: ContinuousClockPort;
  templateSource: ContinuousTemplateSource;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
  /** 轮询间隔（缺省 500ms；测试可调小）。 */
  pollIntervalMs?: number;
}

export type { SupervisedCycleOutcome } from "./supervisorLifecycle.js";

export interface RunNowResult {
  cycle: Cycle;
  /** 结算完成时 resolve；Host 挂 catch 记日志，不留给 unhandled rejection。 */
  completion: Promise<SupervisedCycleOutcome>;
}

function referenceOf(cycle: Cycle): ExecutionReference {
  return {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
}

/** Run 终态判定（pending/running 继续轮询）。 */
function isTerminalExecution(status: ExecutionState["status"]): boolean {
  return status === "completed" || status === "errored" || status === "stopped";
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export class ContinuousSupervisor {
  private readonly pollIntervalMs: number;
  /**
   * 每个 Cycle 至多一条在飞监督循环（实例内）：重放的 Run now 复用同一 completion，
   * 不起第二条循环去重复结算（settle 的审计事件 event_key 会撞 UNIQUE；跨进程的重复
   * 监督由恢复流程核对执行身份处理，CT-07）。
   */
  private readonly activeSupervision = new Map<string, Promise<SupervisedCycleOutcome>>();

  constructor(private readonly deps: ContinuousSupervisorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
  }

  /** 手动触发一轮（requestId 幂等：重复 Run now 不创建第二个 Cycle/Run，规格 §10）。 */
  async runNow(input: { programId: string; requestId: string }): Promise<RunNowResult> {
    const program = await this.deps.repository.getProgram(input.programId);
    if (!program) {
      throw new ContinuousSupervisorError(
        "capability_missing",
        `program 不存在: ${input.programId}`,
      );
    }
    if (program.remoteSessionId !== undefined) {
      // D4：第一版仅本地 workspace；远程启动结构化拒绝，不退回普通 prompt 执行。
      throw new ContinuousSupervisorError(
        "remote_execution_not_supported",
        `program ${program.id} 绑定远程会话，第一版不支持远程自主执行`,
      );
    }
    if (
      program.status === "paused" ||
      program.status === "failed" ||
      program.status === "completed"
    ) {
      throw new ContinuousSupervisorError(
        "program_not_runnable",
        `program ${program.id} 状态 ${program.status} 不可 Run now（paused/failed 需显式恢复）`,
      );
    }
    const prepared = await this.ensureWorkspace(program);
    let current = program;
    if (program.executionPath === undefined) {
      current = {
        ...program,
        executionPath: prepared.executionPath,
        branchName: prepared.branchName,
      };
    }

    const triggerKey = `manual:${input.requestId}`;
    const open = await this.deps.repository.getOpenCycle(current.id);
    let cycle: Cycle;
    if (open) {
      // 幂等重放：同 triggerKey 的重发命中同一 Cycle（同 session/run 身份再 submitOnce 幂等复用，
      // 绝不铸第二个引擎）；不同 trigger 的并发请求拒绝——一个 Program 最多一个未结束 Cycle。
      if (open.triggerKey !== triggerKey) {
        throw new ContinuousSupervisorError(
          "open_cycle_exists",
          `program ${current.id} 已有未结束 cycle ${open.id}（trigger ${open.triggerKey}）`,
        );
      }
      cycle = open;
    } else {
      cycle = await this.createManagedCycle(
        current,
        triggerKey,
        input.requestId,
        prepared.baseCommit,
      );
    }

    await this.deps.execution.submitOnce({
      programId: current.id,
      cycleId: cycle.id,
      executionSessionId: cycle.executionSessionId,
      workflowRunId: cycle.workflowRunId,
      traceId: cycle.traceId,
      executionPath: prepared.executionPath,
      scriptText: cycle.scriptText,
      scriptHash: cycle.scriptHash,
      configurationSnapshot: cycle.configurationSnapshot,
    });
    const now = this.deps.clock.now();
    cycle = { ...cycle, status: "running", startedAt: now, updatedAt: now };
    await this.deps.repository.saveCycle(cycle);
    await this.activateProgram(current);
    return { cycle, completion: this.startSupervision(cycle, current) };
  }

  /**
   * suspended Cycle 的同 Run 继续（§6.1：用户授权 grant 后恢复同一 Cycle/Run，不铸新执行）。
   * 前置：继续确认已 resolved 且选择了继续；run 仍活着走 resumeSuspended，已 stopped 可恢复
   * 走 resume——两者都不换脚本、不换身份（E-20/R-10 的语义在此层锁定）。
   */
  async continueSuspendedCycle(cycleId: string): Promise<RunNowResult> {
    const cycle = await this.deps.repository.getCycle(cycleId);
    if (!cycle)
      throw new ContinuousSupervisorError("capability_missing", `cycle 不存在: ${cycleId}`);
    if (cycle.status !== "suspended") {
      throw new ContinuousSupervisorError(
        "program_not_runnable",
        `cycle ${cycleId} 状态 ${cycle.status} 非 suspended`,
      );
    }
    const pending = await this.deps.repository.getPendingContinuationRequest(cycleId);
    if (pending) {
      throw new ContinuousSupervisorError(
        "program_not_runnable",
        `cycle ${cycleId} 继续确认尚未回答 (${pending.id})`,
      );
    }
    const requestId = cycle.pendingContinuationRequestId;
    if (requestId !== undefined) {
      const request = await this.deps.repository.getContinuationRequest(requestId);
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
    const program = await this.deps.repository.getProgram(cycle.programId);
    if (!program) {
      throw new ContinuousSupervisorError(
        "capability_missing",
        `program 不存在: ${cycle.programId}`,
      );
    }
    const ref = referenceOf(cycle);
    const state = await this.deps.execution.inspect(ref);
    if (state.status === "stopped" && state.resumable) {
      await this.deps.execution.resume(ref, cycle.leaseEpoch);
    } else {
      await this.deps.execution.resumeSuspended(ref, cycle.leaseEpoch);
    }
    const now = this.deps.clock.now();
    const resumed: Cycle = { ...cycle, status: "running", updatedAt: now };
    await this.deps.repository.saveCycle(resumed);
    await this.activateProgram(program);
    return { cycle: resumed, completion: this.startSupervision(resumed, program) };
  }

  // ── 内部：Cycle 创建与 workspace ────────────────────────────

  private async createManagedCycle(
    program: Program,
    triggerKey: string,
    requestId: string,
    baseCommit: string,
  ): Promise<Cycle> {
    const template = this.deps.templateSource.resolve({
      templateId: program.templateId,
      templateVersion: program.templateVersion,
    });
    // 授权绑定与快照构造在 supervisorLifecycle（模板 hash 不符 → 结构化拒绝，绝不带病启动）。
    const result = await createManagedCycleRecord(this.deps.repository, {
      program,
      triggerKey,
      requestId,
      baseCommit,
      template,
      now: this.deps.clock.now(),
    });
    if (!result.ok) throw new ContinuousSupervisorError(result.code, result.message);
    return result.cycle;
  }

  /**
   * workspace 准备（幂等；CT-02 的 prepare 对已登记 worktree 复用并重新解析 HEAD——
   * 每轮起始 commit 以 prepare 返回为准，不用缓存的 executionPath 冒充 baseCommit）。
   */
  private async ensureWorkspace(program: Program): Promise<{
    executionPath: string;
    branchName: string;
    baseCommit: string;
  }> {
    const branchName = program.branchName ?? `codex/continuous-${program.id}`;
    const prepared = await this.deps.workspace.prepare({
      programId: program.id,
      workspacePath: program.workspacePath,
      baseCommit: "HEAD",
      branchName,
    });
    if (program.executionPath === undefined || program.branchName === undefined) {
      await this.deps.repository.saveProgram({
        ...program,
        executionPath: prepared.executionPath,
        branchName: prepared.branchName,
        updatedAt: this.deps.clock.now(),
      });
    }
    return {
      executionPath: prepared.executionPath,
      branchName: prepared.branchName,
      baseCommit: prepared.baseCommit,
    };
  }

  private async activateProgram(program: Program): Promise<void> {
    if (program.status === "active") return;
    await this.deps.repository.saveProgram({
      ...program,
      status: "active",
      ...(program.statusReason === undefined ? {} : { statusReason: undefined }),
      updatedAt: this.deps.clock.now(),
    });
  }

  // ── 内部：监督循环（终局裁决在 supervisorSettlement.settleCycle）──────────

  /** 起（或复用）一条监督循环；每 Cycle 实例内至多一条，防重复结算。 */
  private startSupervision(cycle: Cycle, program: Program): Promise<SupervisedCycleOutcome> {
    const existing = this.activeSupervision.get(cycle.id);
    if (existing !== undefined) return existing;
    const completion = this.supervise(cycle, program)
      .catch((error: unknown) => {
        this.deps.logger?.warn?.("Continuous cycle supervision failed", {
          event: "continuous.supervisor.error",
          module: "services.continuous",
          cycleId: cycle.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.activeSupervision.delete(cycle.id);
      });
    this.activeSupervision.set(cycle.id, completion);
    return completion;
  }

  private async supervise(cycle: Cycle, program: Program): Promise<SupervisedCycleOutcome> {
    const ref = referenceOf(cycle);
    const accumulator = createAccumulator();
    let lastState: ExecutionState | undefined;

    while (true) {
      const current = (await this.deps.repository.getCycle(cycle.id)) ?? cycle;
      // suspended（资源挂起/立即停止）由其他路径落库：监督到此为止，交还继续确认/停止流程。
      if (
        current.status === "suspended" ||
        current.status === "interrupted" ||
        current.status === "cancelled"
      ) {
        return {
          cycleId: cycle.id,
          cycleStatus: current.status,
          programStatus: program.status,
          reportRejections: accumulator.rejections,
        };
      }
      const batch = await this.deps.execution.readReports(ref, current.reportCursor);
      if (batch.items.length > 0) {
        await this.ingest(cycle, program, batch.items, batch.nextCursor, accumulator);
      }
      lastState = await this.deps.execution.inspect(ref);
      if (isTerminalExecution(lastState.status)) break;
      await this.waitInterval();
    }
    await this.deps.execution.waitForQuiescence(ref);
    return await settleCycle(this.deps, {
      cycle,
      program,
      ref,
      finalState: lastState!,
      accumulator,
    });
  }

  private async ingest(
    cycle: Cycle,
    program: Program,
    items: ContinuousReportItem[],
    nextCursor: number,
    accumulator: ReportAccumulator,
  ): Promise<void> {
    const outcome = await new ContinuousReportIngestion({
      repository: this.deps.repository,
      clock: this.deps.clock,
    }).ingestBatch({
      programId: program.id,
      cycleId: cycle.id,
      items,
      nextCursor,
    });
    accumulateInto(accumulator, outcome);
  }

  private async waitInterval(): Promise<void> {
    const schedule = this.deps.clock.schedule ?? defaultSchedule;
    await new Promise<void>((resolve) => {
      schedule(resolve, this.pollIntervalMs);
    });
  }
}
