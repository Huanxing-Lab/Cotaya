// ContinuousCommandService（CT-08）：IContinuousService 命令面的唯一实现。
// Host 装配（经 ServiceChannels.Continuous + ProxyChannel 暴露给 renderer；Electron 侧
// 装配本身在 CT-09 集成）把本类接到 CT-01…07 的服务栈上：
//   读面  —— repository（snapshot/programDetail/templates）；
//   写面  —— supervisor（runNow/stop）/ supervisorControl（pause/resume）/
//            decisionService（resolve/dismiss）/ continuationService（继续确认）。
// 本层不做业务判定：状态门、幂等、version、lease 全部沿用既有服务；这里只做归属校验、
// 错误映射（continuousCommandErrors）与视图投影（continuousViews）。UI 只消费 snapshot/
// detail，不在本地另建接受队列。

import {
  CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
  type ContinuousArchiveProgramParams,
  type ContinuousCapabilityResult,
  type ContinuousCreateProgramParams,
  type ContinuousDismissDecisionParams,
  type ContinuousPauseProgramParams,
  type ContinuousPlatformExecution,
  type ContinuousProgramDetailParams,
  type ContinuousProgramDetailResult,
  type ContinuousResolveContinuationParams,
  type ContinuousResolveContinuationResult,
  type ContinuousResolveDecisionParams,
  type ContinuousResumeProgramParams,
  type ContinuousRunNowParams,
  type ContinuousSnapshotParams,
  type ContinuousSnapshotResult,
  type ContinuousStopCurrentCycleParams,
  type ContinuousTemplatesParams,
  type ContinuousTemplatesResult,
} from "@zcode/shared";
import type { Cycle, Program } from "../domain/types.js";
import { dayWindowFor } from "../domain/budgetPolicy.js";
import type { ContinuousRepositoryPort } from "./ports.js";
import { ContinuousService } from "./continuousService.js";
import { ContinuousSupervisor, type ContinuousTemplateSource } from "./supervisor.js";
import { pauseProgram, resumeProgram } from "./supervisorControl.js";
import { ContinuousDecisionService } from "./decisionService.js";
import { ContinuousContinuationService } from "./continuationService.js";
import { CONTINUOUS_DETAIL_RECENT_CYCLES, assembleProgramDetail } from "./continuousViews.js";
import { commandError, requireProgramOf, toCommandError } from "./continuousCommandErrors.js";
import { resolveContinuationCommand } from "./continuousContinuationCommands.js";
import type { IContinuousService } from "../contract-interfaces.js";
import type { IContinuousQueryService } from "../contract-interfaces.js";

export interface ContinuousCommandServiceDeps {
  repository: ContinuousRepositoryPort;
  supervisor: ContinuousSupervisor;
  templateSource: ContinuousTemplateSource;
  clock: { now(): number; timeZone(): string };
  /**
   * 实际运行平台并发能力（§12「不能隐藏较低的机器限制」）。Host 装配时由执行面注入；
   * 缺省回落到 Program 预算值——只在真的没有更准事实时使用，不伪称平台能力。
   */
  platformConcurrency?: (program: Program) => number;
  /**
   * 平台执行能力评估（CT-10，规格 §13）：Host 装配时经 shared
   * assessContinuousPlatformExecution({platform, arch}) 计算注入；capability 结果携带
   * 该评估供 UI 解释 observe_only（E-24「可观察的模式明确只读」）。缺席时不伪造——
   * capability 不带 platform 字段（supervisor 侧的启动门仍独立强制）。
   */
  platformExecution?: ContinuousPlatformExecution;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

export class ContinuousCommandService implements IContinuousService, IContinuousQueryService {
  private readonly store: ContinuousService;
  private readonly decisions: ContinuousDecisionService;
  private readonly continuations: ContinuousContinuationService;

  constructor(private readonly deps: ContinuousCommandServiceDeps) {
    this.store = new ContinuousService({ repository: deps.repository, clock: deps.clock });
    this.decisions = new ContinuousDecisionService({
      repository: deps.repository,
      clock: deps.clock,
    });
    this.continuations = new ContinuousContinuationService({
      repository: deps.repository,
      clock: deps.clock,
    });
  }

  capability(): ContinuousCapabilityResult {
    // 装配即支持：本类被构造 = Host 显式开启了 managed cycles（默认关闭时根本不注册）。
    // 协议小版本 1 = CT-08 的 additive 读/回答面（templates/programDetail/resolveContinuation）。
    // platform（CT-10 additive）：observe_only 平台的「只提供观察」解释面（§13/E-24）；
    // 缺席 = 装配者未注入评估（不伪造平台事实；supervisor 启动门仍独立强制）。
    return {
      supported: true,
      capability: CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
      version: 1,
      ...(this.deps.platformExecution === undefined
        ? {}
        : { platform: this.deps.platformExecution }),
    };
  }

  async snapshot(params: ContinuousSnapshotParams): Promise<ContinuousSnapshotResult> {
    const programs = await this.deps.repository.listPrograms(params.context.workspaceKey);
    const at = this.deps.clock.now();
    return {
      programs: await Promise.all(
        programs.map(async (program) => {
          const open = await this.deps.repository.getOpenCycle(program.id);
          const pendingDecisions = await this.deps.repository.listPendingDecisions(program.id);
          const pendingContinuation = open
            ? await this.deps.repository.getPendingContinuationRequest(open.id)
            : null;
          return {
            programId: program.id,
            workspaceKey: program.workspaceKey,
            workspacePath: program.workspacePath,
            ...(program.workspaceIdentity === undefined
              ? {}
              : { workspaceIdentity: program.workspaceIdentity }),
            ...(program.remoteSessionId === undefined
              ? {}
              : { remoteSessionId: program.remoteSessionId }),
            revision: program.revision,
            goal: program.goal,
            status: program.status,
            ...(program.statusReason === undefined ? {} : { statusReason: program.statusReason }),
            nextCycleAt: program.nextCycleAt ?? null,
            currentCycleId: open?.id ?? null,
            pendingDecisionCount: pendingDecisions.length,
            pendingContinuationRequestId: pendingContinuation?.id ?? null,
            updatedAt: program.updatedAt,
          };
        }),
      ),
      at,
    };
  }

  async listTemplates(_params: ContinuousTemplatesParams): Promise<ContinuousTemplatesResult> {
    return { templates: this.deps.templateSource.list?.() ?? [] };
  }

  async createProgram(params: ContinuousCreateProgramParams): Promise<Program> {
    // D4：第一版仅本地 workspace；远程身份结构化拒绝，不回退普通 prompt 执行。
    if (params.context.remoteSessionId !== undefined) {
      throw commandError(
        "remote_execution_not_supported",
        "第一版 Continuous 仅支持本地 workspace",
      );
    }
    const resolved = this.deps.templateSource.resolve({
      templateId: params.template.templateId,
      templateVersion: params.template.templateVersion,
    });
    // 模板不可用或 hash 与授权不符：明确失败，不静默换脚本（§6/§11）。
    if (
      !resolved ||
      (resolved.scriptHash !== undefined && resolved.scriptHash !== params.template.templateHash)
    ) {
      throw commandError(
        "template_mismatch",
        `模板不可用或 hash 不符: ${params.template.templateId}@${params.template.templateVersion}`,
      );
    }
    return this.store.createProgram({
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity === undefined
        ? {}
        : { workspaceIdentity: params.context.workspaceIdentity }),
      goal: params.goal,
      timeZone: this.deps.clock.timeZone(),
      scope: params.scope,
      budget: params.budget,
      cadence: params.cadence,
      decisionPolicy: params.decisionPolicy,
      templateId: params.template.templateId,
      templateVersion: params.template.templateVersion,
      templateHash: params.template.templateHash,
      authorization: {
        revision: 1,
        templateHash: params.template.templateHash,
        grantedAt: new Date(this.deps.clock.now()).toISOString(),
      },
    });
  }

  async runNow(params: ContinuousRunNowParams): Promise<Cycle> {
    try {
      await requireProgramOf(this.deps.repository, params);
      const result = await this.deps.supervisor.runNow({
        programId: params.programId,
        requestId: params.requestId,
      });
      return result.cycle;
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async pauseProgram(params: ContinuousPauseProgramParams): Promise<Program> {
    try {
      await requireProgramOf(this.deps.repository, params);
      return await pauseProgram(
        { repository: this.deps.repository, clock: this.deps.clock },
        { programId: params.programId },
      );
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async resumeProgram(params: ContinuousResumeProgramParams): Promise<Program> {
    try {
      await requireProgramOf(this.deps.repository, params);
      return await resumeProgram(
        { repository: this.deps.repository, clock: this.deps.clock },
        { programId: params.programId },
      );
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async stopCurrentCycle(params: ContinuousStopCurrentCycleParams): Promise<Cycle> {
    try {
      await requireProgramOf(this.deps.repository, params);
      return await this.deps.supervisor.stopCurrentCycle({
        programId: params.programId,
        epoch: params.epoch,
      });
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async resolveDecision(params: ContinuousResolveDecisionParams): Promise<void> {
    try {
      await requireProgramOf(this.deps.repository, params);
      await this.decisions.resolveDecision({
        programId: params.programId,
        decisionId: params.decisionId,
        version: params.version,
        ...(params.optionId === undefined ? {} : { optionId: params.optionId }),
        ...(params.text === undefined ? {} : { text: params.text }),
      });
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async dismissDecision(params: ContinuousDismissDecisionParams): Promise<void> {
    try {
      await requireProgramOf(this.deps.repository, params);
      await this.decisions.dismissDecision({
        programId: params.programId,
        decisionId: params.decisionId,
        version: params.version,
      });
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async archiveProgram(params: ContinuousArchiveProgramParams): Promise<void> {
    try {
      const program = await requireProgramOf(this.deps.repository, params);
      // 归档前必须没有主动执行（§5）；suspended/interrupted 也是未结束，同样拒绝。
      const open = await this.deps.repository.getOpenCycle(program.id);
      if (open) {
        throw commandError(
          "execution_not_quiescent",
          `program ${program.id} 存在未结束 cycle ${open.id}（状态 ${open.status}），不能归档`,
        );
      }
      await this.deps.repository.saveProgram({
        ...program,
        archivedAt: this.deps.clock.now(),
        updatedAt: this.deps.clock.now(),
      });
    } catch (error) {
      throw toCommandError(error);
    }
  }

  async programDetail(
    params: ContinuousProgramDetailParams,
  ): Promise<ContinuousProgramDetailResult> {
    const program = await requireProgramOf(this.deps.repository, params);
    const currentCycle = await this.deps.repository.getOpenCycle(program.id);
    const recentCycles = await this.deps.repository.listRecentCycles(
      program.id,
      CONTINUOUS_DETAIL_RECENT_CYCLES,
    );
    const [candidates, decisions, lease] = await Promise.all([
      this.deps.repository.listCandidates(program.id),
      this.deps.repository.listDecisions(program.id),
      this.deps.repository.getLease(program.workspaceKey),
    ]);
    const continuationRequest = currentCycle
      ? await this.deps.repository.getPendingContinuationRequest(currentCycle.id)
      : null;
    // 日窗口按 Program 持久化时区统计（§9）：预留时发生时间决定归属窗口，这里只框边界。
    const now = this.deps.clock.now();
    const window = dayWindowFor(now, program.timeZone);
    const [dailyUsage, cycleUsage] = await Promise.all([
      this.deps.repository.summarizeUsage({
        programId: program.id,
        windowFromMs: window.startMs,
        windowToMs: window.endMs,
      }),
      currentCycle
        ? this.deps.repository.summarizeUsage({ programId: program.id, cycleId: currentCycle.id })
        : null,
    ]);
    return assembleProgramDetail({
      program,
      currentCycle,
      recentCycles,
      candidates,
      decisions,
      continuationRequest,
      dailyUsage,
      cycleUsage,
      lease: lease
        ? {
            epoch: lease.epoch,
            ownerId: lease.ownerId ?? null,
            cycleId: lease.cycleId ?? null,
            expiresAt: lease.expiresAt ?? null,
          }
        : null,
      platformConcurrency:
        this.deps.platformConcurrency?.(program) ?? program.budget.maxConcurrentActors,
      at: now,
    });
  }

  async resolveContinuation(
    params: ContinuousResolveContinuationParams,
  ): Promise<ContinuousResolveContinuationResult> {
    try {
      return await resolveContinuationCommand(
        {
          repository: this.deps.repository,
          supervisor: this.deps.supervisor,
          store: this.store,
          continuations: this.continuations,
          clock: this.deps.clock,
        },
        params,
      );
    } catch (error) {
      throw toCommandError(error);
    }
  }
}
