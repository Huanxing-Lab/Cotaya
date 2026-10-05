// CT-12：桌面 window-scoped Local Host 的 Continuous 装配。功能默认关闭——
// `ZCODE_CONTINUOUS_HOST_ENABLED=1` 时才构造（规格 §13「功能默认关闭」；未装配 =
// ServiceChannels.Continuous 未注册 → renderer capability 探测挂起 → tab 隐藏，
// E-24/E-27 的真实产品形态）。
//
// 职责（ticket CT-12）：复用窗口现有 Local Host（services 注入与 channel 注册），不用 Main
// 保存业务状态。本文件把 services 的 assembleContinuousHost 接到桌面事实源上：
//   - tasks-index 路径/迁移：与 TaskIndexRepo 同一数据库（先 ensureReady 应用幂等迁移；
//     0004_continuous_long_term_state 是 additive 的，旧库既有表不受影响）；
//   - 执行会话与 v4 命令：zcodeAgentService 的 createSession/resumeSession +
//     sendConversationCommandV4（late-bound：装配先于 agent service 存在）；
//   - 价格快照：产品数据目录的 continuous/pricing-snapshot.json（schema 校验；文件缺席
//     → managed run 结构化拒绝自动执行，§9 fail closed——不静默零价）。
//
// 退出链（interruptForShutdown）由 host 的 shutdown 阶段调用：先停新 wake、保存
// interrupted、保留 suspended 确认，interrupt 并等待工具收尾（§10）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  continuousPriceSnapshotSchema,
  type ContinuousPriceSnapshot,
  type ContinuousRequestCaps,
} from "@zcode/shared/continuous-protocol";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "@zcode/services";
import {
  assembleContinuousHost,
  type AssembledContinuousHost,
  type ContinuousAgentCommandAck,
  type ContinuousAgentTransport,
} from "@zcode/services/continuous";
import {
  createHostCommandEnvelope,
  createServiceLogger,
  getAppConfigDir,
  getTasksIndexDatabasePath,
  TaskIndexRepo,
} from "@zcode/services/node";

const logger = createServiceLogger("continuousHost");

/** 装配开关（默认关闭；生产/E2E 显式开启）。 */
export function isContinuousHostEnabled(): boolean {
  return process.env.ZCODE_CONTINUOUS_HOST_ENABLED?.trim() === "1";
}

/**
 * 价格快照文件（产品数据目录；CT-12 的装配输入面）。文件缺席/非法 → undefined：
 * wire 执行端口据此拒绝 managed run 自动执行并显示原因（§9「价格缺失时拒绝」，
 * 不伪造零价）。快照由后续真实 provider 定价装配写入（CT-13/16）。
 */
async function readContinuousPricingSnapshot(): Promise<ContinuousPriceSnapshot | undefined> {
  try {
    const raw = await readFile(
      join(getAppConfigDir(), "continuous", "pricing-snapshot.json"),
      "utf8",
    );
    const parsed = continuousPriceSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn("continuous pricing snapshot 文件非法，managed run 拒绝自动执行");
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** 单请求输入/输出 token 上限（§9 保守预留基数；第一版固定产品常量）。 */
const REQUEST_CAPS: ContinuousRequestCaps = {
  inputTokenCap: 2_000_000,
  outputTokenCap: 128_000,
};

/** late-bound agent service：装配发生在 services 初始化完成之前。 */
interface AgentServiceRef {
  get(): IZCodeAgentService | undefined;
}

function createAgentTransport(agentRef: AgentServiceRef): ContinuousAgentTransport {
  return {
    ensureExecutionSession: async (input) => {
      const agent = agentRef.get();
      if (!agent) throw new Error("zcodeAgentService 尚未初始化（continuous transport）");
      const target = {
        workspacePath: input.workingDirectory,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      };
      // 幂等：执行会话已存在则 resume（冷恢复），不存在才创建。绝不为同一 Cycle 铸
      // 第二个 CLI 会话（§10「一个执行者」）；创建参数最小化——parent 从不开 turn。
      const existing = await agent.listSessions({
        ...target,
        sessionIds: [input.executionSessionId],
      });
      if (existing.some((session) => session.sessionId === input.executionSessionId)) {
        await agent.resumeSession({
          ...target,
          sessionId: input.executionSessionId,
        });
        return;
      }
      await agent.createSession({
        ...target,
        sessionId: input.executionSessionId,
        persistence: "immediate",
        titleGenerationEnabled: false,
      });
    },
    sendCommand: async (input) => {
      const agent = agentRef.get();
      if (!agent) throw new Error("zcodeAgentService 尚未初始化（continuous transport）");
      const ack: CommandAck = await agent.sendConversationCommandV4({
        workspacePath: input.workspacePath ?? "",
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        envelope: createHostCommandEnvelope({
          type: input.type as never,
          payload: input.payload as never,
          sessionId: input.sessionId,
        }),
      });
      const projected: ContinuousAgentCommandAck = {
        status: ack.status,
        ...(ack.reasonCode === undefined ? {} : { reasonCode: ack.reasonCode }),
        ...(ack.message === undefined ? {} : { message: ack.message }),
        ...(ack.result === undefined ? {} : { result: ack.result }),
      };
      return projected;
    },
  };
}

export interface ContinuousHostRuntime {
  assembled: AssembledContinuousHost;
  /** CLI→Host 请求拦截（接进 agent 服务的 client request 路径）。 */
  handleAgentClientRequest(
    method: string,
    params: unknown,
  ): Promise<{ handled: boolean; result?: unknown; error?: { code: number; message: string } }>;
}

export async function createContinuousHostRuntime(
  agentRef: AgentServiceRef,
): Promise<ContinuousHostRuntime> {
  // tasks-index 迁移先于 continuous 表访问（TaskIndexRepo 的迁移幂等 additive；
  // 旧库既有表不受影响）。数据库路径与 Host 其它 Repo 同源。
  const databasePath = getTasksIndexDatabasePath();
  const migrationRepo = new TaskIndexRepo(databasePath);
  await migrationRepo.ensureReady();
  const pricing = await readContinuousPricingSnapshot();
  const assembled = await assembleContinuousHost({
    databasePath,
    clock: {
      now: () => Date.now(),
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    transport: createAgentTransport(agentRef),
    pricing: () => pricing,
    requestCaps: () => REQUEST_CAPS,
    logger: {
      warn: (message, meta) => logger.warn(message, meta),
      info: (message, meta) => logger.info(message, meta),
    },
  });
  return {
    assembled,
    handleAgentClientRequest: async (method, params) => {
      const outcome = await assembled.handleAgentRequest(method, params);
      if (!outcome.handled) return { handled: false };
      if ("error" in outcome && outcome.error) return { handled: true, error: outcome.error };
      return { handled: true, result: "result" in outcome ? outcome.result : undefined };
    },
  };
}
