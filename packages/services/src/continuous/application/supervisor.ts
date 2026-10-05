// Continuous Supervisor（CT-05）：Cycle 执行编排与结算的唯一写者（规格 §6/§7/§10/§11）。
//
// 链路（Run now / scheduled wake 共用 launchManagedCycle）：Program 授权核对 → workspace
// 准备（CT-02）→ Cycle 快照（脚本 bytes/hash + 配置快照 + 执行身份提交前持久化）→ workspace
// lease（CT-07：提交前取得执行权，同 Cycle 同 owner 重入幂等续租）→ submitOnce（CT-03 受控
// 提交，幂等）→ 轮询报告增量导入（reportIngestion）→ Run 终态后 settling（含「Run 失败也
// 导入已保存报告」）→ 有限候选选择复核（candidatePolicy）→ 终态 Cycle 与 Program
// nextCycleAt 同事务（completeCycle，CT-01）→ 释放 lease（suspended/interrupted 保留占用）。
// Cycle 快照构造与终局裁决在 supervisorLifecycle.ts；控制面（暂停/立即停止/继续/配置变更）
// 在 supervisorControl.ts（架构 max-file-lines 拆分，非边界变化）。
//
// 状态所有者：本类是 Cycle 执行编排与结算的唯一写者（经 repository）；预算账本唯一写入者仍是
// ContinuousBudgetAdmission（CT-04），健康字段唯一写入者仍是 ContinuousHealthMonitor（CT-04）
// ——本类不重复写它们。services 不引用 AgentRuntime：执行经注入的 ContinuousExecutionPort。
//
// 已知边界（后续 ticket）：Host/Desktop 装配与 UI 命令面归 CT-08；周期唤醒的到期判定与
// 重启核对编排归 recovery.ts（本类提供 launchManagedCycle/submitExistingCycle/attachSupervision
// 三个可注入入口）。

import { randomUUID } from "node:crypto";
import type { ContinuousPlatformExecutionMode } from "@zcode/shared";
import type { Cycle, CycleTriggerKind, Program } from "../domain/types.js";
import { manualTriggerKey } from "../domain/cadencePolicy.js";
import { continueSuspendedCycle, stopCurrentCycle } from "./supervisorControl.js";
import { inspectCycleExecutionOf } from "./supervisorResume.js";
import { watchCycle } from "./supervisorWatch.js";
import { acquireCycleLease, type WorkspaceLeaseDeps } from "./workspaceLease.js";
import {
  ContinuousSupervisorError,
  requireAutonomousPlatformExecution,
} from "./supervisorLifecycle.js";
import { createManagedCycleRow, ensureWorkspacePrepared } from "./supervisorPrepare.js";
import type {
  ContinuousClockPort,
  ContinuousExecutionPort,
  ContinuousRepositoryPort,
  ExecutionState,
  WorkspacePreparationPort,
} from "./ports.js";

/** 版本化模板来源（Host 注入 bootstrap 的模板注册表；services 不 import CLI 实现）。 */
export interface ContinuousTemplateSource {
  resolve(ref: {
    templateId: string;
    templateVersion: string;
  }): { scriptText: string; scriptHash?: string } | null;
  /**
   * 可用模板目录（CT-08 创建授权表单的 UI 读面）。可选：Host 注入的注册表提供
   * templateId@version + 脚本 sha256；缺席时命令门面按「注册表未提供目录」返回空列表。
   */
  list?(): Array<{ templateId: string; templateVersion: string; templateHash: string }>;
}

export { ContinuousSupervisorError } from "./supervisorLifecycle.js";
export type { RunNowResult, SupervisedCycleOutcome } from "./supervisorLifecycle.js";
import type { RunNowResult, SupervisedCycleOutcome } from "./supervisorLifecycle.js";

export interface ContinuousSupervisorDeps {
  repository: ContinuousRepositoryPort;
  execution: ContinuousExecutionPort;
  workspace: WorkspacePreparationPort;
  clock: ContinuousClockPort;
  templateSource: ContinuousTemplateSource;
  /**
   * 平台执行模式（CT-10，规格 §13）：Host 装配时经 shared
   * assessContinuousPlatformExecution({platform, arch}) 评估注入；observe_only 平台拒绝
   * 启动/恢复自主实施（结构化 platform_execution_not_supported），观察读面不受影响。
   * 必填：装配者必须显式回答平台能力，不允许缺省视为 autonomous（fail closed）。
   */
  platformExecutionMode: ContinuousPlatformExecutionMode;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
  /** 轮询间隔（缺省 500ms；测试可调小）。 */
  pollIntervalMs?: number;
  /** workspace lease 的 owner 标识（Host 实例维度）；缺省每实例随机派生。 */
  ownerId?: string;
}

export class ContinuousSupervisor {
  private readonly pollIntervalMs: number;
  private readonly ownerIdField: string;
  /**
   * 每个 Cycle 至多一条在飞监督循环（实例内）：重放的 Run now 复用同一 completion，
   * 不起第二条循环去重复结算（settle 的审计事件 event_key 会撞 UNIQUE；跨进程的重复
   * 监督由恢复流程核对执行身份处理，CT-07 recovery）。
   */
  private readonly activeSupervision = new Map<string, Promise<SupervisedCycleOutcome>>();

  constructor(private readonly deps: ContinuousSupervisorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.ownerIdField = deps.ownerId ?? `cthost-${randomUUID()}`;
  }

  /** 本实例的 lease owner 标识（恢复流程与控制面用它对齐占用归属）。 */
  ownerId(): string {
    return this.ownerIdField;
  }

  /** 手动触发一轮（requestId 幂等：重复 Run now 不创建第二个 Cycle/Run，规格 §10）。 */
  async runNow(input: { programId: string; requestId: string }): Promise<RunNowResult> {
    return this.launchManagedCycle({
      programId: input.programId,
      triggerKey: manualTriggerKey(input.requestId),
      triggerKind: "manual",
      requestId: input.requestId,
    });
  }

  /**
   * 通用启动入口（manual / scheduled 共用；wake 链路经 recovery 进入）：
   * 状态/身份门 → workspace 准备 → Cycle 创建或幂等重放 → lease → submitOnce → 监督。
   */
  async launchManagedCycle(input: {
    programId: string;
    triggerKey: string;
    triggerKind: CycleTriggerKind;
    requestId: string;
  }): Promise<RunNowResult> {
    requireAutonomousPlatformExecution(this.deps.platformExecutionMode, "launchManagedCycle");
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
        `program ${program.id} 状态 ${program.status} 不可启动（paused/failed 需显式恢复）`,
      );
    }
    const prepared = await ensureWorkspacePrepared(this.prepareDeps(), program);
    let current = program;
    if (program.executionPath === undefined) {
      current = {
        ...program,
        executionPath: prepared.executionPath,
        branchName: prepared.branchName,
      };
    }
    const open = await this.deps.repository.getOpenCycle(current.id);
    let cycle: Cycle;
    if (open) {
      // 幂等重放：同 triggerKey 的重发命中同一 Cycle（同 session/run 身份再 submitOnce 幂等复用，
      // 绝不铸第二个引擎）；不同 trigger 的并发请求拒绝——一个 Program 最多一个未结束 Cycle。
      if (open.triggerKey !== input.triggerKey) {
        throw new ContinuousSupervisorError(
          "open_cycle_exists",
          `program ${current.id} 已有未结束 cycle ${open.id}（trigger ${open.triggerKey}）`,
        );
      }
      cycle = open;
    } else {
      // 同 trigger key 的终态行（上一轮已完成后的迟到重发/ACK 丢失）：幂等返回既有结论，
      // 不重提交（终态 Run 拒绝重提交；重复 Run now 不能创建第二个 Run，§10）。
      const existing = await this.deps.repository.getCycleByTriggerKey(
        current.id,
        input.triggerKey,
      );
      if (existing !== null) {
        return {
          cycle: existing,
          completion: Promise.resolve({
            cycleId: existing.id,
            cycleStatus: existing.status,
            programStatus: current.status,
            reportRejections: 0,
          }),
        };
      }
      cycle = await createManagedCycleRow(this.prepareDeps(), current, input, prepared.baseCommit);
    }
    return this.startOrResumeCycle(current, prepared.executionPath, cycle);
  }

  /**
   * 恢复入口（R-01）：对已持久化的 preparing/中断 Cycle 按原执行身份重新提交。
   * 身份三元组来自 Cycle 行本身——不重新派生、不生成新 ID（ACK 丢失查原身份，§10）。
   */
  async submitExistingCycle(cycle: Cycle): Promise<RunNowResult> {
    // 平台门同样覆盖恢复重提交：observe_only 平台不允许经恢复路径重启自主实施。
    requireAutonomousPlatformExecution(this.deps.platformExecutionMode, "submitExistingCycle");
    const program = await this.deps.repository.getProgram(cycle.programId);
    if (!program) {
      throw new ContinuousSupervisorError(
        "capability_missing",
        `program 不存在: ${cycle.programId}`,
      );
    }
    const prepared = await ensureWorkspacePrepared(this.prepareDeps(), program);
    return this.startOrResumeCycle(program, prepared.executionPath, cycle);
  }

  /** suspended Cycle 的同 Run 继续（§6.1）；实现随控制面落在 supervisorControl.ts。 */
  continueSuspendedCycle(cycleId: string): Promise<RunNowResult> {
    // 用户继续授权不能越过平台能力规则（§6.1「Scope 禁止项不能通过继续绕过」同款纪律）。
    requireAutonomousPlatformExecution(this.deps.platformExecutionMode, "continueSuspendedCycle");
    return continueSuspendedCycle(
      {
        repository: this.deps.repository,
        execution: this.deps.execution,
        clock: this.deps.clock,
        ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
        attachSupervision: (cycle, program) => this.startSupervision(cycle, program),
      },
      cycleId,
      this.ownerIdField,
    );
  }

  /**
   * 立即停止本轮（§6/E-11）：控制面语义在 supervisorControl.ts；命令门面（CT-08）经本方法
   * 走同一条路，不另写第二条停止链（与 continueSuspendedCycle 同款委托）。
   * attachSupervision 仅继续路径需要——stop 链路不恢复监督，缺席实现刻意大声失败。
   */
  stopCurrentCycle(params: { programId: string; epoch: number }): Promise<Cycle> {
    return stopCurrentCycle(
      {
        repository: this.deps.repository,
        execution: this.deps.execution,
        clock: this.deps.clock,
        ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
        attachSupervision: () => {
          throw new Error("stopCurrentCycle 不恢复监督循环（停止链路不调用 attachSupervision）");
        },
      },
      params,
    );
  }

  /**
   * 详情读面的执行状态窄缝（CT-13）：实现随继续/恢复判定在 supervisorResume.ts
   * （inspectCycleExecutionOf）；errored Run 的旧预算轮据此显示「不可恢复」。
   */
  async inspectCycleExecution(cycleId: string): Promise<ExecutionState | null> {
    return await inspectCycleExecutionOf(
      { repository: this.deps.repository, execution: this.deps.execution },
      cycleId,
    );
  }

  // ── 内部：Cycle 创建、lease 与 workspace（创建/准备在 supervisorPrepare.ts）────────

  private prepareDeps() {
    return {
      repository: this.deps.repository,
      workspace: this.deps.workspace,
      clock: this.deps.clock,
      templateSource: this.deps.templateSource,
    };
  }

  private leaseDeps(): WorkspaceLeaseDeps {
    return {
      repository: this.deps.repository,
      execution: this.deps.execution,
      clock: this.deps.clock,
    };
  }

  /**
   * lease → submitOnce → running → 监督（manual 重放与恢复共用；§10「原子创建 Cycle 和
   * 取得 workspace lease」——Cycle 行先落库（UNIQUE 约束去重），提交前取得执行权）。
   */
  private async startOrResumeCycle(
    program: Program,
    executionPath: string,
    cycle: Cycle,
  ): Promise<RunNowResult> {
    const lease = await acquireCycleLease(this.leaseDeps(), {
      workspaceKey: program.workspaceKey,
      cycleId: cycle.id,
      ownerId: this.ownerIdField,
    });
    if (lease.status === "refused") {
      // 一个 workspaceKey 最多一个主动执行者；占用中的 Cycle（含 suspended 保留占用）不接管。
      throw new ContinuousSupervisorError(
        "lease_lost",
        `workspace ${program.workspaceKey} 执行权不可得（${lease.reason}），不启动本轮`,
      );
    }
    if (cycle.leaseEpoch !== lease.epoch) {
      cycle = { ...cycle, leaseEpoch: lease.epoch };
      await this.deps.repository.saveCycle(cycle);
    }
    await this.deps.execution.submitOnce({
      programId: program.id,
      cycleId: cycle.id,
      executionSessionId: cycle.executionSessionId,
      workflowRunId: cycle.workflowRunId,
      traceId: cycle.traceId,
      executionPath,
      scriptText: cycle.scriptText,
      scriptHash: cycle.scriptHash,
      configurationSnapshot: cycle.configurationSnapshot,
      // CT-12：执行权版本随提交下发——wire 执行端口据此先登记（leaseEpoch 贯穿预算/写入/
      // 提交，规格 §10），旧 epoch 的登记在 CLI 侧被拒。
      leaseEpoch: cycle.leaseEpoch,
    });
    const now = this.deps.clock.now();
    cycle = { ...cycle, status: "running", startedAt: cycle.startedAt ?? now, updatedAt: now };
    await this.deps.repository.saveCycle(cycle);
    await this.activateProgram(program);
    return { cycle, completion: this.startSupervision(cycle, program) };
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

  // ── 内部：监督循环（终局裁决在 supervisorLifecycle.settleCycle）──────────

  /** 起（或复用）一条监督循环；每 Cycle 实例内至多一条，防重复结算。 */
  private startSupervision(cycle: Cycle, program: Program): Promise<SupervisedCycleOutcome> {
    const existing = this.activeSupervision.get(cycle.id);
    if (existing !== undefined) return existing;
    const completion = watchCycle(
      {
        repository: this.deps.repository,
        execution: this.deps.execution,
        clock: this.deps.clock,
        ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
        pollIntervalMs: this.pollIntervalMs,
      },
      { cycle, program, ownerId: this.ownerIdField },
    )
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

  /** 恢复流程接入既有 Cycle 的监督（不重新提交；执行仍活着/同身份 resume 后调用）。 */
  attachSupervision(cycle: Cycle, program: Program): Promise<SupervisedCycleOutcome> {
    return this.startSupervision(cycle, program);
  }
}
