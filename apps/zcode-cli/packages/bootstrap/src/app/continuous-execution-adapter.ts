// Continuous CLI 执行适配器：Host 保存业务状态，CLI 保存准入守卫、journal 和活 Run。
// 预算暂停冻结新操作并等待；用户停止永久撤销；退出以 interrupted 取消并保留同 Run 恢复。
// services 不引用 Runtime，执行端口通过 shared 的严格 wire 契约传输。

import {
  submitRejectionOf,
  toReportItem,
  executionStatusOf,
} from "./continuous-execution-observation.js";
export { executionStatusOf } from "./continuous-execution-observation.js";
import { createContinuousAdmissionWaiters } from "./continuous-admission-waiters.js";
import { createHash } from "node:crypto";
import { createContinuousHealthEvidence } from "./continuous-health-evidence.js";
import {
  createContinuousOperationWaitRegistry,
  type ContinuousOperationWaitFact,
  type ContinuousOperationWaitHandle,
} from "./continuous-operation-waits.js";
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
  ManagedRunSubmitRequest,
  ManagedRunSubmitResult,
} from "./dynamic-workflow-run-managed-submit.js";

// ── services 端口的结构镜像（见文件头）────────────────────────

import type {
  ManagedCycleInput,
  ExecutionReference,
  ExecutionState,
  ReportBatch,
  HealthSnapshot,
  ContinuousExecutionPort,
} from "./continuous-execution-contract.js";
export type * from "./continuous-execution-contract.js";

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
  /** 生产装配必须核对全部 run 保护；单独适配器契约测试可以不传。 */
  beforeSubmit?: (input: ManagedCycleInput) => void | Promise<void>;
  beforeResume?: (
    ref: ExecutionReference,
    executionPath: string | undefined,
  ) => void | Promise<void>;
  /**
   * 评审修复（CT-12 遗留缺口）：按 Run ID 查登记处冻结的并发上限，随 submitOnce 传入
   * 引擎 caps（ticket CT-12「10 并发上限来自冻结配置并传入引擎 caps，不能退回 CPU 默认
   * 值」）。缺省（未登记/未注入）不传——与既有 fixture 直连适配器的行为一致。
   */
  maxConcurrencyFor?: (runId: string) => number | undefined;
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
): ContinuousExecutionPort & {
  /** CLI 内部接缝：预算与文件端口共享本适配器准入；不新增 Host wire 命令。 */
  waitForAdmission(ref: ExecutionReference, signal?: AbortSignal): Promise<void>;
  /**
   * CT-14 操作等待登记（测试/工具等实际等待）：trusted 端口写入、inspectHealth 聚合读取
   *（同一所有者；登记是探活证据不是业务状态）。不新增 Host wire 命令。
   */
  registerOperationWait(
    fact: ContinuousOperationWaitFact,
    signal?: AbortSignal,
  ): ContinuousOperationWaitHandle;
} {
  const admissions = new Map<string, CycleAdmissionState>();
  /** CT-14 操作等待登记的唯一实例：trusted 端口写入、健康快照读取（同一所有者）。 */
  const operationWaits = createContinuousOperationWaitRegistry();
  const evidenceOf = createContinuousHealthEvidence(deps.journal, {
    operationWaits,
    now: () => Date.now(),
  });
  const pageSize = () => deps.reportPageSize ?? DEFAULT_REPORT_PAGE_SIZE;

  const admissionOf = (cycleId: string): CycleAdmissionState => {
    let state = admissions.get(cycleId);
    if (state === undefined) {
      state = { epoch: 0, admission: "open" };
      admissions.set(cycleId, state);
    }
    return state;
  };

  const waiters = createContinuousAdmissionWaiters((cycleId) => admissionOf(cycleId).admission);

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
    waitForAdmission: (ref, signal) => waiters.wait(ref.cycleId, signal),
    /**
     * CT-14 操作等待登记（测试/工具等实际等待）：trusted 端口经登记处的适配器视图调用；
     * 快照聚合按本适配器的 epoch 高水位过滤旧登记。不新增 Host wire 命令——登记是
     * CLI 进程内的探活证据，不是业务状态。
     */
    registerOperationWait: (
      fact: ContinuousOperationWaitFact,
      signal?: AbortSignal,
    ): ContinuousOperationWaitHandle => operationWaits.register(fact, signal),
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
      await deps.beforeSubmit?.(input);
      // 冻结并发上限（评审修复）：登记先于 submitOnce（wire 执行端口的固定顺序），
      // 这里按 Run ID 现读登记处；未登记/未注入时不传（CPU 天花板兜底，fixture 同旧）。
      const maxConcurrency = deps.maxConcurrencyFor?.(input.workflowRunId);
      const result = await deps.runService.submitOnce({
        runId: input.workflowRunId,
        scriptText: input.scriptText,
        cwd: input.executionPath,
        parentSessionId: input.executionSessionId,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
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
      await deps.beforeResume?.(ref, deps.journal.getRun(ref.workflowRunId)?.cwd);
      await resumeRun(deps, ref);
      admissionOf(ref.cycleId).admission = "open";
      waiters.notify(ref.cycleId);
    },

    async stop(ref: ExecutionReference, reason: string): Promise<void> {
      // 先撤销新操作，再取消并等待工具收尾；用户停止后的 Run 不自动恢复。
      const state = admissionOf(ref.cycleId);
      state.admission = "revoked";
      waiters.notify(ref.cycleId);
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

    async interrupt(ref: ExecutionReference, epoch: number): Promise<void> {
      requireNotRevoked(ref.cycleId);
      requireEpoch(ref.cycleId, epoch).admission = "suspended";
      // 光冻结会让预算等待永不结算；退出取消用 interrupted，不能撤销成 user stop。
      await deps.runService.cancel(ref.workflowRunId, "interrupted");
      await deps.runService.waitForQuiescence(ref.workflowRunId);
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
      requireNotRevoked(ref.cycleId);
      // 资源暂停只冻结准入，不取消同 Run；在途操作允许收尾。
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
      await deps.beforeResume?.(ref, deps.journal.getRun(ref.workflowRunId)?.cwd);
      const state = requireEpoch(ref.cycleId, epoch);
      if (state.admission !== "suspended") {
        throw new ContinuousExecutionError(
          "not_suspended",
          `continuous cycle ${ref.cycleId} is not suspended (admission: ${state.admission})`,
        );
      }
      // 旧版预算错误已结算为 errored，开内存闸门不能恢复它，必须明确拒绝。
      const record = deps.journal.getRun(ref.workflowRunId);
      if (record && record.status !== "pending" && record.status !== "running") {
        throw new ContinuousExecutionError(
          "not_resumable",
          `run ${ref.workflowRunId} is ${record.status}`,
        );
      }
      state.admission = "open";
      waiters.notify(ref.cycleId);
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
        // epoch 高水位随调用传入：旧执行权登记的操作等待不作数（CT-14）。
        ...evidenceOf(ref.workflowRunId, state.epoch),
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
