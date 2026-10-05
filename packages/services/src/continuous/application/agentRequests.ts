// CT-12 CLI→Host 请求处理：预算预留/结算、拒绝通知（保存暂停与继续确认）、决策持久化的
// 宿主侧入口。桌面装配把它接进 agent 服务的 client request 拦截路径（zcodeAgentService 的
// client.onRequest）；本文件只做 schema 校验 + 归属校验 + 委托既有服务，不另写业务链：
//   - ledger.reserve/settle → ContinuousBudgetAdmission（账本唯一写入者，§9）；
//   - budget/suspend → suspendCycleForAgentNotification（与监督挂起同一条落库链）；
//   - decision/escalate → ContinuousDecisionService.recordEscalationDecision（先持久化，
//     撤销候选写许可由 CLI 侧 grant holder 执行，§8）。
//
// 归属校验：请求携带的 programId/cycleId 必须与持久化行互相匹配（复合 FK 语义的服务层
// 投影），跨 Program 的请求拒绝——防「原路径和远程同路径串任务」。
//
// CT-13 传输严格校验（身份、执行权版本、价格版本、请求键）：
//   - 预留/拒绝通知携带的 workflowRunId 必须等于 Cycle 行的执行身份、leaseEpoch 必须等于
//     Cycle 行的当前执行权版本（旧 epoch → 结构化 lease_lost，不给旧执行者扩额或写暂停）；
//   - 预留的 pricingVersion 必须等于装配注入的当前价格快照（不符 → pricing_missing，
//     fail closed，不按旧价入账）；
//   - 结算按 requestKey 归属行校验（跨 Cycle 结算拒绝；旧 epoch 的晚到 usage 允许幂等收尾）。

import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousBudgetSuspensionParamsSchema,
  continuousDecisionEscalationParamsSchema,
  continuousLedgerReserveParamsSchema,
  continuousLedgerSettleParamsSchema,
  type ContinuousBudgetDenial,
  type ContinuousPriceSnapshot,
} from "@zcode/shared/continuous-protocol";
import { ContinuousBudgetAdmission } from "./budgetAdmission.js";
import { ContinuousDecisionService } from "./decisionService.js";
import type { ContinuousRepositoryPort, ContinuousClockPort } from "./ports.js";
import type { ContinuousExecutionPort } from "./ports.js";
import { suspendCycleForAgentNotification } from "./supervisorSettlement.js";
import type { BudgetAdmissionObservation } from "../domain/budgetPolicy.js";

export interface ContinuousAgentRequestHandlerDeps {
  repository: ContinuousRepositoryPort;
  clock: ContinuousClockPort;
  admission: ContinuousBudgetAdmission;
  decisions: ContinuousDecisionService;
  execution: Pick<ContinuousExecutionPort, "suspendAtSafeBoundary">;
  /** 装配注入的当前价格快照（价格版本校验的唯一事实源；CT-13）。 */
  pricing: () => ContinuousPriceSnapshot | undefined;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

export type ContinuousAgentRequestOutcome =
  | { handled: false }
  | { handled: true; result: unknown }
  | { handled: true; error: { code: number; message: string } };

/** 处理一条 CLI→Host 请求；method 不属于 Continuous 词表时 handled=false（交回默认路径）。 */
export async function handleContinuousAgentRequest(
  deps: ContinuousAgentRequestHandlerDeps,
  method: string,
  params: unknown,
): Promise<ContinuousAgentRequestOutcome> {
  if (!Object.values(CONTINUOUS_AGENT_REQUEST_METHODS).includes(method as never)) {
    return { handled: false };
  }
  try {
    switch (method) {
      case CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve: {
        const parsed = continuousLedgerReserveParamsSchema.parse(params);
        const { cycle } = await requireCycleOwnership(deps, parsed.programId, parsed.cycleId);
        // 身份：预留必须属于该 Cycle 的执行 Run（防串任务/伪造归属）。
        if (cycle.workflowRunId !== parsed.workflowRunId) {
          throw new Error(
            `cycle ${parsed.cycleId} 的执行 Run 是 ${cycle.workflowRunId}，拒绝为 ${parsed.workflowRunId} 预留`,
          );
        }
        // 执行权版本：旧 epoch 一律 lease_lost（§10「旧 epoch 不可写或扩额」）。
        if (parsed.leaseEpoch !== cycle.leaseEpoch) {
          return {
            handled: true,
            result: {
              ok: false,
              code: "lease_lost",
              message: `lease epoch ${parsed.leaseEpoch} ≠ 当前 ${cycle.leaseEpoch}（cycle ${parsed.cycleId}）`,
            },
          };
        }
        // 价格版本：CLI 登记的价格快照必须仍是 Host 当前快照（换价后必须重新登记；§9）。
        const pricing = deps.pricing();
        if (pricing === undefined || pricing.pricingVersion !== parsed.pricingVersion) {
          return {
            handled: true,
            result: {
              ok: false,
              code: "pricing_missing",
              message: `价格版本不符：请求 ${parsed.pricingVersion}，当前 ${
                pricing?.pricingVersion ?? "（快照缺席）"
              }；重新登记后按新价预留（§9 fail closed）`,
            },
          };
        }
        try {
          const ticket = await deps.admission.reserve({
            programId: parsed.programId,
            cycleId: parsed.cycleId,
            requestKey: parsed.requestKey,
            provider: parsed.provider,
            model: parsed.model,
            pricingVersion: parsed.pricingVersion,
            reservedCostMicros: parsed.reservedCostMicros,
            reservedTokens: parsed.reservedTokens,
          });
          return { handled: true, result: { ok: true, requestKey: ticket.requestKey } };
        } catch (error) {
          // 结构化拒绝（§9/CT-13）：拒绝不是故障——携带真实 limitKind、已用/预留/unknown、
          // 当前限额与本请求需求，不只回错误文字。
          const denied = error as {
            code?: string;
            limitKind?: string;
            observed?: BudgetAdmissionObservation;
            message?: string;
          };
          if (denied.code === "budget_denied" || denied.code === "admission_closed") {
            return {
              handled: true,
              result: {
                ok: false,
                code: denied.code,
                message: denied.message ?? denied.code,
                ...(denied.limitKind === undefined || denied.observed === undefined
                  ? {}
                  : { denial: denialOf(denied.limitKind, denied.observed) }),
              },
            };
          }
          return {
            handled: true,
            error: {
              code: -32000,
              message: `continuous ledger reserve failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }
      case CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle: {
        const parsed = continuousLedgerSettleParamsSchema.parse(params);
        // 归属：结算的 requestKey 必须属于请求声称的 Cycle（跨 Cycle 结算拒绝；幂等收尾
        // 允许旧 epoch 晚到 usage，E-19——因此这里不校验 leaseEpoch）。
        const record = await deps.repository.getUsageRecord(parsed.requestKey);
        if (!record || record.cycleId !== parsed.cycleId) {
          throw new Error(
            `usage reservation ${parsed.requestKey} 不属于 cycle ${parsed.cycleId}（归属校验失败）`,
          );
        }
        if (parsed.state === "unknown") {
          await deps.admission.markUnknown(parsed.requestKey);
        } else {
          await deps.admission.settle({
            requestKey: parsed.requestKey,
            actualTokens: parsed.actualTokens ?? 0,
            estimatedCostMicros: parsed.estimatedCostMicros ?? 0,
            usage: parsed.usage ?? null,
          });
        }
        return { handled: true, result: { accepted: true } };
      }
      case CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension: {
        const parsed = continuousBudgetSuspensionParamsSchema.parse(params);
        const { cycle, program } = await requireCycleOwnership(
          deps,
          parsed.programId,
          parsed.cycleId,
        );
        if (
          cycle.workflowRunId !== parsed.workflowRunId ||
          parsed.leaseEpoch !== cycle.leaseEpoch
        ) {
          // 旧执行权的暂停通知不能覆盖新 epoch 的状态（E-19「旧业务结果不覆盖新 epoch」）。
          throw new Error(
            `拒绝通知的执行身份/执行权不符（run ${parsed.workflowRunId}/epoch ${parsed.leaseEpoch} ≠ ` +
              `${cycle.workflowRunId}/${cycle.leaseEpoch}），cycle ${parsed.cycleId}`,
          );
        }
        const requestId = await suspendCycleForAgentNotification(
          {
            repository: deps.repository,
            execution: deps.execution,
            clock: deps.clock,
          },
          {
            cycle,
            program,
            code: parsed.code,
            ...(parsed.limitKind === undefined ? {} : { limitKind: parsed.limitKind }),
            ...(parsed.denial === undefined ? {} : { denial: parsed.denial }),
            message: parsed.message,
          },
        );
        return { handled: true, result: { continuationRequestId: requestId } };
      }
      case CONTINUOUS_AGENT_REQUEST_METHODS.decisionEscalation: {
        const parsed = continuousDecisionEscalationParamsSchema.parse(params);
        await requireCycleOwnership(deps, parsed.programId, parsed.cycleId);
        const stored = await deps.decisions.recordEscalationDecision({
          programId: parsed.programId,
          cycleId: parsed.cycleId,
          fingerprint: parsed.fingerprint,
          title: parsed.title,
          context: parsed.context,
          options: parsed.options,
          ...(parsed.recommendation === undefined ? {} : { recommendation: parsed.recommendation }),
          classification: parsed.classification,
          ...(parsed.blockingScope === undefined ? {} : { blockingScope: parsed.blockingScope }),
          ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
        });
        return {
          handled: true,
          result: {
            decisionId: stored.decision.id,
            fingerprint: stored.decision.fingerprint,
            status: stored.decision.status,
            merged: stored.merged,
          },
        };
      }
      default:
        return { handled: false };
    }
  } catch (error) {
    deps.logger?.warn?.("Continuous agent request failed", {
      event: "continuous.agent_request.failed",
      module: "services.continuous",
      method,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return {
      handled: true,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** 归属校验：cycle 必须属于 program，行缺失也按校验失败（不区分存在性，防探测）。 */
async function requireCycleOwnership(
  deps: ContinuousAgentRequestHandlerDeps,
  programId: string,
  cycleId: string,
): Promise<{
  cycle: NonNullable<Awaited<ReturnType<ContinuousRepositoryPort["getCycle"]>>>;
  program: NonNullable<Awaited<ReturnType<ContinuousRepositoryPort["getProgram"]>>>;
}> {
  const cycle = await deps.repository.getCycle(cycleId);
  if (!cycle || cycle.programId !== programId) {
    throw new Error(`cycle ${cycleId} 不属于 program ${programId}（归属校验失败）`);
  }
  const program = await deps.repository.getProgram(programId);
  if (!program) {
    throw new Error(`program 不存在: ${programId}`);
  }
  return { cycle, program };
}

/**
 * 领域观测快照 → wire denial（CT-13）。reserved = unsettled - unknown（在途预留部分），
 * 已用/预留/unknown 三分如实上送；当前限额取拒绝时刻的有效上限（含 grant 增量）。
 */
function denialOf(limitKind: string, observed: BudgetAdmissionObservation): ContinuousBudgetDenial {
  const summaryOf = (summary: BudgetAdmissionObservation["cycle"]) => ({
    settledCostMicros: summary.settledCostMicros,
    reservedCostMicros: summary.unsettledCostMicros - summary.unknownCostMicros,
    unknownCostMicros: summary.unknownCostMicros,
    settledTokens: summary.settledTokens,
    reservedTokens: summary.unsettledTokens - summary.unknownTokens,
    unknownTokens: summary.unknownTokens,
  });
  return {
    // 领域与 wire 共用同一 limitKind 词表（cycle_tokens/daily_cost/cycle_cost/unsafe_integer）。
    limitKind: limitKind as ContinuousBudgetDenial["limitKind"],
    cycleSummary: summaryOf(observed.cycle),
    ...(observed.daily === undefined ? {} : { dailySummary: summaryOf(observed.daily) }),
    currentLimit: {
      cycleCostMicros: observed.limits.cycleCostMicros,
      cycleTokens: observed.limits.cycleTokens,
      dailyCostMicros: observed.limits.dailyCostMicros,
    },
    request: {
      reservedCostMicros: observed.reservedCostMicros,
      reservedTokens: observed.reservedTokens,
    },
  };
}
