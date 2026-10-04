// Continuous 预算准入（CT-04）：RequestAdmissionPort 的应用层实现，账本唯一写入路径。
// 规格来源：docs/specs/continuous.md §9（预算和请求所有权）与 §6.1（grant 增量）。
//
// 事件顺序（唯一所有者链）：
//   CLI 预算闸门 acquire → 本类 reserve：
//     1. 读 Cycle/Program（status 与预算策略、Program 时区）；
//     2. 井入本轮已 resolved 的继续 grant（增量，不重置消耗）；
//     3. repository.admitUsageReservation —— 事务内「汇总+判定+落库」，并发不超发；
//     4. 拒绝抛 ContinuousBudgetDeniedError（携带 limitKind 与观测快照，供 AskUserQuestion）。
//   usage 回传 → settle（幂等：同值重放 no-op，不同值冲突）；无证据终局 → markUnknown
//   （保留 reservation）；显式核销 → writeOff（用户动作，审计事件，规格 §9）。
//
// Host 断联语义：CLI 侧拿不到本类即拿不到 ticket，新请求被拒（断联扩额不存在）。

import { randomUUID } from "node:crypto";
import type {
  AdmissionRequest,
  AdmissionTicket,
  ContinuousClockPort,
  ContinuousRepositoryPort,
  RequestAdmissionPort,
  UsageSettlement,
} from "./ports.js";
import type { BudgetAdmissionObservation, UsageLedgerSummary } from "../domain/budgetPolicy.js";
import {
  assertValidTimeZone,
  dayWindowFor,
  mergeContinuationGrants,
} from "../domain/budgetPolicy.js";
import type { Cycle, Program } from "../domain/types.js";

/** 准入拒绝（结构化；调用方据此分流暂停确认，不读错误文本）。 */
export class ContinuousBudgetDeniedError extends Error {
  readonly code = "budget_denied" as const;
  readonly limitKind: string;
  readonly observed: BudgetAdmissionObservation;

  constructor(limitKind: string, observed: BudgetAdmissionObservation, message: string) {
    super(message);
    this.name = "ContinuousBudgetDeniedError";
    this.limitKind = limitKind;
    this.observed = observed;
  }
}

/** Cycle 不在可发请求状态（suspended/preparing/settling/终态）：新请求冻结。 */
export class ContinuousAdmissionClosedError extends Error {
  readonly code = "admission_closed" as const;
  readonly cycleStatus: string;

  constructor(cycleStatus: string, cycleId: string) {
    super(`continuous cycle ${cycleId} is not admitting model requests (status: ${cycleStatus})`);
    this.name = "ContinuousAdmissionClosedError";
    this.cycleStatus = cycleStatus;
  }
}

export interface ContinuousBudgetAdmissionDeps {
  repository: ContinuousRepositoryPort;
  clock: Pick<ContinuousClockPort, "now">;
}

/**
 * 模型请求准入（规格 §9）。不是第二份账本：唯一的账本写入者是这里的 repository 调用，
 * CLI 侧闸门只铸造 requestKey 并转发预留/结算，不保存任何金额事实。
 */
export class ContinuousBudgetAdmission implements RequestAdmissionPort {
  constructor(private readonly deps: ContinuousBudgetAdmissionDeps) {}

  async reserve(request: AdmissionRequest): Promise<AdmissionTicket> {
    const cycle = await this.deps.repository.getCycle(request.cycleId);
    if (!cycle)
      throw Object.assign(new Error(`cycle 不存在: ${request.cycleId}`), { kind: "not_found" });
    // 冻结语义（§6.1）：suspended 后新请求拒绝；已预留在途操作凭既有 ticket 完成。
    if (cycle.status !== "running")
      throw new ContinuousAdmissionClosedError(cycle.status, cycle.id);
    const program = await this.deps.repository.getProgram(cycle.programId);
    if (!program)
      throw Object.assign(new Error(`program 不存在: ${cycle.programId}`), { kind: "not_found" });
    assertValidTimeZone(program.timeZone);
    const grants = await this.deps.repository.listCycleContinuationGrants(cycle.id);
    const limits = mergeContinuationGrants(program.budget, grants);
    const occurredAt = this.deps.clock.now();
    // 日窗口按「预留时的发生时间 + Program 时区」计算；晚到补结算不改行归属（§9）。
    const window = dayWindowFor(occurredAt, program.timeZone);
    const admission = await this.deps.repository.admitUsageReservation({
      programId: program.id,
      limits,
      window: { fromMs: window.startMs, toMs: window.endMs },
      reservation: {
        id: randomUUID(),
        cycleId: request.cycleId,
        requestKey: request.requestKey,
        state: "reserved",
        provider: request.provider,
        model: request.model,
        pricingVersion: request.pricingVersion,
        reservedCostMicros: request.reservedCostMicros,
        reservedTokens: request.reservedTokens,
        occurredAt,
        updatedAt: occurredAt,
      },
    });
    if (admission.status === "denied") {
      throw new ContinuousBudgetDeniedError(
        admission.denial.limitKind,
        {
          cycle: admission.denial.cycleSummary,
          ...(admission.denial.dailySummary === undefined
            ? {}
            : { daily: admission.denial.dailySummary }),
          reservedCostMicros: request.reservedCostMicros,
          reservedTokens: request.reservedTokens,
        },
        `continuous budget denied (${admission.denial.limitKind}) for cycle ${request.cycleId}`,
      );
    }
    return { requestKey: request.requestKey };
  }

  /** 幂等结算：同值重放 no-op；不同值冲突抛 already_settled；行缺失抛 not_found。 */
  async settle(settlement: UsageSettlement): Promise<void> {
    await this.deps.repository.settleUsageRecord({
      requestKey: settlement.requestKey,
      actualTokens: settlement.actualTokens,
      estimatedCostMicros: settlement.estimatedCostMicros,
      usage: settlement.usage,
      updatedAt: this.deps.clock.now(),
    });
  }

  /** 无 usage 证据的终局（重试、流中断、release 兜底）：保留 reservation 置 unknown。 */
  async markUnknown(requestKey: string): Promise<void> {
    await this.deps.repository.markUsageUnknown(requestKey, this.deps.clock.now());
  }

  /**
   * 显式核销（规格 §9「只能用户显式核销」）：把 unknown 行按零实际用量结算并记审计事件。
   * 不是清零删除——行与 usage 事实保留，审计可追溯。settled 行核销拒绝（已有 usage 事实）。
   */
  async writeOffUnknown(requestKey: string, programId: string, note: string): Promise<void> {
    const record = await this.deps.repository.getUsageRecord(requestKey);
    if (!record)
      throw Object.assign(new Error(`usage reservation 不存在: ${requestKey}`), {
        kind: "not_found",
      });
    if (record.state !== "unknown")
      throw Object.assign(new Error(`usage 行不是 unknown，不能核销: ${requestKey}`), {
        kind: "not_unknown",
      });
    const now = this.deps.clock.now();
    await this.deps.repository.settleUsageRecord({
      requestKey,
      actualTokens: 0,
      estimatedCostMicros: 0,
      usage: { writtenOff: true, note },
      updatedAt: now,
    });
    await this.deps.repository.appendEvent({
      programId,
      cycleId: record.cycleId,
      eventKey: `usage_write_off:${requestKey}`,
      type: "continuous.usage.write_off",
      payload: { requestKey, note, reservedCostMicros: record.reservedCostMicros },
      createdAt: now,
    });
  }

  /** 账本读面（snapshot/继续确认的 observedUsage 事实来源）。 */
  async summarize(query: {
    programId: string;
    cycleId?: string;
    windowFromMs?: number;
    windowToMs?: number;
  }): Promise<UsageLedgerSummary> {
    return this.deps.repository.summarizeUsage(query);
  }

  /** 拒绝暂停确认需要的 Program/Cycle 上下文读面（supervisor 组装 AskUserQuestion 用）。 */
  async contextOf(cycleId: string): Promise<{ cycle: Cycle; program: Program } | null> {
    const cycle = await this.deps.repository.getCycle(cycleId);
    if (!cycle) return null;
    const program = await this.deps.repository.getProgram(cycle.programId);
    return program ? { cycle, program } : null;
  }
}
