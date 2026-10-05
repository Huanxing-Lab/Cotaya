// ============================================================
// ContinuousExecutionPort 的 CLI bootstrap 适配器（CT-03）
// ============================================================
// 规格来源：docs/specs/continuous.md §11（Integration 接口与报告）与 §6.1/§10（停止顺序、
// 专用挂起、恢复身份）。本文件把 services 侧端口（packages/services/src/continuous/
// application/ports.ts 的 ContinuousExecutionPort）落到现有 Dynamic Workflow run service 与
// dwf journal 上——**services 不引用 AgentRuntime 实现**的边界因此成立：services 只见端口，
// 本适配器在 CLI 进程内持有 Run service 与 journal。
//
// 与 services 端口类型的关系：**结构等价的本地镜像**而非 import（bootstrap 不依赖
// @zcode/services，业务状态与 Host 装配都在那一侧）。字段逐一对齐；两处刻意差异都有注释：
//   1. ContinuousReportItem.kind 多一个 "unknown"（读侧诚实：不丢行、不编造类别）；
//   2. HealthSnapshot 多一个可选 admissionState（挂起/撤销是本适配器的自有状态）。
// Host 装配（CT-05+）经 wire schema（@zcode/shared continuous-protocol）消费，不 import 本文件。
//
// 停止语义（规格 §6「立即停止本轮」）：先撤销新操作（admission 置 revoked，此后本适配器拒绝
// 该 Cycle 的一切恢复/再挂起操作），再 abort（run service cancel，引擎经 stop(user) 结算成可
// resume 的 stopped——但本适配器的 revoked 守卫保证「用户取消的 Run 不自动 resume」），最后
// **等待 Agent/工具停止而不只等 run-settled**（waitForQuiescence = 结算 + 被中止 turn 的收尾）。
//
// 挂起语义（规格 §6.1/§11）：suspendAtSafeBoundary **不等同 stop**——绝不调用 cancel，绝不把
// Run 结算成 stopped/cancelled；它冻结本适配器对该 Cycle 的操作准许（新请求/新写入的准入
// 执行点在 CT-04 的模型准入接缝接线）。DWF 现无原生 pause 状态，本接口不伪装引擎已暂停：
// 挂起后引擎照常收尾在途工作，恢复走 resumeSuspended（同 Run、同 Cycle），不铸新执行。

import { createHash } from "node:crypto";
import type {
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunResumeResult,
  Logger,
  TraceId,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { DwfSequencedReportQueries } from "@zcode/adapters/storage";
import type { ContinuousExecutionRejectionReason } from "@zcode/shared/continuous-protocol";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import type {
  ManagedRunSubmitRejection,
  ManagedRunSubmitRequest,
  ManagedRunSubmitResult,
} from "./dynamic-workflow-run-managed-submit.js";

// ── services 端口的结构镜像（见文件头）────────────────────────

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
  waitForQuiescence(ref: ExecutionReference): Promise<void>;
  readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch>;
  /** 资源上限挂起（§6.1/§11）：不等同 stop；不能借 stop 把整轮永久 cancelled。 */
  suspendAtSafeBoundary(ref: ExecutionReference, reason: string): Promise<void>;
  resumeSuspended(ref: ExecutionReference, epoch: number): Promise<void>;
  inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot>;
}

// ── 结构化拒绝 ────────────────────────────────────────────────

/**
 * 受控执行的结构化拒绝（调用方按 reason 分流，不读错误文本做流程判断）。
 * reason 的词表唯一来源是 @zcode/shared continuous-protocol 的
 * continuousExecutionRejectionReasonSchema：前七个与 run service resume 门同名同义（一处
 * 词汇表，不做第二套翻译），后四个是适配器守卫（身份、租约、挂起状态、用户停止后的封锁）；
 * wire 侧（fault.command.continuousManagedCycleRejected.<reason>）用同一份枚举。
 */
export class ContinuousExecutionError extends Error {
  readonly reason: ContinuousExecutionRejectionReason;
  /** 幂等重试是否安全（同身份重发安全：identity/lease 类；其余否）。 */
  readonly retryable: boolean;

  constructor(
    reason: ContinuousExecutionRejectionReason,
    message: string,
    options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = "ContinuousExecutionError";
    this.reason = reason;
    this.retryable = options?.retryable ?? false;
  }
}

// ── 适配器依赖 ────────────────────────────────────────────────

/** 适配器需要的 run service 窄视图（生产 = DynamicWorkflowRunService；测试可注入替身）。 */
export interface ContinuousRunServiceView {
  submitOnce(request: ManagedRunSubmitRequest): Promise<ManagedRunSubmitResult>;
  /**
   * 恢复既有 run。类型上可选是因为 `DynamicWorkflowRunPort.resume` 本身是可选成员（stub
   * 端口不陪跑）；生产实现恒在场，缺席到达适配器即接线故障，resumeRun 大声失败。
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** 结算 + 被中止 turn 收尾（I-06：不只等 run-settled）。 */
  waitForQuiescence(runId: string): Promise<void>;
  /** 注册表活条目探测（inspectHealth.reachable 的唯一真相：journal 的 running 行不含可达性）。 */
  isLiveRun(runId: string): boolean;
}

export interface ContinuousExecutionAdapterDeps {
  runService: ContinuousRunServiceView;
  /** run 行与 actor 读面（身份核对之外的观察：状态、actor 会话）。 */
  journal: JournalStorePort;
  /** 按序报告读面（adapters 的 SQLite journal 携带；能力探测见 supportsSequencedReportReads）。 */
  reportReader: DwfSequencedReportQueries;
  logger?: Logger;
  /** 报告单页上限（缺省 256；有界取数，不整条 journal 读进内存）。 */
  reportPageSize?: number;
}

/** 单 Cycle 的适配器自有状态：epoch 高水位 + 准许状态。 */
interface CycleAdmissionState {
  epoch: number;
  admission: "open" | "suspended" | "revoked";
  /** 最近一次 stop/suspend 的原因（审计与日志）。 */
  lastReason?: string;
}

const DEFAULT_REPORT_PAGE_SIZE = 256;

/**
 * 造 ContinuousExecutionPort 适配器。状态只有两张小表（cycleId → 准许状态 / epoch 高水位），
 * 都是对 Host 持久事实的**守卫副本**，不是第二份业务状态：真正的执行状态在 dwf journal 与
 * run service 注册表，Program/Cycle/队列在 Host 的 tasks-index（CT-01）。
 */
export function createContinuousExecutionAdapter(
  deps: ContinuousExecutionAdapterDeps,
): ContinuousExecutionPort {
  const admissions = new Map<string, CycleAdmissionState>();
  const pageSize = () => deps.reportPageSize ?? DEFAULT_REPORT_PAGE_SIZE;

  const admissionOf = (cycleId: string): CycleAdmissionState => {
    let state = admissions.get(cycleId);
    if (state === undefined) {
      state = { epoch: 0, admission: "open" };
      admissions.set(cycleId, state);
    }
    return state;
  };

  /** epoch 高水位守卫：回退的 epoch 一律 lease_lost（规格 §10「旧 epoch 不可写」）。 */
  const requireEpoch = (cycleId: string, epoch: number): CycleAdmissionState => {
    const state = admissionOf(cycleId);
    if (epoch < state.epoch) {
      throw new ContinuousExecutionError(
        "lease_lost",
        `continuous cycle ${cycleId} presented stale epoch ${epoch} (high-water ${state.epoch})`,
        { retryable: false },
      );
    }
    state.epoch = epoch;
    return state;
  };

  /** 用户停止后的封锁：规格 §6「不能自动 resume 用户取消的 Run」。 */
  const requireNotRevoked = (cycleId: string): void => {
    const state = admissions.get(cycleId);
    if (state?.admission === "revoked") {
      throw new ContinuousExecutionError(
        "stopped",
        `continuous cycle ${cycleId} was stopped by the user; the cancelled run must not be auto-resumed`,
      );
    }
  };

  const referenceOf = (input: ManagedCycleInput): ExecutionReference => ({
    cycleId: input.cycleId,
    executionSessionId: input.executionSessionId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
  });

  return {
    async submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
      // 绑定自洽先于提交：Host 持久化的 scriptHash 必须就是 scriptText 的 sha256
      // （compileOnce 用同一算法落 journal）。对不上说明绑定记录被改写或上游构造被绕过——
      // 按不同内容同 ID 拒绝（规格 §10），绝不带病启动。
      const computedHash = createHash("sha256").update(input.scriptText, "utf8").digest("hex");
      if (computedHash !== input.scriptHash) {
        throw new ContinuousExecutionError(
          "execution_identity_mismatch",
          `continuous cycle ${input.cycleId} binding hash mismatch: expected ${input.scriptHash}, computed ${computedHash}`,
          { retryable: false },
        );
      }
      const result = await deps.runService.submitOnce({
        runId: input.workflowRunId,
        scriptText: input.scriptText,
        cwd: input.executionPath,
        parentSessionId: input.executionSessionId,
        ...(input.args === undefined ? {} : { args: input.args }),
        name: `continuous-${input.programId}`,
        // traceId 的品牌转换沿用仓库惯例（server-operations 等 wire 边界同款）：
        // 字符串形状已在 wire schema（continuous-protocol 的 nonEmptyString）校验。
        trace: {
          traceId: input.traceId as TraceId,
          attributes: { continuousCycleId: input.cycleId, continuousProgramId: input.programId },
        },
      });
      if (!result.ok) {
        throw new ContinuousExecutionError(
          submitRejectionOf(result.reason),
          `continuous cycle ${input.cycleId} submit refused: ${result.reason}`,
          // 同身份重发安全：被拒的那次没有产生新执行；调用方修正输入后重试同一 ID 即可。
          { retryable: true },
        );
      }
      if (!result.reused) {
        deps.logger?.info?.("Continuous managed cycle run submitted", {
          event: "continuous.execution.submitted",
          module: "bootstrap.app",
          cycleId: input.cycleId,
          runId: input.workflowRunId,
          traceId: input.traceId as TraceId,
        });
      }
      return referenceOf(input);
    },

    async inspect(ref: ExecutionReference): Promise<ExecutionState> {
      const record = deps.journal.getRun(ref.workflowRunId);
      // 行不存在有两种：从未提交（R-01：身份已绑定、执行尚未被接受 → pending，恢复路径据此
      // 按原身份重新 submitOnce），或 submit → createRun 的微任务间隙（本进程活条目 → running，
      // 与 synthesizeRunStatus 对注册表条目的优先级同一条纪律）。
      if (record === undefined) {
        return {
          runId: ref.workflowRunId,
          status: deps.runService.isLiveRun(ref.workflowRunId) ? "running" : "pending",
          resumable: false,
        };
      }
      return {
        runId: ref.workflowRunId,
        status: executionStatusOf(deps.runService.isLiveRun(ref.workflowRunId), record.status),
        ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
        ...(record.failure?.code === undefined ? {} : { failureCode: record.failure.code }),
        resumable: isResumableSettlement(record.status, record.stopReason),
      };
    },

    async resume(ref: ExecutionReference, epoch: number): Promise<void> {
      requireNotRevoked(ref.cycleId);
      requireEpoch(ref.cycleId, epoch);
      await resumeRun(deps, ref);
    },

    async stop(ref: ExecutionReference, reason: string): Promise<void> {
      // 顺序即语义（规格 §6「立即停止本轮」）：
      //   1. 撤销新操作 —— 准许置 revoked：此后本适配器拒绝该 Cycle 的 resume/resumeSuspended，
      //      预算闸门经 admissionProbe 接缝在同一状态上拒绝新请求（评审修正：此前注释声称
      //      CT-04 准入接缝消费此状态但并无接线——现 continuous-model-budget.ts 的
      //      deps.admissionProbe 是真实硬执行点；未注入时仅有 Host 账本行状态这道闸）；
      //   2. abort —— run service cancel(user)：引擎经 stop(user) 结算 stopped，journal 保留；
      //   3. 等待停止 —— waitForQuiescence：结算 + 被中止 turn 的工具/转录收尾，不只等 run-settled。
      const state = admissionOf(ref.cycleId);
      state.admission = "revoked";
      state.lastReason = reason;
      deps.logger?.info?.("Continuous managed cycle stop requested", {
        event: "continuous.execution.stop_requested",
        module: "bootstrap.app",
        cycleId: ref.cycleId,
        runId: ref.workflowRunId,
        reason,
      });
      const cancelled = await deps.runService.cancel(ref.workflowRunId, "user");
      if (!cancelled) {
        // 未知 run 或已结算：cancel 无事可做。等待照旧执行——「已结算」也可能仍有收尾尾巴
        // （I-06），而「从未提交」的等待是立即返回的 no-op（注册表无条目）。
        deps.logger?.info?.("Continuous managed cycle stop found nothing to cancel", {
          event: "continuous.execution.stop_noop",
          module: "bootstrap.app",
          cycleId: ref.cycleId,
          runId: ref.workflowRunId,
        });
      }
      await deps.runService.waitForQuiescence(ref.workflowRunId);
      deps.logger?.info?.("Continuous managed cycle stopped and quiescent", {
        event: "continuous.execution.stopped",
        module: "bootstrap.app",
        cycleId: ref.cycleId,
        runId: ref.workflowRunId,
      });
    },

    async waitForQuiescence(ref: ExecutionReference): Promise<void> {
      await deps.runService.waitForQuiescence(ref.workflowRunId);
    },

    async readReports(ref: ExecutionReference, afterSequence: number): Promise<ReportBatch> {
      const rows = deps.reportReader.listSequencedReportItems(ref.workflowRunId, {
        afterSequence,
        limit: pageSize(),
      });
      const items = rows.map((row) => toReportItem(ref.workflowRunId, row));
      return {
        items,
        // 游标 = 已读到的最后一个 sequence；没有新行时原样返回调用方的 cursor（幂等空页）。
        nextCursor: items.length === 0 ? afterSequence : items[items.length - 1]!.journalSequence,
      };
    },

    async suspendAtSafeBoundary(ref: ExecutionReference, reason: string): Promise<void> {
      // 不等同 stop：绝不 cancel、绝不让 Run 落 stopped/cancelled。冻结的是**本适配器的准许**，
      // 引擎照常把在途操作收尾到安全边界；新请求的硬执行点是预算闸门的 admissionProbe 接缝
      // （continuous-model-budget.ts 装配时注入 (ref) => inspectHealth(ref)，读 admissionState；
      // 评审修正：此前注释声称该接缝已消费此状态但并无接线）。见文件头「挂起语义」。
      const state = admissionOf(ref.cycleId);
      const previous = state.admission;
      state.admission = "suspended";
      state.lastReason = reason;
      deps.logger?.info?.("Continuous managed cycle suspended at safe boundary", {
        event: "continuous.execution.suspended",
        module: "bootstrap.app",
        cycleId: ref.cycleId,
        runId: ref.workflowRunId,
        reason,
        previousAdmission: previous,
      });
    },

    async resumeSuspended(ref: ExecutionReference, epoch: number): Promise<void> {
      requireNotRevoked(ref.cycleId);
      const state = requireEpoch(ref.cycleId, epoch);
      if (state.admission !== "suspended") {
        throw new ContinuousExecutionError(
          "not_suspended",
          `continuous cycle ${ref.cycleId} is not suspended (admission: ${state.admission})`,
        );
      }
      state.admission = "open";
      deps.logger?.info?.("Continuous managed cycle suspension lifted", {
        event: "continuous.execution.resumed_suspended",
        module: "bootstrap.app",
        cycleId: ref.cycleId,
        runId: ref.workflowRunId,
      });
    },

    async inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot> {
      const state = admissionOf(ref.cycleId);
      const actors = deps.journal.listActors(ref.workflowRunId);
      // 可达性只有注册表知道：journal 的 running 行不含「引擎在本进程活着」。
      const reachable = deps.runService.isLiveRun(ref.workflowRunId);
      return {
        runId: ref.workflowRunId,
        actorIds: actors
          .map((actor) => actor.sessionId)
          .filter((sessionId): sessionId is string => sessionId !== undefined),
        ownerEpoch: state.epoch,
        reachable,
        admissionState: state.admission,
        // lastProgressAt / waitingFor 刻意缺席：节点/工具级进展时刻与 normal_wait 证据
        // （owner/原因/期限）归 CT-04 healthMonitor 的探活接缝；本骨架不拿 journal 行的
        // time_updated 冒充进展时刻（规格 §10.1「不采用模型自述」，也不用行更新时间伪装）。
      };
    },
  };
}

/** resume 的共用尾：结构化 reason 原样透传（一处词汇表，见 ContinuousExecutionRejectionReason）。 */
async function resumeRun(
  deps: ContinuousExecutionAdapterDeps,
  ref: ExecutionReference,
): Promise<void> {
  if (deps.runService.resume === undefined) {
    // 生产 run service 恒带 resume；走到这里是 stub/测试装配漏了成员，按接线故障大声失败。
    throw new Error(
      `continuous execution adapter has no run-service resume for run ${ref.workflowRunId}`,
    );
  }
  const result = await deps.runService.resume(ref.workflowRunId);
  if (result.ok) return;
  throw new ContinuousExecutionError(
    result.reason,
    `continuous cycle ${ref.cycleId} resume refused: ${result.reason}${
      result.message === undefined ? "" : ` (${result.message})`
    }`,
  );
}

/** submitOnce 拒绝 → 适配器拒绝：身份三元组归一为 execution_identity_mismatch（规格 §11）。 */
function submitRejectionOf(reason: ManagedRunSubmitRejection): ContinuousExecutionRejectionReason {
  switch (reason) {
    case "owner_mismatch":
    case "script_mismatch":
    case "args_mismatch":
      return "execution_identity_mismatch";
    case "completed":
    case "errored":
      return "not_resumable";
    case "superseded":
      return "superseded";
    case "stopped":
      return "stopped";
  }
}

/** ContinuousReportV1 的五个 item 种类（读侧投影的合法词表）。 */
const REPORT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "candidate",
  "decision",
  "validation",
  "candidate_result",
  "cycle_result",
]);

/** journal report 行 → ContinuousReportItem：kind/itemKey 从载荷投影，投不出来就诚实标 unknown。 */
function toReportItem(
  runId: string,
  row: { sequence: number; item: unknown },
): ContinuousReportItem {
  const payload = row.item;
  const candidate = payload as { kind?: unknown; itemKey?: unknown } | null;
  const shaped = typeof candidate === "object" && candidate !== null;
  const kind =
    shaped && typeof candidate.kind === "string" && REPORT_ITEM_KINDS.has(candidate.kind)
      ? (candidate.kind as ContinuousReportItem["kind"])
      : "unknown";
  const itemKey =
    shaped && typeof candidate.itemKey === "string" && candidate.itemKey.length > 0
      ? candidate.itemKey
      : // 回退键由 journal sequence 派生（规格 §11「itemKey 加来源 journal sequence 去重」）：
        // 载荷没有自带 itemKey 时，sequence 本身就是这条报告的稳定去重身份。
        `report:${runId}:${row.sequence}`;
  return { kind, itemKey, journalSequence: row.sequence, payload };
}

/** ExecutionState.status 的运行态判定（live 注册表条目优先于 journal 行）。 */
export function executionStatusOf(
  live: boolean,
  status: "pending" | "running" | "completed" | "errored" | "stopped",
): ExecutionState["status"] {
  if (live && (status === "pending" || status === "running")) return "running";
  return status;
}
