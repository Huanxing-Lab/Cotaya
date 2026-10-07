// CT-12 Host 装配工厂：把 CT-01…07 的服务栈（repository/预算准入/继续确认/supervisor/
// recovery）与 CT-12 新增的 wire 执行端口、CLI→Host 请求处理、模板来源组装成一个可注册到
// `ServiceChannels.Continuous` 的 ContinuousCommandService + wake/退出处理面。
//
// 职责边界（ticket CT-12「构造 repository、supervisor、recovery、预算、继续确认与模板来源，
// 注册 ServiceChannels.Continuous 和 wake handler」）：
// - 本工厂只做构造与接线；业务判定全部在既有服务里（命令门面 CT-08 的委托纪律）。
// - 不保存业务队列/快照（Main/scheduler 也不）；长期事实唯一落 tasks-index。
// - 装配输入（transport/pricing/platformExecutionMode）由桌面装配层注入；缺价格快照时
//   supervisor 启动会被 wire 端口拒绝（§9 fail closed），读面不受影响。
// - 退出链：interruptForShutdown 先停新 wake（stopped 标志），再 interrupt 保存 interrupted；
//   已 suspended 的轮保留确认与暂停状态（supervisorControl.interruptCyclesForShutdown）。

import {
  assessContinuousPlatformExecution,
  type ContinuousPriceSnapshot,
  type ContinuousRequestCaps,
} from "@zcode/shared/continuous-protocol";
import {
  CONTINUOUS_TEMPLATES,
  resolveContinuousTemplate,
} from "@zcode/shared/continuous-templates";
import { SqliteContinuousRepository } from "./sqliteRepository.js";
import { createWorkspacePreparation } from "./workspacePreparation.js";
import { createWireContinuousExecutionPort } from "./wireExecutionPort.js";
import { ContinuousBudgetAdmission } from "../application/budgetAdmission.js";
import { ContinuousCommandService } from "../application/continuousCommandService.js";
import { ContinuousDecisionService } from "../application/decisionService.js";
import { interruptCyclesForShutdown } from "../application/supervisorControl.js";
import { ContinuousSupervisor, type ContinuousTemplateSource } from "../application/supervisor.js";
import { ContinuousRecoveryService, type RecoveryReport } from "../application/recovery.js";
import { handleContinuousAgentRequest } from "../application/agentRequests.js";
import type { ContinuousAgentTransport } from "../application/agentTransport.js";
import type { ContinuousClockPort, WorkspacePreparationPort } from "../application/ports.js";
import type { Cycle, Program } from "../domain/types.js";

/** shared 模板注册表 → supervisor 的 templateSource（hash 与 Program 授权绑定）。 */
const templateSource: ContinuousTemplateSource = {
  resolve: (ref) => {
    const template = resolveContinuousTemplate(ref);
    return template === null
      ? null
      : { scriptText: template.scriptText, scriptHash: template.scriptHash };
  },
  list: () =>
    CONTINUOUS_TEMPLATES.map((template) => ({
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      templateHash: template.scriptHash,
    })),
};

export interface AssembleContinuousHostDeps {
  /** tasks-index 数据库路径（与 TaskIndexRepo 同一文件；migration 由其初始化时应用）。 */
  databasePath: string;
  clock: ContinuousClockPort;
  /** Host→CLI 的 v4 命令传输面（桌面装配用 agent 服务实现；测试注入替身）。 */
  transport: ContinuousAgentTransport;
  /** 价格快照来源（装配层从 provider 配置解析；缺席则 managed run 拒绝自动执行）。 */
  pricing: () => ContinuousPriceSnapshot | undefined;
  /** 单请求输入/输出 token 上限（§9）。 */
  requestCaps: () => ContinuousRequestCaps | undefined;
  /** 平台执行评估入参；缺省用当前进程 platform/arch（shared 登记表 fail closed）。 */
  platform?: { platform: string; arch: string };
  /** workspace 准备端口；缺省用产品实现（受管 worktree）。测试注入替身。 */
  workspace?: WorkspacePreparationPort;
  /** 监督轮询间隔（缺省 500ms；测试调小让轮次快速进入终态后收尾）。 */
  pollIntervalMs?: number;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
}

export interface AssembledContinuousHost {
  commandService: ContinuousCommandService;
  supervisor: ContinuousSupervisor;
  recovery: ContinuousRecoveryService;
  repository: SqliteContinuousRepository;
  /** CLI→Host 请求处理（预算/结算/拒绝通知/决策）；桌面装配接进 agent client request 路径。 */
  handleAgentRequest: (
    method: string,
    params: unknown,
  ) => ReturnType<typeof handleContinuousAgentRequest>;
  /** wake 入口（Host 消息路由注册）：stopped 后如实回执失败，不派发。 */
  handleWake: (programId: string) => Promise<void>;
  /**
   * Host 启动核对（§10 恢复顺序第一步 / D2「重启先核对未结束轮」）：对全部 workspace
   * 先核对未结束 Cycle，再处理到期 Program。桌面 Host 在装配完成后调用一次（CT-16 修复：
   * 此前装配只有 wake/interrupt 入口，重启后 interrupted 轮要等下一次 cadence wake 才被
   * 核对，违反「重启先核对未结束轮，再调度未来轮」）。幂等：open cycle 核对与 trigger key
   * 唯一约束吸收重复调用；stopped 后与 handleWake 同语义拒绝。
   */
  recoverAllOnStartup: () => Promise<RecoveryReport[]>;
  /** 退出链：先停新 wake，再 interrupt 全部开放轮（保存 interrupted；suspended 保留确认）。 */
  interruptForShutdown: (workspaceKey: string) => Promise<string[]>;
  /** 回滚/停机：停止接受新 wake（在飞请求按既有链路收尾）。 */
  stop(): void;
  dispose(): void;
}

export async function assembleContinuousHost(
  deps: AssembleContinuousHostDeps,
): Promise<AssembledContinuousHost> {
  const repository = new SqliteContinuousRepository(deps.databasePath, 30_000);
  await repository.ensureReady();
  const platformExecution = assessContinuousPlatformExecution(
    deps.platform ?? { platform: process.platform, arch: process.arch },
  );
  const wireExecution = createWireContinuousExecutionPort({
    transport: deps.transport,
    repository,
    clock: deps.clock,
    pricing: deps.pricing,
    requestCaps: deps.requestCaps,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  const workspace =
    deps.workspace ?? createWorkspacePreparation({ clock: { now: () => deps.clock.now() } });
  const supervisor = new ContinuousSupervisor({
    repository,
    execution: wireExecution,
    workspace,
    clock: deps.clock,
    templateSource,
    platformExecutionMode: platformExecution.mode,
    ...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  const recovery = new ContinuousRecoveryService({
    repository,
    execution: wireExecution,
    supervisor,
    clock: deps.clock,
    workspace,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  const admission = new ContinuousBudgetAdmission({
    repository,
    clock: { now: () => deps.clock.now() },
  });
  const decisions = new ContinuousDecisionService({
    repository,
    clock: deps.clock,
  });
  const commandService = new ContinuousCommandService({
    repository,
    supervisor,
    templateSource,
    clock: deps.clock,
    platformExecution,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  let stopped = false;
  return {
    commandService,
    supervisor,
    recovery,
    repository,
    handleAgentRequest: (method, params) =>
      handleContinuousAgentRequest(
        {
          repository,
          clock: deps.clock,
          admission,
          decisions,
          execution: wireExecution,
          // 价格版本校验的事实源（CT-13：CLI 登记快照 ≠ 当前快照 → pricing_missing fail closed）。
          pricing: deps.pricing,
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        method,
        params,
      ),
    handleWake: async (programId) => {
      // stopped = 退出/回滚中：新 wake 不再派发（在飞轮由 interrupt 链收口）。
      if (stopped) throw new Error("continuous host assembly stopped (feature disabled)");
      await recovery.handleWake(programId);
    },
    recoverAllOnStartup: async () => {
      if (stopped) throw new Error("continuous host assembly stopped (feature disabled)");
      // §10 恢复顺序：先全部未结束 Cycle（reattach/resume/settle/suspended 保持），最后
      // 到期 Program。与 interruptForShutdown("*") 同一 listWorkspaceKeys 收口面。
      const reports: RecoveryReport[] = [];
      for (const key of await repository.listWorkspaceKeys()) {
        reports.push(await recovery.recoverWorkspace(key));
      }
      return reports;
    },
    interruptForShutdown: async (workspaceKey) => {
      stopped = true;
      const control = {
        repository,
        execution: wireExecution,
        clock: deps.clock,
        // attachSupervision 是 CycleControlDeps 的必填窄缝（继续路径用）；退出中断链
        // 不调用它——与 supervisor.stopCurrentCycle 的委托同一条纪律。
        attachSupervision: (cycle: Cycle, program: Program) =>
          supervisor.attachSupervision(cycle, program),
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      };
      if (workspaceKey !== "*") {
        return await interruptCyclesForShutdown(control, workspaceKey);
      }
      // Host 关闭：对全部未归档 Program 的 workspace 逐一收口（同 §10 顺序；单 workspace
      // 语义不变，只是循环外推）。
      const interrupted: string[] = [];
      for (const key of await repository.listWorkspaceKeys()) {
        interrupted.push(...(await interruptCyclesForShutdown(control, key)));
      }
      return interrupted;
    },
    stop: () => {
      stopped = true;
    },
    dispose: () => {
      stopped = true;
      repository.close();
    },
  };
}
