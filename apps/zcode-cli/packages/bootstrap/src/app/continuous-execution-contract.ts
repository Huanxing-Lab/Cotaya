// Continuous 执行端口的结构镜像，服务端实现类型由 Host 的 wire 边界对齐。

/** 提交前持久化的执行身份（规格 §10）；与 services 端口 ManagedCycleInput 对齐。 */
export interface ManagedCycleInput {
  programId: string;
  cycleId: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
  /** Program worktree：actor 实际工作目录（规格 §11「实际 actor 工作目录必须是 executionPath」）。 */
  executionPath: string;
  scriptText: string;
  scriptHash: string;
  configurationSnapshot: unknown;
  /**
   * 模板实参。CT-00 端口没有这个字段（v1 模板无用户实参）；本地镜像带上它是为了让
   * 「不同 args 拒绝」（规格 §10）在 run service 的身份核对里有一条真实的输入路径。
   * 缺席 = 无实参 run；Host 侧端口补字段属 CT-05 装配。
   */
  args?: Record<string, unknown>;
}

export interface ExecutionReference {
  cycleId: string;
  executionSessionId: string;
  workflowRunId: string;
  traceId: string;
}

export interface ExecutionState {
  runId: string;
  status: "pending" | "running" | "completed" | "errored" | "stopped";
  stopReason?: string;
  failureCode?: string;
  resumable: boolean;
}

/** 版本化报告条目（ContinuousReportV1 的 item 种类，规格 §11）。 */
export interface ContinuousReportItem {
  kind:
    | "candidate"
    | "decision"
    | "validation"
    | "candidate_result"
    | "cycle_result"
    /**
     * 载荷不符合 ContinuousReportV1 的最小形状（缺 kind/itemKey 或类别不在词表内）。
     * 读侧不丢行、不编造类别：条目原样上送，schema 校验与拒绝事件归 CT-05 的 reportIngestion
     * （规格 §11「malformed report 记录拒绝事件」）。services 端口没有这个值——这是读侧的
     * 诚实扩展，Host 装配时在导入层消化。
     */
    | "unknown";
  itemKey: string;
  journalSequence: number;
  payload: unknown;
}

export interface ReportBatch {
  items: ContinuousReportItem[];
  nextCursor: number;
}

/** 主动探活健康快照（§10.1 骨架；进展分类与 normal_wait 证据归 CT-04 healthMonitor）。 */
export interface HealthSnapshot {
  runId: string;
  actorIds: string[];
  lastProgressAt?: number;
  waitingFor?: { ownerId: string; reason: string; deadlineAt: number };
  ownerEpoch: number;
  reachable: boolean;
  /** 本适配器的准许状态：open / suspended（资源挂起）/ revoked（用户停止后）。 */
  admissionState: "open" | "suspended" | "revoked";
}

export interface ContinuousExecutionPort {
  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference>;
  inspect(ref: ExecutionReference): Promise<ExecutionState>;
  resume(ref: ExecutionReference, epoch: number): Promise<void>;
  stop(ref: ExecutionReference, reason: string): Promise<void>;
  /** 退出中断：冻结后取消执行，保持同 Run 可恢复。 */
  interrupt(ref: ExecutionReference, epoch: number): Promise<void>;
  waitForQuiescence(ref: ExecutionReference): Promise<void>;
  readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch>;
  /** 资源上限挂起（§6.1/§11）：不等同 stop；不能借 stop 把整轮永久 cancelled。 */
  suspendAtSafeBoundary(ref: ExecutionReference, reason: string): Promise<void>;
  resumeSuspended(ref: ExecutionReference, epoch: number): Promise<void>;
  inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot>;
}
