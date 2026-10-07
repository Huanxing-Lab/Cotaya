// Continuous 继续确认（CT-04）：资源上限/运行健康暂停的用户确认与本轮 grant。
// 规格来源：docs/specs/continuous.md §5（ContinuousContinuationRequest）、§6.1（继续确认）、
// §10.1（suspected_hang 询问）。与产品 Decision Queue 分开：这里只暂停所属 Cycle。
//
// 事件顺序（唯一所有者链）：
//   上限/健康触发 → openRequest：同 Cycle 已有 pending 时**合并**（追加 reason，不重复弹窗；
//     部分唯一索引兜底并发）；新请求落 pending 并回填 cycle.pendingContinuationRequestId。
//   用户回答 → resolve：version 乐观校验（旧 version 拒绝、同值重放幂等 no-op）；
//     continue_with_grant 持久化本轮 grant 增量——**不重置已消耗量**、不铸新 Run、
//     不解除其他限制（仅确认受影响上限）；end_cycle 只记录用户取消意图（终态结算归
//     supervisor/CT-05）；stay_paused 保持 pending 工作。
//   重启/跨日：行在 tasks-index 持久化，用户同意前不自动恢复（R-11/E-32）。

import { randomUUID } from "node:crypto";
import type {
  ContinuationGrant,
  ContinuationRequest,
  ContinuationRequestReason,
  Cycle,
} from "../domain/types.js";
import type { ContinuousClockPort, ContinuousRepositoryPort } from "./ports.js";

/** 回答载荷（AskUserQuestion 四选项的结构化形态，规格 §6.1）。 */
export type ContinuationAnswer =
  | { kind: "continue_with_grant"; grant: ContinuationGrant }
  | {
      kind: "adjust_config_and_continue";
      grant: ContinuationGrant;
      configAdjustment: NonNullable<ContinuationRequest["resolution"]>["configAdjustment"];
    }
  | { kind: "stay_paused" }
  | { kind: "end_cycle" };

export class ContinuationVersionConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor(requestId: string, expected: number, presented: number) {
    super(
      `continuation request ${requestId} version conflict: current ${expected}, presented ${presented}`,
    );
    this.name = "ContinuationVersionConflictError";
  }
}

export interface ContinuousContinuationServiceDeps {
  repository: ContinuousRepositoryPort;
  clock: Pick<ContinuousClockPort, "now">;
}

export interface OpenContinuationInput {
  cycle: Cycle;
  reason: ContinuationRequestReason;
  limitKind: ContinuationRequest["limitKind"];
  observedUsage: unknown;
  currentLimit: unknown;
  recommendedExtension: unknown;
}

export class ContinuousContinuationService {
  constructor(private readonly deps: ContinuousContinuationServiceDeps) {}

  /**
   * 打开（或合并进）同轮唯一的 pending 继续确认。返回生效的请求。
   * 合并语义：已 pending 时追加 reason/更新观测（version+1），同 id 不重复弹窗（规格 §5）。
   */
  async openRequest(input: OpenContinuationInput): Promise<ContinuationRequest> {
    const now = this.deps.clock.now();
    const pending = await this.deps.repository.getPendingContinuationRequest(input.cycle.id);
    if (pending) {
      if (!pending.reasons.includes(input.reason)) pending.reasons.push(input.reason);
      const merged: ContinuationRequest = {
        ...pending,
        observedUsage: input.observedUsage,
        currentLimit: input.currentLimit,
        recommendedExtension: input.recommendedExtension,
        version: pending.version + 1,
      };
      await this.deps.repository.saveContinuationRequest(merged);
      return merged;
    }
    const request: ContinuationRequest = {
      id: randomUUID(),
      programId: input.cycle.programId,
      cycleId: input.cycle.id,
      reason: input.reason,
      reasons: [input.reason],
      limitKind: input.limitKind,
      observedUsage: input.observedUsage,
      currentLimit: input.currentLimit,
      recommendedExtension: input.recommendedExtension,
      version: 1,
      status: "pending",
      createdAt: now,
    };
    await this.deps.repository.insertContinuationRequest(request);
    // 回填指针与审计事件同一所有者（本服务）；失败时行已在，指针补写归下一次 openRequest/恢复核对。
    await this.deps.repository.saveCycle({
      ...input.cycle,
      pendingContinuationRequestId: request.id,
      updatedAt: now,
    });
    await this.deps.repository.appendEvent({
      programId: input.cycle.programId,
      cycleId: input.cycle.id,
      eventKey: `continuation_opened:${request.id}:${request.version}`,
      type: "continuous.continuation.opened",
      payload: { requestId: request.id, reason: request.reason, reasons: request.reasons },
      createdAt: now,
    });
    return request;
  }

  async getPending(cycleId: string): Promise<ContinuationRequest | null> {
    return this.deps.repository.getPendingContinuationRequest(cycleId);
  }

  /**
   * 回答：version 必须等于当前值（+1 落库）。同 version 同 kind 的重放幂等 no-op
   * （返回既有 resolution）；旧 version 抛 version_conflict（E-32「重复回答不重复扩额」）。
   */
  async resolve(input: {
    requestId: string;
    version: number;
    answer: ContinuationAnswer;
  }): Promise<ContinuationRequest> {
    const request = await this.deps.repository.getContinuationRequest(input.requestId);
    if (!request)
      throw Object.assign(new Error(`continuation request 不存在: ${input.requestId}`), {
        kind: "not_found",
      });
    if (request.status === "resolved") {
      // 幂等重放（E-32「重放相同回答」）：回答落库时 version 已 +1，原回答携带的是
      // 回答前的版本（stored-1）；同 kind、同载荷（grant/配置调整）且版本吻合 → 同一回答
      // 的重复提交，no-op。CT-13：同 version 但不同 grant/配置的回答是**异答**，按
      // version_conflict 拒绝——不能借旧 version 的重放换一份更大的扩额。
      const answeredAtVersion = request.version - 1;
      const samePayload =
        request.resolution?.kind === input.answer.kind &&
        JSON.stringify(request.resolution.grant ?? null) ===
          JSON.stringify(
            input.answer.kind === "continue_with_grant" ||
              input.answer.kind === "adjust_config_and_continue"
              ? (input.answer.grant ?? null)
              : null,
          ) &&
        JSON.stringify(request.resolution.configAdjustment ?? null) ===
          JSON.stringify(
            input.answer.kind === "adjust_config_and_continue"
              ? (input.answer.configAdjustment ?? null)
              : null,
          );
      if (samePayload && input.version === answeredAtVersion) return request;
      throw new ContinuationVersionConflictError(input.requestId, request.version, input.version);
    }
    if (input.version !== request.version)
      throw new ContinuationVersionConflictError(input.requestId, request.version, input.version);
    const now = this.deps.clock.now();
    const resolved: ContinuationRequest = {
      ...request,
      status: "resolved",
      resolvedAt: now,
      resolution: {
        kind: input.answer.kind,
        resolvedAt: now,
        ...(input.answer.kind === "continue_with_grant" ||
        input.answer.kind === "adjust_config_and_continue"
          ? { grant: input.answer.grant }
          : {}),
        ...(input.answer.kind === "adjust_config_and_continue"
          ? { configAdjustment: input.answer.configAdjustment }
          : {}),
      },
      version: request.version + 1,
    };
    await this.deps.repository.saveContinuationRequest(resolved);
    await this.deps.repository.appendEvent({
      programId: request.programId,
      cycleId: request.cycleId,
      eventKey: `continuation_resolved:${request.id}:${resolved.version}`,
      type: "continuous.continuation.resolved",
      payload: { requestId: request.id, kind: input.answer.kind, version: resolved.version },
      createdAt: now,
    });
    return resolved;
  }

  /** 本轮全部 grant 增量（准入/计时消费；不重置消耗量）。 */
  async grantsOf(cycleId: string): Promise<ContinuationGrant[]> {
    return this.deps.repository.listCycleContinuationGrants(cycleId);
  }
}
