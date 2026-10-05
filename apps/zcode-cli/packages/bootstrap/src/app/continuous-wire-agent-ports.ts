// ============================================================
// Continuous CLI→Host wire 端口（CT-12）：预算账本/决策持久化/拒绝通知/变更量挂起
// ============================================================
// 从 continuous-registration.ts 拆出（max-lines 约束，非边界变化）：这些端口把 Host 侧
// 服务（budgetAdmission/decisionService/supervisorSettlement）的调用折算成反向协议请求
//（词表与 schema 在 @zcode/shared continuous-registration-protocol）。断联语义：预留请求
// 失败折算 ledger_unreachable（本地不扩额，§9）；挂起等待的本地准入冻结先于通知发送
//（执行适配器是准入状态唯一所有者，§2.1）。

import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousBudgetSuspensionParamsSchema,
  continuousBudgetSuspensionResultSchema,
  continuousDecisionEscalationParamsSchema,
  continuousDecisionEscalationResultSchema,
  continuousLedgerReserveParamsSchema,
  continuousLedgerReserveResultSchema,
  continuousLedgerSettleParamsSchema,
  continuousLedgerSettleResultSchema,
  type ContinuousRegisterManagedRunCommand,
} from "@zcode/shared/continuous-protocol";
import type { ContinuousDecisionSink } from "./continuous-decision-adapter.js";
import type { ContinuousModelBudgetDenial } from "./continuous-model-budget.js";
import type {
  ContinuousAgentWireRequest,
  ContinuousRegistrationAdapterView,
} from "./continuous-registration.js";

export interface ContinuousWireAgentPortDeps {
  request: ContinuousAgentWireRequest;
  getAdapter(): ContinuousRegistrationAdapterView | null;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

function referenceOf(payload: ContinuousRegisterManagedRunCommand) {
  return {
    cycleId: payload.cycleId,
    executionSessionId: payload.executionSessionId,
    workflowRunId: payload.workflowRunId,
    traceId: payload.traceId,
  };
}

/** CLI→Host 账本窄端口（Host 断联/请求失败折算 ledger_unreachable，§9）。 */
export function wireLedger(deps: ContinuousWireAgentPortDeps, payload: ContinuousRegisterManagedRunCommand) {
  return {
    reserve: async (request: {
      requestKey: string;
      provider: string;
      model: string;
      pricingVersion: string;
      reservedCostMicros: number;
      reservedTokens: number;
    }) => {
      try {
        return await deps.request(
          CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
          continuousLedgerReserveParamsSchema.parse({
            programId: payload.programId,
            cycleId: payload.cycleId,
            workflowRunId: payload.workflowRunId,
            ...request,
            // CT-13：执行权版本随预留上送（Host 严格校验，旧 epoch → lease_lost）。
            leaseEpoch: payload.leaseEpoch,
          }),
          continuousLedgerReserveResultSchema,
        );
      } catch (error) {
        return {
          ok: false as const,
          code: "ledger_unreachable" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    settle: async (request: {
      requestKey: string;
      state: "settled" | "unknown";
      actualTokens?: number;
      estimatedCostMicros?: number;
      usage?: unknown;
    }) => {
      await deps.request(
        CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle,
        // CT-13：结算携带归属三元组（Host 校验 requestKey 所属行，跨 Cycle 结算拒绝）。
        continuousLedgerSettleParamsSchema.parse({
          programId: payload.programId,
          cycleId: payload.cycleId,
          workflowRunId: payload.workflowRunId,
          ...request,
        }),
        continuousLedgerSettleResultSchema,
      );
    },
  };
}

/** 拒绝通知 + 等待同一所有者的显式恢复（本地先冻结准入再通知，再等 resumeSuspended）。 */
export function wireSuspensionWait(
  deps: ContinuousWireAgentPortDeps,
  payload: ContinuousRegisterManagedRunCommand,
) {
  return async (
    error: {
      code: string;
      message?: string;
      /** budget_denied 的结构化观测（真实 limitKind/限额/需求；CT-13 原样上送 Host）。 */
      denial?: ContinuousModelBudgetDenial;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const adapter = deps.getAdapter();
    if (adapter === null) {
      throw new Error("continuous registration store has no execution adapter bound");
    }
    // 本地准入状态唯一所有者是执行适配器（§2.1）：先本地冻结再通知——否则 Host 的
    // suspendAtSafeBoundary 往返期间 waitForAdmission 会立刻返回，闸门循环重试预留
    // 变成忙等并重复发送通知。Host 侧的 suspendAtSafeBoundary 之后到达也无害（幂等）。
    await adapter.suspendAtSafeBoundary(referenceOf(payload), `budget:${error.code}`);
    await deps.request(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      continuousBudgetSuspensionParamsSchema.parse({
        programId: payload.programId,
        cycleId: payload.cycleId,
        workflowRunId: payload.workflowRunId,
        leaseEpoch: payload.leaseEpoch,
        code:
          error.code === "admission_closed"
            ? "admission_closed"
            : error.code === "retry_limit"
              ? "retry_limit"
              : "budget_denied",
        message: (error.message ?? error.code).slice(0, 1024),
        ...(error.denial === undefined ? {} : { denial: error.denial }),
      }),
      continuousBudgetSuspensionResultSchema,
    );
    // 等待 resumeSuspended（用户授权 → Host 解冻同一所有者状态）后由原调用重新预留。
    await adapter.waitForAdmission(
      { cycleId: payload.cycleId, workflowRunId: payload.workflowRunId },
      signal,
    );
  };
}

/** 决策持久化 sink（先持久化再撤销候选写许可的 §8 顺序在 decision gate 内）。 */
export function wireDecisionSink(
  deps: ContinuousWireAgentPortDeps,
  payload: ContinuousRegisterManagedRunCommand,
): ContinuousDecisionSink {
  return {
    persist: async (input) =>
      deps.request(
        CONTINUOUS_AGENT_REQUEST_METHODS.decisionEscalation,
        continuousDecisionEscalationParamsSchema.parse({
          programId: payload.programId,
          cycleId: payload.cycleId,
          workflowRunId: payload.workflowRunId,
          fingerprint: input.fingerprint,
          title: input.title,
          context: input.context,
          options: input.options,
          ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
          classification: input.classification,
          ...(input.blockingScope === undefined ? {} : { blockingScope: input.blockingScope }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        }),
        continuousDecisionEscalationResultSchema,
      ),
  };
}

/** 变更量上限的同轮挂起：本地先冻结，再通知 Host 保存继续确认（继续只加本轮额度）。 */
export function wireSuspendForChangeLimit(
  deps: ContinuousWireAgentPortDeps,
  payload: ContinuousRegisterManagedRunCommand,
) {
  return async (detail: { kind: "file_limit" | "line_limit" }): Promise<void> => {
    const adapter = deps.getAdapter();
    if (adapter !== null) {
      await adapter.suspendAtSafeBoundary(referenceOf(payload), `change_limit:${detail.kind}`);
    }
    await deps
      .request(
        CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
        continuousBudgetSuspensionParamsSchema.parse({
          programId: payload.programId,
          cycleId: payload.cycleId,
          workflowRunId: payload.workflowRunId,
          // CT-13：执行权版本随拒绝通知上送（Host 严格校验，旧 epoch 不写暂停）。
          leaseEpoch: payload.leaseEpoch,
          code: "change_limit",
          limitKind: detail.kind,
          message: `变更量达到单轮上限（${detail.kind}）`,
        }),
        continuousBudgetSuspensionResultSchema,
      )
      .catch((error: unknown) => {
        deps.logger?.warn?.("Continuous change-limit suspension notify failed", {
          event: "continuous.registration.change_limit_notify_failed",
          module: "bootstrap.app",
          cycleId: payload.cycleId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  };
}
