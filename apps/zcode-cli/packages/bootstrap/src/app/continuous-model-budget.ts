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
// 受管装配提供 suspension 时等待用户继续；未装配的闸门仍结构化拒绝，不发 provider 请求。
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
import { waitForContinuousContinuation } from "./continuous-suspension.js";
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
  | "ledger_unreachable"
  | "lease_lost";

/**
 * budget_denied 附带的结构化观测（wire continuousBudgetDenial 的窄类型）：真实 limitKind、
 * 已用/预留/unknown 三分、当前限额与本请求需求——暂停通知把它原样带给 Host 组装
 * AskUserQuestion（CT-13：拒绝不能只是一段错误文字）。
 */
export interface ContinuousModelBudgetDenial {
  /** 与 wire continuousBudgetDenial.limitKind 同一词表（snake_case，不二次翻译）。 */
  limitKind: "cycle_cost" | "cycle_tokens" | "daily_cost" | "unsafe_integer";
  cycleSummary: Record<string, number>;
  dailySummary?: Record<string, number>;
  currentLimit: Record<string, number | null>;
  request: Record<string, number>;
}

export class ContinuousModelBudgetError extends Error {
  readonly code: ContinuousModelBudgetRejection;
  /** 幂等重试是否安全：全部否——拒绝意味着需要用户确认或修正，不是可重试瞬态。 */
  readonly retryable = false;
  /** budget_denied 的结构化观测（Host 侧账本的真实数字；CT-13）。 */
  readonly denial?: ContinuousModelBudgetDenial;

  constructor(
    code: ContinuousModelBudgetRejection,
    message: string,
    options?: { denial?: ContinuousModelBudgetDenial },
  ) {
    super(message);
    this.name = "ContinuousModelBudgetError";
    this.code = code;
    this.denial = options?.denial;
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
        code:
          | "budget_denied"
          | "admission_closed"
          | "ledger_unreachable"
          | "lease_lost"
          | "pricing_missing";
        message: string;
        /** budget_denied 的结构化观测（Host 账本真实数字；CT-13）。 */
        denial?: ContinuousModelBudgetDenial;
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
  readonly supportsSuspension: boolean;
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
  /** Host 持久化暂停和继续确认；仅在用户授权且同轮准入重开后 resolve。 */
  suspension?: {
    waitForContinuation(error: ContinuousModelBudgetError, signal?: AbortSignal): Promise<void>;
  };
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
    supportsSuspension: deps.suspension !== undefined && deps.admissionProbe !== undefined,
    wrap(inner) {
      return {
        // 刻意无 tryAcquire（文件头）：runner 直接 await acquire。
        acquire: async ({ model, signal }) => {
          const chain: ChainAttempts = { attempts: 1 };
          if (signal !== undefined) {
            const existing = chains.get(signal);
            if (existing) {
              existing.attempts += 1;
              if (existing.attempts > deps.maxAttemptsPerRequest) {
                // CT-13：单请求尝试上限有明确继续授权语义——装配了 suspension 时先冻结并
                // 等待用户（释放并发座位、不再触 inner/账本），授权后同链获得新的尝试预算
                // 继续；未装配（测试替身路径）保持结构化拒绝。
                const error = new ContinuousModelBudgetError(
                  "retry_limit",
                  `continuous model request exceeded ${deps.maxAttemptsPerRequest} attempts for cycle ${deps.cycleId}`,
                );
                if (!deps.suspension) throw error;
                await waitForContinuousContinuation(
                  () => deps.suspension!.waitForContinuation(error, signal),
                  signal,
                );
                // 用户显式继续 = 本链的新尝试预算（每次扩额都需要用户确认并经 Host 落库，
                // 不存在无限自动重试；E-10）。
                existing.attempts = 1;
                chain.attempts = 1;
              } else {
                chain.attempts = existing.attempts;
              }
            } else {
              chains.set(signal, chain);
            }
          }
          // 预算拒绝不能成为 Run 的 errored 终态。暂停期间释放座位，同一调用继续预留，
          // 不重复计入 provider 尝试次数；退出/用户停止由 signal 取消原等待。
          while (true) {
            signal?.throwIfAborted();
            let innerTicket: ModelRequestAdmissionTicket | undefined;
            try {
              const requireOpen = async () => {
                const probe = await deps.admissionProbe?.({ cycleId: deps.cycleId });
                if (probe && probe.admissionState !== "open") {
                  const error = new ContinuousModelBudgetError(
                    "admission_closed",
                    probe.admissionState,
                  );
                  if (probe.admissionState === "revoked")
                    throw Object.assign(error, { revoked: true });
                  throw error;
                }
              };
              await requireOpen();
              innerTicket = await inner?.acquire({ model, signal });
              // 等座位时可能已经暂停，取得座位后再次检查，避免穿过冻结窗口。
              await requireOpen();
              signal?.throwIfAborted();
              const requestKey = `ct-${deps.cycleId}-${chain.attempts}-${randomUUID()}`;
              const reserved = reserveOf(model.providerId, model.modelId);
              const admission = await deps.ledger.reserve({
                programId: deps.programId,
                cycleId: deps.cycleId,
                requestKey,
                provider: model.providerId,
                model: model.modelId,
                pricingVersion: deps.pricing.pricingVersion,
                ...reserved,
              });
              if (!admission.ok) {
                // budget_denied 携带 Host 账本的真实观测（limitKind/已用/预留/unknown/
                // 当前限额/本请求需求）——暂停通知据此组装 AskUserQuestion（CT-13）。
                if (admission.code === "budget_denied" && admission.denial !== undefined) {
                  throw new ContinuousModelBudgetError(admission.code, admission.message, {
                    denial: admission.denial,
                  });
                }
                throw new ContinuousModelBudgetError(admission.code, admission.message);
              }
              return makeBudgetTicket(deps, requestKey, reserved, innerTicket);
            } catch (error) {
              innerTicket?.release();
              if (
                !(error instanceof ContinuousModelBudgetError) ||
                !deps.suspension ||
                "revoked" in error ||
                (error.code !== "budget_denied" && error.code !== "admission_closed")
              )
                throw error;
              await waitForContinuousContinuation(
                () => deps.suspension!.waitForContinuation(error, signal),
                signal,
              );
            }
          }
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
