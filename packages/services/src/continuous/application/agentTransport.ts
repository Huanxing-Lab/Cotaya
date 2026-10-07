// Continuous agent 传输端口（CT-12）：Host 侧装配把 v4 命令发送到执行会话的传输面抽象成
// 一个注入端口——services/continuous 不 import zcode-agent 服务（分层边界：continuous
// 模块只依赖 shared + services 公开面），桌面装配层负责用 agent 服务的
// sendConversationCommandV4/createSession 实现它。
//
// 语义契约（实现方必须遵守，规格 §10/§11）：
// - ensureExecutionSession 幂等：同 executionSessionId 已存在则复用（resume），不存在才
//   创建；绝不为同一 Cycle 铸第二个 CLI 会话。
// - sendCommand 返回 ACK 的结构化投影：拒绝（fault code）原样上送 reasonCode，不吞成
//   通用异常；能力不支持（capabilityUnsupported）必须可判别——旧 CLI 据此不给自主实施。
// - 传输按 (sessionId) 定向：同一命令只发给执行会话所在的 CLI 进程。

/** v4 命令 ACK 的窄投影（status/reasonCode/message/result）。 */
export interface ContinuousAgentCommandAck {
  status: "accepted" | "rejected" | "stale" | "duplicate" | "noop" | "failed";
  reasonCode?: string;
  message?: string;
  result?: unknown;
}

/** Host→CLI 的传输端口（桌面装配实现；测试用进程内替身）。 */
export interface ContinuousAgentTransport {
  /** 确保执行会话存在并就绪（幂等；workspace 身份按 identity 规则原样传递）。 */
  ensureExecutionSession(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    executionSessionId: string;
    /** CLI 会话自身的 cwd（原始仓库；run 的 cwd 是 worktree，由 submitOnce 携带）。 */
    workingDirectory: string;
  }): Promise<void>;
  /** 向执行会话发送一条 v4 命令；sessionId 必须已就绪（ensureExecutionSession 之后）。 */
  sendCommand(input: {
    sessionId: string;
    type: string;
    payload: unknown;
    /** 会话归属 workspace（远程 identity 贯穿，防同路径串任务；本地可省）。 */
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ContinuousAgentCommandAck>;
}

/** 能力不支持的 fault code（v4 命令面 V4CapabilityUnsupportedError 的固定前缀）。 */
export const CONTINUOUS_AGENT_CAPABILITY_FAULT = "fault.command.capabilityUnsupported";
