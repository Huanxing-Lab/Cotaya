// CT-12 wire 执行端口：Host 侧的 ContinuousExecutionPort 实现——把十个执行操作经注入的
// ContinuousAgentTransport 发成 v4 `continuousManagedCycle` 命令，并在 submitOnce/resume/
// resumeSuspended/interrupt 之前先发专用登记命令（continuousRegisterManagedRun）重建该轮
// 的 CLI 侧登记（「恢复前从持久化快照重建全部登记」，ticket CT-12）。
//
// 为什么登记在端口内而不是 supervisor：登记是传输性质（wire 对端的状态），不是业务编排
// 步骤——supervisor 保持「业务顺序：保存执行身份 → 取得执行权 → submitOnce」，wire 端口
// 在 submitOnce 的传输前完成登记，业务层不需要第二条登记链。
//
// 能力协商：登记命令的结果回音 CLI 支持的操作词表；不完整（旧 CLI 缺 interrupt）即拒绝
// 提交（capability_missing），Host 不给自主实施 capability。capabilityUnsupported fault
// 同样映射 capability_missing——绝不退回普通 prompt 自主执行。
//
// 本文件在 adapters 层：知道 wire/ACK/fault 前缀（IO 边界），业务判定（预算/租约/状态机）
// 仍在 application 层服务里。

import {
  CONTINUOUS_REGISTER_MANAGED_RUN_REJECTED_FAULT_PREFIX,
  supportsContinuousCliManagedOperations,
  type ContinuousErrorCode,
  type ContinuousManagedCycleCommand,
  type ContinuousPriceSnapshot,
  type ContinuousRegisterManagedRunCommand,
  type ContinuousRegisterManagedRunResult,
  type ContinuousRequestCaps,
} from "@zcode/shared/continuous-protocol";
import { ContinuousSupervisorError } from "../application/supervisorLifecycle.js";
import type {
  ContinuousAgentTransport,
  ContinuousAgentCommandAck,
} from "../application/agentTransport.js";
import type { ContinuousRepositoryPort, ContinuousClockPort } from "../application/ports.js";
import type {
  ExecutionReference,
  ExecutionState,
  HealthSnapshot,
  ManagedCycleInput,
  ReportBatch,
} from "../application/ports.js";
import { buildManagedRunRegistration } from "../application/registrationPayload.js";

export interface WireExecutionPortDeps {
  transport: ContinuousAgentTransport;
  repository: ContinuousRepositoryPort;
  clock: ContinuousClockPort;
  /** 装配注入的价格快照（版本随 reservation 落库；缺失条目在 CLI 侧 pricing_missing 拒绝）。 */
  pricing: () => ContinuousPriceSnapshot | undefined;
  /** 装配注入的单请求输入/输出上限（§9「每个请求必须有输入上限和输出上限」）。 */
  requestCaps: () => ContinuousRequestCaps | undefined;
  logger?: { warn?: (message: string, meta?: unknown) => void };
  /** 登记前确保执行会话存在（缺省每次登记前调用 transport.ensureExecutionSession）。 */
  ensureSession?: boolean;
}

/** ACK 拒绝 reason → supervisor 结构化错误码（词表见 shared continuousExecutionRejectionReason）。 */
function rejectionCodeOf(reasonCode: string | undefined): string {
  if (reasonCode === undefined) return "execution_not_quiescent";
  if (reasonCode.startsWith(CONTINUOUS_REGISTER_MANAGED_RUN_REJECTED_FAULT_PREFIX)) {
    return reasonCode.slice(CONTINUOUS_REGISTER_MANAGED_RUN_REJECTED_FAULT_PREFIX.length);
  }
  // v4 fault.command.continuousManagedCycleRejected.<reason>
  const managedPrefix = "fault.command.continuousManagedCycleRejected.";
  if (reasonCode.startsWith(managedPrefix)) return reasonCode.slice(managedPrefix.length);
  return reasonCode;
}

export function createWireContinuousExecutionPort(deps: WireExecutionPortDeps) {
  /** 登记时记住的会话 workspace（后续命令定向用；workspace 身份防同路径串任务）。 */
  const sessionWorkspaces = new Map<
    string,
    { workspacePath: string; workspaceIdentity?: string }
  >();
  const commandOf = (
    op: ContinuousManagedCycleCommand["op"],
    ref: ExecutionReference,
    extra: Partial<ContinuousManagedCycleCommand> = {},
  ): ContinuousManagedCycleCommand => ({
    op,
    cycleId: ref.cycleId,
    executionSessionId: ref.executionSessionId,
    workflowRunId: ref.workflowRunId,
    traceId: ref.traceId,
    ...extra,
  });

  const send = async (
    sessionId: string,
    type: string,
    payload: unknown,
    context: string,
  ): Promise<ContinuousAgentCommandAck> => {
    try {
      const workspace = sessionWorkspaces.get(sessionId);
      return await deps.transport.sendCommand({
        sessionId,
        type,
        payload,
        ...(workspace === undefined ? {} : workspace),
      });
    } catch (error) {
      // 传输故障 = 执行面不可达（§10 恢复流程按 unreachable 处理，不静默重试）。
      throw new ContinuousSupervisorError(
        "execution_not_quiescent",
        `continuous wire ${context} 传输失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const requireAccepted = (ack: ContinuousAgentCommandAck, context: string): unknown => {
    if (ack.status === "accepted" || ack.status === "duplicate") return ack.result;
    const code = rejectionCodeOf(ack.reasonCode);
    // 旧 CLI/未装配：能力不支持 → capability_missing（不给自主实施，ticket CT-12）。
    // 其余 fault 后缀沿用 wire 词表（continuousManagedCycleRejected.<reason> 与登记拒绝
    // 词表都落在 ContinuousErrorCode 词表内；未知 fault 原样上送供诊断）。
    const mapped = (
      ack.reasonCode === "fault.command.capabilityUnsupported" ? "capability_missing" : code
    ) as ContinuousErrorCode;
    throw new ContinuousSupervisorError(
      mapped,
      `continuous wire ${context} 拒绝: ${ack.reasonCode ?? ack.status}${ack.message ? ` (${ack.message})` : ""}`,
    );
  };

  /** 从持久化快照重建登记（提交/恢复/继续/退出中断前调用；幂等重发安全）。 */
  const registerRun = async (ref: ExecutionReference, executionPath: string): Promise<void> => {
    const cycle = await deps.repository.getCycle(ref.cycleId);
    if (!cycle) {
      throw new ContinuousSupervisorError("capability_missing", `cycle 不存在: ${ref.cycleId}`);
    }
    const program = await deps.repository.getProgram(cycle.programId);
    if (!program) {
      throw new ContinuousSupervisorError(
        "capability_missing",
        `program 不存在: ${cycle.programId}`,
      );
    }
    const pricing = deps.pricing();
    const requestCaps = deps.requestCaps();
    if (pricing === undefined || requestCaps === undefined) {
      // 价格/上限缺失：费用限额下的自动执行必须拒绝并显示原因（§9），fail closed。
      throw new ContinuousSupervisorError(
        "budget_denied",
        "Continuous 装配缺少价格快照或请求上限，managed run 不能自动执行（§9）",
      );
    }
    const registration: ContinuousRegisterManagedRunCommand = buildManagedRunRegistration({
      program,
      cycle,
      executionPath,
      leaseEpoch: Math.max(cycle.leaseEpoch, 0),
      pricing,
      requestCaps,
    });
    if (deps.ensureSession !== false) {
      await deps.transport.ensureExecutionSession({
        workspacePath: program.workspacePath,
        ...(program.workspaceIdentity === undefined
          ? {}
          : { workspaceIdentity: program.workspaceIdentity }),
        executionSessionId: ref.executionSessionId,
        workingDirectory: program.workspacePath,
      });
    }
    sessionWorkspaces.set(ref.executionSessionId, {
      workspacePath: program.workspacePath,
      ...(program.workspaceIdentity === undefined
        ? {}
        : { workspaceIdentity: program.workspaceIdentity }),
    });
    const ack = await send(
      ref.executionSessionId,
      "continuousRegisterManagedRun",
      registration,
      "register",
    );
    const result = requireAccepted(ack, "register") as
      | ContinuousRegisterManagedRunResult
      | undefined;
    if (!result) return;
    // 能力协商核对：CLI 回音必须覆盖全部必需操作（含 interrupt）——不完整即 CLI 太旧。
    if (!supportsContinuousCliManagedOperations(result.operations)) {
      const missing = ["interrupt", "register", "submitOnce"].filter(
        (operation) => !result.operations.includes(operation),
      );
      throw new ContinuousSupervisorError(
        "capability_missing",
        `CLI 能力协商不完整（缺 ${missing.join("/")}），不给自主实施 capability`,
      );
    }
    if (result.workflowRunId !== ref.workflowRunId) {
      throw new ContinuousSupervisorError(
        "execution_identity_mismatch",
        `登记回音 runId 不符: ${result.workflowRunId} != ${ref.workflowRunId}`,
      );
    }
  };

  /** 恢复类操作前重建登记（resume/resumeSuspended/interrupt 的公共前缀）。 */
  const reRegisterFromJournalCwd = async (ref: ExecutionReference): Promise<void> => {
    // 真实工作目录从 Program 的 executionPath（受管 worktree）取，不信任 journal cwd。
    const cycle = await deps.repository.getCycle(ref.cycleId);
    const program = cycle ? await deps.repository.getProgram(cycle.programId) : undefined;
    const executionPath = program?.executionPath;
    if (!cycle || !program || executionPath === undefined) {
      throw new ContinuousSupervisorError(
        "execution_identity_mismatch",
        `恢复登记缺少持久化快照（cycle/program/executionPath）: ${ref.cycleId}`,
      );
    }
    await registerRun(ref, executionPath);
  };

  return {
    async submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
      const ref: ExecutionReference = {
        cycleId: input.cycleId,
        executionSessionId: input.executionSessionId,
        workflowRunId: input.workflowRunId,
        traceId: input.traceId,
      };
      // 启动顺序（ticket CT-12）：保存执行身份 → 取得执行权（supervisor 已完成）→
      // 按 Run ID 登记 → submitOnce。重发同触发键由 supervisor 幂等复用，登记重发安全。
      await registerRun(ref, input.executionPath);
      const ack = await send(
        input.executionSessionId,
        "continuousManagedCycle",
        commandOf("submitOnce", ref, {
          input: {
            programId: input.programId,
            cycleId: input.cycleId,
            executionSessionId: input.executionSessionId,
            workflowRunId: input.workflowRunId,
            traceId: input.traceId,
            executionPath: input.executionPath,
            scriptText: input.scriptText,
            scriptHash: input.scriptHash,
            configurationSnapshot: input.configurationSnapshot,
            ...(input.args === undefined ? {} : { args: input.args }),
          },
        }),
        "submitOnce",
      );
      requireAccepted(ack, "submitOnce");
      return ref;
    },

    async inspect(ref: ExecutionReference): Promise<ExecutionState> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("inspect", ref),
        "inspect",
      );
      const result = requireAccepted(ack, "inspect") as
        | { op: "inspect"; state: ExecutionState }
        | undefined;
      if (!result) {
        return { runId: ref.workflowRunId, status: "pending", resumable: false };
      }
      return result.state;
    },

    async resume(ref: ExecutionReference, epoch: number): Promise<void> {
      await reRegisterFromJournalCwd(ref);
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("resume", ref, { epoch }),
        "resume",
      );
      requireAccepted(ack, "resume");
    },

    async stop(ref: ExecutionReference, reason: string): Promise<void> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("stop", ref, { reason }),
        "stop",
      );
      requireAccepted(ack, "stop");
    },

    async interrupt(ref: ExecutionReference, epoch: number): Promise<void> {
      // 退出中断同样先重建登记（进程重启后 CLI 侧登记为空；epoch 交给适配器高水位校验）。
      await reRegisterFromJournalCwd(ref);
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("interrupt", ref, { epoch }),
        "interrupt",
      );
      requireAccepted(ack, "interrupt");
    },

    async waitForQuiescence(ref: ExecutionReference): Promise<void> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("waitForQuiescence", ref),
        "waitForQuiescence",
      );
      requireAccepted(ack, "waitForQuiescence");
    },

    async readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("readReports", ref, { afterSequence }),
        "readReports",
      );
      const result = requireAccepted(ack, "readReports") as
        | { op: "readReports"; batch: ReportBatch }
        | undefined;
      return result?.batch ?? { items: [], nextCursor: afterSequence };
    },

    async suspendAtSafeBoundary(ref: ExecutionReference, reason: string): Promise<void> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("suspendAtSafeBoundary", ref, { reason }),
        "suspendAtSafeBoundary",
      );
      requireAccepted(ack, "suspendAtSafeBoundary");
    },

    async resumeSuspended(ref: ExecutionReference, epoch: number): Promise<void> {
      // 继续授权后的解冻：先按新快照重建登记（继续 grant 增量在 Program/账本侧），再解冻。
      await reRegisterFromJournalCwd(ref);
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("resumeSuspended", ref, { epoch }),
        "resumeSuspended",
      );
      requireAccepted(ack, "resumeSuspended");
    },

    async inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot> {
      const ack = await send(
        ref.executionSessionId,
        "continuousManagedCycle",
        commandOf("inspectHealth", ref),
        "inspectHealth",
      );
      const result = requireAccepted(ack, "inspectHealth") as
        | { op: "inspectHealth"; health?: HealthSnapshot }
        | undefined;
      if (!result?.health) {
        // 对端没回健康快照（旧 CLI/异常载荷）：不可达 + 空证据——探活分类按 unreachable
        // 处理（恢复规则核对），不把缺数据当健康。
        return {
          runId: ref.workflowRunId,
          actorIds: [],
          ownerEpoch: 0,
          reachable: false,
        };
      }
      return result.health;
    },
  };
}

export type WireContinuousExecutionPort = ReturnType<typeof createWireContinuousExecutionPort>;
