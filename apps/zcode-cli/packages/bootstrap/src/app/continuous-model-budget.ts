// ============================================================
// Continuous 模型预算闸门（CT-04）：ModelRequestAdmission 接缝上的预算/尝试上限执行点
// ============================================================
// 规格来源：docs/specs/continuous.md §9（预算和请求所有权）、§2（单次模型请求尝试最多 3 次）、
// §6.1（挂起冻结新请求）。规格 §3 差异表：「workflow child 使用 Unbounded 重试预算——不全局
// 重写 retry；Continuous adapter 施加有限边界」即本文件：**不改**所有 session 的全局 retry，
// 只给 managed cycle 的每个 actor 准入端口再包一层。
//
// 接缝事实（contracts/src/model/index.ts 的 ModelRequestAdmission 注释）：端口绑定在 runtime
// 的模型工厂上，runtime 交出的每一个模型句柄——turn step、工具内部的模型调用、压缩、标题
// sidecar——都带它。所以「覆盖 compaction 与相关模型请求」不需要逐点接线，包住端口即全覆盖。
//
// 包装顺序（载荷性）：先过 inner（座位闸门 + 进程治理器），**再**向 Host 账本原子预留——
// 预留必须紧贴 provider 调用，不在等座位时占用额度。预算拒绝时释放已取得的 inner 票据，
// acquire 以结构化错误 reject（runner 归类为 connect 阶段失败，请求不发给 provider）。
//
// 刻意不提供 tryAcquire 快路径：预留必须走异步账本，而 hasFastPath=true 且未命中会让 runner
// 发 model_request_queued/admitted 事件——预算闸门不制造这种观测噪声（acquire 内部仍先试
// inner 的快路径，见 admitAttempt 的实现）。
//
// 尝试上限的归属关联：准入调用只带 {model, signal}，无请求身份；同一逻辑请求的全部尝试
// 复用同一 AbortSignal 实例（runner 的重试循环逐次传 input.request.abortSignal），不同逻辑
// 请求各自持有不同 controller——signal 因此是链身份的可靠关联键。无 signal 的调用无法关联，
// 按 attempt 1 处理（预算预留仍逐次强制；宁少拒不多花）。
//
// 票据即结算事件汇（与治理器同一机制）：completed 带 usage → 幂等结算实际值；connect 阶段
// 失败（请求未发出）→ 结算零；其余无 usage 证据的终局与 release 兜底 → unknown（保留
// reservation，规格 §9）。票据事件同时转发给 inner 票据——治理器靠这些事件判定请求结果，
// 包一层不能把它饿瞎。

import { randomUUID } from "node:crypto";
import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelUsage,
} from "@zcode/contracts";
import { getModelUsageTotalTokens } from "@zcode/contracts";
import {
  estimateContinuousRequestCostMicros,
  lookupContinuousModelPrice,
  type ContinuousPriceSnapshot,
  type ContinuousRequestCaps,
} from "@zcode/shared/continuous-protocol";

/** 预算闸门拒绝（结构化；supervisor 据 code 分流暂停确认，不读错误文本）。 */
export type ContinuousModelBudgetRejection =
  | "budget_denied"
  | "admission_closed"
  | "retry_limit"
  | "pricing_missing"
  | "caps_invalid"
  | "ledger_unreachable";

export class ContinuousModelBudgetError extends Error {
  readonly code: ContinuousModelBudgetRejection;
  /** 幂等重试是否安全：全部否——拒绝意味着需要用户确认或修正，不是可重试瞬态。 */
  readonly retryable = false;

  constructor(code: ContinuousModelBudgetRejection, message: string) {
    super(message);
    this.name = "ContinuousModelBudgetError";
    this.code = code;
  }
}

/**
 * Host 预算账本的窄端口（结构镜像 services 的 RequestAdmissionPort 语义；bootstrap 不依赖
 * @zcode/services，见 continuous-execution-adapter.ts 文件头的同一论证）。
 * Host 断联时 reserve 不可达成 → ledger_unreachable → 新请求拒绝（§9「断开 Host 时不能
 * 在本地自行扩额」）——实现方把传输故障折算成 {ok:false, code:"ledger_unreachable"}。
 */
export interface ContinuousModelBudgetLedgerPort {
  reserve(request: {
    programId: string;
    cycleId: string;
    requestKey: string;
    provider: string;
    model: string;
    pricingVersion: string;
    reservedCostMicros: number;
    reservedTokens: number;
  }): Promise<
    | { ok: true; requestKey: string }
    | {
        ok: false;
        code: "budget_denied" | "admission_closed" | "ledger_unreachable";
        message: string;
      }
  >;
  settle(request: {
    requestKey: string;
    state: "settled" | "unknown";
    actualTokens?: number;
    estimatedCostMicros?: number;
    usage?: unknown;
  }): Promise<void>;
}

/** 闸门实例：wrap 对一个 actor 的准入端口包预算边界（create-app/types 的登记类型）。 */
export interface ContinuousModelBudgetGate {
  wrap(inner?: ModelRequestAdmission): ModelRequestAdmission;
}

export interface ContinuousModelBudgetGateDeps {
  programId: string;
  cycleId: string;
  ledger: ContinuousModelBudgetLedgerPort;
  /**
   * 价格快照（版本随 reservation 落库）；缺失该 model 的单价 → pricing_missing 拒绝。
   */
  pricing: ContinuousPriceSnapshot;
  /** 单请求保守预留的输入/输出 token 上限（§9「每个请求必须有输入上限和输出上限」）。 */
  requestCaps: ContinuousRequestCaps;
  /** 单逻辑请求的尝试上限（默认 3，规格 §2）。 */
  maxAttemptsPerRequest: number;
  /**
   * 本地准许状态探针（评审修复接缝）：适配器 suspendAtSafeBoundary（资源挂起）/stop
   * （用户停止）冻结的是它自己的内存准许状态——本闸门在此硬执行点消费同一状态，冻结后
   * 新请求在等座位、占额度之前就被 admission_closed 拒绝（§6.1「挂起冻结新请求」的 CLI
   * 侧半边）。装配时注入 `(ref) => adapter.inspectHealth(ref)`（HealthSnapshot.admissionState）
   * 或任何同语义探针；缺席时仅依赖 Host 账本行状态（存在「适配器已冻结而 Host 行尚未
   * 推进」的窗口）。
   */
  admissionProbe?: (ref: { cycleId: string }) => Promise<{
    admissionState: "open" | "suspended" | "revoked";
  }>;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

interface ChainAttempts {
  attempts: number;
}

/**
 * 造预算闸门。一个 managed cycle run 一个实例（Host 在 submitOnce 前登记）；
 * wrap() 对该 run 的每个 actor 准入端口调用一次。inner 缺席时闸门独立工作
 * （无治理器装配也要有预算边界）。
 */
export function createContinuousModelBudgetGate(
  deps: ContinuousModelBudgetGateDeps,
): ContinuousModelBudgetGate {
  if (
    !Number.isSafeInteger(deps.requestCaps.inputTokenCap) ||
    deps.requestCaps.inputTokenCap <= 0 ||
    !Number.isSafeInteger(deps.requestCaps.outputTokenCap) ||
    deps.requestCaps.outputTokenCap <= 0
  ) {
    // 装配错误，构造期大声失败：不能限制请求就不该在费用限额下自动执行（§9）。
    throw new ContinuousModelBudgetError(
      "caps_invalid",
      "continuous model budget requires positive integer request caps",
    );
  }
  // 链尝试计数：signal 身份关联（见文件头）；终局后清理，WeakMap 兜底回收。
  const chains = new WeakMap<AbortSignal, ChainAttempts>();

  const reserveOf = (
    providerId: string,
    modelId: string,
  ): { reservedCostMicros: number; reservedTokens: number } => {
    const price = lookupContinuousModelPrice(deps.pricing, providerId, modelId);
    if (price === undefined) {
      throw new ContinuousModelBudgetError(
        "pricing_missing",
        `continuous price snapshot ${deps.pricing.pricingVersion} has no entry for ${providerId}/${modelId}`,
      );
    }
    const estimate = estimateContinuousRequestCostMicros({
      price,
      inputTokens: deps.requestCaps.inputTokenCap,
      outputTokens: deps.requestCaps.outputTokenCap,
    });
    return {
      reservedCostMicros: estimate.totalMicros,
      reservedTokens: deps.requestCaps.inputTokenCap + deps.requestCaps.outputTokenCap,
    };
  };

  return {
    wrap(inner) {
      return {
        // 刻意无 tryAcquire（文件头）：runner 直接 await acquire。
        acquire: async ({ model, signal }) => {
          // 准许冻结优先于一切（评审修复）：挂起（suspendAtSafeBoundary）/用户停止（stop）
          // 之后的新请求在占用座位与额度之前就被拒绝——不能等到 Host 账本行推进才拦。
          if (deps.admissionProbe !== undefined) {
            const probe = await deps.admissionProbe({ cycleId: deps.cycleId });
            if (probe.admissionState !== "open") {
              throw new ContinuousModelBudgetError(
                "admission_closed",
                `continuous cycle ${deps.cycleId} admission is ${probe.admissionState}; new model requests are frozen (§6.1)`,
              );
            }
          }
          const chain: ChainAttempts = { attempts: 1 };
          if (signal !== undefined) {
            const existing = chains.get(signal);
            if (existing) {
              existing.attempts += 1;
              if (existing.attempts > deps.maxAttemptsPerRequest) {
                throw new ContinuousModelBudgetError(
                  "retry_limit",
                  `continuous model request exceeded ${deps.maxAttemptsPerRequest} attempts for cycle ${deps.cycleId}`,
                );
              }
              chain.attempts = existing.attempts;
            } else {
              chains.set(signal, chain);
            }
          }
          const innerTicket =
            inner === undefined ? undefined : await inner.acquire({ model, signal });
          let requestKey: string;
          let reserved: { reservedCostMicros: number; reservedTokens: number };
          try {
            requestKey = `ct-${deps.cycleId}-${chain.attempts}-${randomUUID()}`;
            reserved = reserveOf(model.providerId, model.modelId);
            const admission = await deps.ledger.reserve({
              programId: deps.programId,
              cycleId: deps.cycleId,
              requestKey,
              provider: model.providerId,
              model: model.modelId,
              pricingVersion: deps.pricing.pricingVersion,
              reservedCostMicros: reserved.reservedCostMicros,
              reservedTokens: reserved.reservedTokens,
            });
            if (!admission.ok) {
              throw new ContinuousModelBudgetError(
                admission.code,
                `continuous ledger refused model request for cycle ${deps.cycleId}: ${admission.message}`,
              );
            }
          } catch (error) {
            innerTicket?.release();
            throw error;
          }
          return makeBudgetTicket(deps, requestKey, reserved, innerTicket);
        },
      };
    },
  };
}

/** 本次尝试的票据：结算事件汇 + inner 转发 + release 兜底 unknown。幂等。 */
function makeBudgetTicket(
  deps: ContinuousModelBudgetGateDeps,
  requestKey: string,
  reserved: { reservedCostMicros: number; reservedTokens: number },
  innerTicket: ModelRequestAdmissionTicket | undefined,
): ModelRequestAdmissionTicket {
  let finalized = false;
  const priceOf = (providerId: string, modelId: string) =>
    lookupContinuousModelPrice(deps.pricing, providerId, modelId);
  /** 输入侧 token 数：与 contracts getModelUsageTotalTokens 的 input 口径一致（cache 计入）。 */
  const inputTokensOf = (usage: ModelUsage): number =>
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const finalizeSettled = (
    providerId: string,
    modelId: string,
    usage: ModelUsage | undefined,
    actualTokens: number,
  ): void => {
    if (finalized) return;
    finalized = true;
    const price = priceOf(providerId, modelId);
    // 结算时快照缺价（快照被换掉）：按预留值入账（保守上限），并把 usage 原样带回。
    const estimatedCostMicros =
      price === undefined || usage === undefined
        ? reserved.reservedCostMicros
        : estimateContinuousRequestCostMicros({
            price,
            inputTokens: inputTokensOf(usage),
            outputTokens: usage.outputTokens ?? 0,
          }).totalMicros;
    void deps.ledger
      .settle({ requestKey, state: "settled", actualTokens, estimatedCostMicros, usage })
      .catch((error: unknown) => {
        deps.logger?.warn?.("Continuous usage settle failed", {
          event: "continuous.budget.settle_failed",
          module: "bootstrap.app",
          requestKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  };
  const finalizeUnknown = (): void => {
    if (finalized) return;
    finalized = true;
    void deps.ledger.settle({ requestKey, state: "unknown" }).catch((error: unknown) => {
      deps.logger?.warn?.("Continuous usage mark-unknown failed", {
        event: "continuous.budget.unknown_failed",
        module: "bootstrap.app",
        requestKey,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return {
    publish: (event: ModelNetworkStatusEvent) => {
      innerTicket?.publish(event);
      switch (event.type) {
        case "model_request_completed":
          if (event.usage === undefined) {
            // 成功但 provider 未回报 usage：费用未知 → unknown 保留（§9「收齐 usage 后」才结算）。
            finalizeUnknown();
            return;
          }
          finalizeSettled(
            event.providerId,
            event.modelId,
            event.usage,
            getModelUsageTotalTokens(event.usage),
          );
          return;
        case "model_request_failed": {
          if (event.errorPhase === "connect") {
            // connect 阶段失败：请求未发出（含本闸门自身拒绝前 runner 已持票的罕见交错），
            // 无 provider 费用——按零结算（§9「不能限制请求时拒绝」之外的诚实零账）。
            if (finalized) return;
            finalized = true;
            void deps.ledger
              .settle({ requestKey, state: "settled", actualTokens: 0, estimatedCostMicros: 0 })
              .catch(() => {
                /* 日志可选；结零失败留给晚到 usage 幂等路径兜底。 */
              });
            return;
          }
          // 非 connect 失败：provider 可能已处理（流中断等），无 usage 证据 → unknown 保留。
          finalizeUnknown();
          return;
        }
        case "model_retry_scheduled":
          // 本次尝试已终结、无 usage 事实；retry 是新 attempt（新 requestKey、逐次预留）。
          finalizeUnknown();
          return;
        default:
          return;
      }
    },
    publishFailure: (event, error) => {
      innerTicket?.publishFailure?.(event, error);
    },
    release: () => {
      // 兜底（与治理器同一纪律）：未见终结事件即按终结处理 → unknown（§9/R-07）。
      finalizeUnknown();
      innerTicket?.release();
    },
  };
}
