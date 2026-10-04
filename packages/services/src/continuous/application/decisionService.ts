// Continuous 决策服务（CT-06）：Decision Queue 的唯一 resolve/dismiss 写入者与
// 执行中决策的持久化入口。规则来源：docs/specs/continuous.md §8。
//
// 事件顺序（唯一所有者链）：
//   执行中发现（bootstrap 决策适配器经 sink 端口）→ recordEscalationDecision：
//     fingerprint 去重——已存在则合并来源/证据（mergeDecisionOnRediscovery），终态不重开；
//   用户回答 → resolve/dismiss：version 乐观校验（planDecisionResolution——同 version 同答案
//     重放幂等 no-op、旧 version/异答拒绝）；resolution 与入队事件（decision.resolved /
//     decision.dismissed / decision.candidates_requeued）经 applyDecisionResolution 单事务落库；
//     dismiss 的关联未终态候选同事务 rejected（不授权实施）；resolve 不动当前执行计划——
//     关联候选在**未来** Cycle 的选择期按现仓库、Scope、预算重新核对（candidatePolicy）。
//
// 本服务不改变 Program 状态（decisionBlocksProgram 恒 false，§8「pending Decision 不默认
// 阻止当前 Cycle」），不扩大 forbidden（用户回答≠Scope 变更）。

import type { Decision, DecisionResolution } from "../domain/types.js";
import { planDecisionResolution } from "../domain/decisionPolicy.js";
import { continuousDecisionRowId } from "./continuousIds.js";
import type { ContinuousClockPort, ContinuousRepositoryPort } from "./ports.js";

/** resolve/dismiss 的结构化冲突（调用方按 kind 分流；code 与 continuationService 同词表）。 */
export class DecisionVersionConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor(decisionId: string, currentVersion: number, presentedVersion: number) {
    super(
      `decision ${decisionId} version conflict: current ${currentVersion}, presented ${presentedVersion}`,
    );
    this.name = "DecisionVersionConflictError";
  }
}

export interface ContinuousDecisionServiceDeps {
  repository: ContinuousRepositoryPort;
  clock: Pick<ContinuousClockPort, "now">;
}

/** 回答结果：applied = 本次落库；idempotent = 同回答重复提交（no-op，返回现行决策）。 */
export interface DecisionAnswerResult {
  status: "applied" | "idempotent";
  decision: Decision;
  /** dismiss 实际落为 rejected 的关联候选（resolve 恒空）。 */
  rejectedCandidateIds: string[];
}

/** 执行中决策的持久化输入（bootstrap 决策适配器经 sink 端口上送；字段镜像 Host 决策行）。 */
export interface EscalationDecisionInput {
  programId: string;
  cycleId: string;
  fingerprint: string;
  title: string;
  context: string;
  options: Decision["options"];
  recommendation?: string;
  classification: "deferred" | "blocking";
  blockingScope?: Decision["blockingScope"];
  evidence?: unknown[];
}

/** 决策行 id：唯一派生见 domain/decisionPolicy 的 continuousDecisionRowId。 */
const decisionIdOf = continuousDecisionRowId;

export class ContinuousDecisionService {
  constructor(private readonly deps: ContinuousDecisionServiceDeps) {}

  async getDecision(decisionId: string): Promise<Decision | null> {
    return this.deps.repository.getDecision(decisionId);
  }

  async listPending(programId: string): Promise<Decision[]> {
    return this.deps.repository.listPendingDecisions(programId);
  }

  /**
   * 执行中发现的决策持久化（§8「执行中发现需决策事项：专用适配器持久化 Decision」）。
   * fingerprint 命中已有行时合并（来源追加、终态不重开），否则插入 pending 行。
   * 返回落库后的现行决策与是否发生了合并（审计/测试用）。
   */
  async recordEscalationDecision(input: EscalationDecisionInput): Promise<{
    decision: Decision;
    merged: boolean;
  }> {
    // id 由 fingerprint 确定派生：getDecision 一次命中全状态（pending 与已 resolved/dismissed），
    // 合并语义对终态行同样生效（终态不重开）。
    const current = await this.deps.repository.getDecision(decisionIdOf(input.fingerprint));
    if (current !== null && current.programId !== input.programId) {
      // 行 id 不含 program 维度：不同 Program 碰巧同 fingerprint（同问题文本）会派生同 id。
      // 不静默跨 Program 合并（合并会改写他 Program 的行）——大声失败，与复合 FK 同语义。
      throw Object.assign(
        new Error(
          `决策 fingerprint 已被 program ${current.programId} 占用: ${input.fingerprint.slice(0, 16)}…`,
        ),
        { kind: "program_mismatch" },
      );
    }
    const now = this.deps.clock.now();
    const incoming: Decision = {
      id: decisionIdOf(input.fingerprint),
      programId: input.programId,
      sourceCycleId: input.cycleId,
      fingerprint: input.fingerprint,
      version: current?.version ?? 1,
      title: input.title,
      context: input.context,
      options: input.options,
      ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
      classification: input.classification,
      blockingScope: input.blockingScope,
      status: "pending",
      sources: [
        {
          cycleId: input.cycleId,
          discoveredAt: now,
          ...(input.context === undefined ? {} : { context: input.context }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        },
      ],
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.repository.saveDecision(incoming);
    const stored = await this.deps.repository.getDecision(incoming.id);
    return { decision: stored ?? incoming, merged: current !== null };
  }

  /**
   * 回答决策（§8：version 防覆盖；resolution 与入队事件同事务；只影响未来 Cycle）。
   * 同 version 同答案的重复提交幂等 no-op；旧 version / 异答抛 version_conflict。
   */
  async resolveDecision(input: {
    programId: string;
    decisionId: string;
    version: number;
    optionId?: string;
    text?: string;
  }): Promise<DecisionAnswerResult> {
    return this.answer({
      programId: input.programId,
      decisionId: input.decisionId,
      kind: "resolve",
      version: input.version,
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      ...(input.text === undefined ? {} : { text: input.text }),
    });
  }

  /** 不授权实施（§8）：关联未终态候选同事务 rejected；不自动扩大 forbidden。 */
  async dismissDecision(input: {
    programId: string;
    decisionId: string;
    version: number;
  }): Promise<DecisionAnswerResult> {
    return this.answer({
      programId: input.programId,
      decisionId: input.decisionId,
      kind: "dismiss",
      version: input.version,
    });
  }

  private async answer(input: {
    programId: string;
    decisionId: string;
    kind: "resolve" | "dismiss";
    version: number;
    optionId?: string;
    text?: string;
  }): Promise<DecisionAnswerResult> {
    const decision = await this.deps.repository.getDecision(input.decisionId);
    if (!decision) {
      throw Object.assign(new Error(`decision 不存在: ${input.decisionId}`), {
        kind: "not_found",
      });
    }
    if (decision.programId !== input.programId) {
      // 归属校验先于任何写入：跨 Program 回答拒绝（复合 FK 同语义）。
      throw Object.assign(
        new Error(`decision ${input.decisionId} 不属于 program ${input.programId}`),
        { kind: "program_mismatch" },
      );
    }
    const plan = planDecisionResolution(decision, {
      kind: input.kind,
      version: input.version,
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    if (plan.plan === "idempotent") {
      return { status: "idempotent", decision, rejectedCandidateIds: [] };
    }
    if (plan.plan === "version_conflict") {
      throw new DecisionVersionConflictError(input.decisionId, plan.currentVersion, input.version);
    }
    if (plan.plan === "invalid_option") {
      throw Object.assign(
        new Error(`option 不在该决策的选项表内: ${input.optionId}（${input.decisionId}）`),
        { kind: "invalid_option" },
      );
    }

    const now = this.deps.clock.now();
    const resolution: DecisionResolution =
      input.kind === "dismiss"
        ? { resolvedAt: now }
        : {
            ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
            ...(input.text === undefined ? {} : { text: input.text }),
            resolvedAt: now,
          };
    const next: Decision = {
      ...decision,
      status: input.kind === "resolve" ? "resolved" : "dismissed",
      resolution,
      version: decision.version + 1,
      updatedAt: now,
    };

    // 入队事件与 resolution 同事务（applyDecisionResolution 内单事务）：
    //   - 回答事实（decision.resolved / decision.dismissed，payload 附关联候选清单）；
    //   - resolve 的关联候选重新入队记录（下一轮选择期重新核对，不是插入当前执行计划）。
    // dismiss 实际落 rejected 的行集由事务内守卫决定并以返回值交代（rejectedCandidateIds）。
    const links = await this.deps.repository.listDecisionCandidateLinks(decision.id);
    const linkedCandidateIds = links.map((link) => link.candidateId);
    const events = [
      {
        programId: decision.programId,
        cycleId: decision.sourceCycleId,
        eventKey: `decision-${input.kind}:${decision.id}:${next.version}`,
        type: input.kind === "resolve" ? "decision.resolved" : "decision.dismissed",
        payload: {
          decisionId: decision.id,
          fingerprint: decision.fingerprint,
          version: next.version,
          ...(input.kind === "resolve"
            ? { optionId: input.optionId, text: input.text }
            : { dismissed: true, linkedCandidateIds }),
        },
        createdAt: now,
      },
      ...(input.kind === "resolve" && linkedCandidateIds.length > 0
        ? [
            {
              programId: decision.programId,
              cycleId: decision.sourceCycleId,
              eventKey: `decision-candidates-requeued:${decision.id}:${next.version}`,
              type: "decision.candidates_requeued",
              payload: {
                decisionId: decision.id,
                candidateIds: linkedCandidateIds,
                note: "未来 Cycle 按现仓库、Scope 与预算重新核对（不插入当前执行计划）",
              },
              createdAt: now,
            },
          ]
        : []),
    ];
    const applied = await this.deps.repository.applyDecisionResolution({
      programId: decision.programId,
      decision: next,
      events,
      candidateDisposition: input.kind === "resolve" ? "requeue_future_cycles" : "reject_blocked",
    });
    return {
      status: "applied",
      decision: next,
      rejectedCandidateIds: applied.rejectedCandidateIds,
    };
  }
}
