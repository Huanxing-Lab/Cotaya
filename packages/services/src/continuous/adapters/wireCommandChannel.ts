// CT-14 自 wireExecutionPort 拆出的 wire 命令发送层（架构 max-file-lines 400 上限的拆分，
// 不是边界变化）：ACK 投影（requireAccepted）、传输故障映射与读操作通信期限（sendRead）。
// 语义契约不变，见 wireExecutionPort.ts 文件头；本文件只承载「一条命令怎么发、怎么判回执」。

import {
  CONTINUOUS_REGISTER_MANAGED_RUN_REJECTED_FAULT_PREFIX,
  type ContinuousErrorCode,
} from "@zcode/shared/continuous-protocol";
import { ContinuousSupervisorError } from "../application/supervisorLifecycle.js";
import type {
  ContinuousAgentTransport,
  ContinuousAgentCommandAck,
} from "../application/agentTransport.js";

/** CT-14：读取执行快照/报告的默认通信期限（§10.1 探活节拍 15s 的两倍，远小于 180s 阈值）。 */
export const CONTINUOUS_WIRE_READ_DEADLINE_MS = 30_000;

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

export interface WireCommandChannelDeps {
  transport: ContinuousAgentTransport;
  /** 登记时记住的会话 workspace（远程 identity 贯穿，防同路径串任务）。 */
  workspaceOf: (
    sessionId: string,
  ) => { workspacePath: string; workspaceIdentity?: string } | undefined;
  /** CT-14 读操作通信期限（缺省 30 秒）。 */
  readDeadlineMs?: number;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

export interface WireCommandChannel {
  send(
    sessionId: string,
    type: string,
    payload: unknown,
    context: string,
  ): Promise<ContinuousAgentCommandAck>;
  /**
   * CT-14 读操作（inspect/inspectHealth/readReports）的通信期限：传输卡死或失败都在期限
   * 内折算成结构化 execution_unreachable（消息带期限与上下文，可诊断）——监督循环不能
   * 永远卡在一次 RPC 上；期限须小于 180 秒 hang 阈值，失联按 unreachable 交恢复核对。
   */
  sendRead(
    sessionId: string,
    type: string,
    payload: unknown,
    context: string,
  ): Promise<ContinuousAgentCommandAck>;
  /** ACK 投影：accepted/duplicate 返回 result；拒绝按 fault 词表映射结构化错误。 */
  requireAccepted(ack: ContinuousAgentCommandAck, context: string): unknown;
}

export function createWireCommandChannel(deps: WireCommandChannelDeps): WireCommandChannel {
  const send = async (
    sessionId: string,
    type: string,
    payload: unknown,
    context: string,
  ): Promise<ContinuousAgentCommandAck> => {
    try {
      const workspace = deps.workspaceOf(sessionId);
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

  const sendRead: WireCommandChannel["sendRead"] = async (sessionId, type, payload, context) => {
    const deadlineMs = deps.readDeadlineMs ?? CONTINUOUS_WIRE_READ_DEADLINE_MS;
    try {
      return await Promise.race([
        send(sessionId, type, payload, context).catch((error: unknown) => {
          // 读操作的传输失败与超时同义：通信不可达（不是笼统的执行未静止）。
          throw new ContinuousSupervisorError(
            "execution_unreachable",
            `continuous wire ${context} 传输失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              new ContinuousSupervisorError(
                "execution_unreachable",
                `continuous wire ${context} 通信超时（${deadlineMs}ms 期限，CT-14 §10.1）`,
              ),
            );
          }, deadlineMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof ContinuousSupervisorError && error.code === "execution_unreachable") {
        deps.logger?.warn?.("Continuous wire read deadline exceeded", {
          event: "continuous.wire.read_deadline",
          module: "services.continuous",
          context,
          deadlineMs,
        });
      }
      throw error;
    }
  };

  return { send, sendRead, requireAccepted };
}
