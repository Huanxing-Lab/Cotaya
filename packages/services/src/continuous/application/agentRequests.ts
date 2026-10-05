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

import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousBudgetSuspensionParamsSchema,
  continuousDecisionEscalationParamsSchema,
  continuousLedgerReserveParamsSchema,
  continuousLedgerSettleParamsSchema,
} from "@zcode/shared/continuous-protocol";
import { ContinuousBudgetAdmission } from "./budgetAdmission.js";
import { ContinuousDecisionService } from "./decisionService.js";
import type { ContinuousRepositoryPort, ContinuousClockPort } from "./ports.js";
import type { ContinuousExecutionPort } from "./ports.js";
import { suspendCycleForAgentNotification } from "./supervisorSettlement.js";

export interface ContinuousAgentRequestHandlerDeps {
  repository: ContinuousRepositoryPort;
  clock: ContinuousClockPort;
  admission: ContinuousBudgetAdmission;
  decisions: ContinuousDecisionService;
  execution: Pick<ContinuousExecutionPort, "suspendAtSafeBoundary">;
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
        await requireCycleOwnership(deps, parsed.programId, parsed.cycleId);
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
          // 结构化拒绝（§9/CT-13 前置）：拒绝不是故障——携带 limitKind 与观测，不只回文字。
          const denied = error as {
            code?: string;
            limitKind?: string;
            observed?: Record<string, unknown>;
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
                  : {
                      denial: {
                        limitKind: denied.limitKind,
                        cycleSummary: denied.observed.cycle ?? {
                          settledCostMicros: 0,
                          reservedCostMicros: 0,
                          unknownCostMicros: 0,
                          settledTokens: 0,
                          reservedTokens: 0,
                        },
                        ...(denied.observed.daily === undefined
                          ? {}
                          : { dailySummary: denied.observed.daily }),
                      },
                    }),
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
