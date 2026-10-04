// ============================================================
// Continuous Decision Adapter（CT-06，规格 §8）
// ============================================================
// 执行中发现需决策事项的专用适配器：actor 在 managed cycle 内发出 escalate 时，本适配器
//   1. 持久化 Decision（经注入的 sink 端口 → Host services 的 decisionService；E-05
//      「Decision 先持久化」——持久化失败则大声失败，不静默降级为等待人类）；
//   2. 撤销该候选的写入许可（grant holder 清空 activeCandidate——CT-02 纯执行策略在
//      activeCandidate 为空时对写入返回 candidate_inactive/scope_denied，本文件不复制
//      路径判定，只持有/撤销授权这一事实）；
//   3. 返回结构化 defer（不 await 人类输入）：骨架据此跳过该候选、继续其余工作。
//
// 与 services 端口的关系：**结构等价的本地镜像**而非 import（bootstrap 不依赖
// @zcode/services，同 CT-03 执行适配器/CT-04 预算闸门的论证）；Host 装配（CT-07/08）负责
// 把 sink 落到 Host 侧 decisionService.recordEscalationDecision。
//
// defer 的载体：现有 WorkflowEscalateOutcome 只有 answered/refused 两支（contracts 词表），
// 拒绝支的 reason 枚举（budget_exhausted/no_active_ask）语义不符。选择 answered + 稳定前缀
// 的结构化文案：模型只读 message（core handler 原样透传），机器侧用 DEFERRED_TO_HUMAN_DECISION
// 前缀 + key=value 字段判别——不给 @zcode/contracts 的共享词表加值（低 diff），也不把
// 「没人回答」伪装成 refusal 文案。qid 用 ctdef- 前缀与 driver 铸造的 dwfq- 区分。
//
// 普通 Workflow 的 escalation 不变：本适配器只经 run service 的 wrapEscalatePort 可选接缝
// 进入（缺席/未登记的 run 逐字不变，见 dynamic-workflow-run-launch.ts）。

import { createHash } from "node:crypto";
import type { EscalateQuestionRequest, Logger, WorkflowEscalatePort } from "@zcode/contracts";
import type { TraceId } from "@zcode/contracts";

// ── sink 端口（Host services decisionService.recordEscalationDecision 的结构镜像）──

/** 决策选项（与 services 侧 DecisionOption 对齐）。 */
export interface ContinuousDecisionOptionMirror {
  id: string;
  label: string;
  consequences: string;
}

export interface ContinuousDecisionRecordInput {
  programId: string;
  cycleId: string;
  /** 稳定去重键：同问题重复 escalate 跨 ask/跨 Cycle 合并来源（fingerprint 语义）。 */
  fingerprint: string;
  title: string;
  context: string;
  options: ContinuousDecisionOptionMirror[];
  recommendation?: string;
  classification: "deferred" | "blocking";
  blockingScope?: { candidateIds: string[]; paths: string[]; capability?: string };
  evidence?: unknown[];
}

export interface ContinuousDecisionSink {
  /** 持久化（或合并进）Decision Queue；失败必须 reject——调用方不静默吞掉。 */
  persist(input: ContinuousDecisionRecordInput): Promise<{
    decisionId: string;
    fingerprint: string;
    status: "pending" | "resolved" | "dismissed";
    merged: boolean;
  }>;
}

// ── 候选写入许可 holder（与 CT-02 纯执行策略组合）────────────────

export interface ContinuousCandidateGrant {
  candidateId: string;
  /** 候选授权路径（executionPath 相对）；必须是 Host 侧 Candidate 行 id 空间。 */
  targetPaths: string[];
}

export interface ContinuousCandidateGrantHolder {
  /**
   * builder 一次一个候选（authorizeContinuousBuilderCandidate 同语义）：不同候选在占用期
   * 拒绝（candidate_busy）；被撤销的候选在本 holder 生命周期内不得再授权（defer 是终局，
   * 骨架必须跳过，重试同一候选属于违反 §8 的投机）。
   */
  authorize(input: ContinuousCandidateGrant): { ok: true } | { ok: false; reason: string };
  /** 撤销当前授权候选（决策 defer 时调用）；无授权候选时返回 null。 */
  revokeActive(reason: string): ContinuousCandidateGrant | null;
  /** 当前授权（policy config 的 activeCandidate 来源；撤销后为 null → 写入 candidate_inactive）。 */
  activeGrant(): ContinuousCandidateGrant | null;
  isRevoked(candidateId: string): boolean;
}

/**
 * 候选写入许可的唯一 holder（CLI 进程内）：撤销不是删除记录，而是清空 active 授权并
 * 把 candidateId 记入撤销集——后续 checkContinuousFilePath 以 activeCandidate=null 拒绝
 * 写入（candidate_inactive），策略函数归 CT-02，本 holder 只管授权事实的所有权。
 */
export function createContinuousCandidateGrantHolder(): ContinuousCandidateGrantHolder {
  let active: ContinuousCandidateGrant | null = null;
  const revoked = new Set<string>();
  return {
    authorize(input) {
      if (revoked.has(input.candidateId)) {
        return { ok: false, reason: "candidate_revoked" };
      }
      if (active !== null && active.candidateId !== input.candidateId) {
        return { ok: false, reason: "candidate_busy" };
      }
      active = { candidateId: input.candidateId, targetPaths: [...input.targetPaths] };
      return { ok: true };
    },
    revokeActive(reason) {
      void reason; // 撤销原因记入决策侧事件；holder 只需要撤销事实
      const revokedGrant = active;
      if (revokedGrant === null) return null;
      active = null;
      revoked.add(revokedGrant.candidateId);
      return revokedGrant;
    },
    activeGrant() {
      return active === null ? null : { ...active };
    },
    isRevoked(candidateId) {
      return revoked.has(candidateId);
    },
  };
}

// ── 决策闸门 ───────────────────────────────────────────────────

export interface ContinuousDecisionGateDeps {
  programId: string;
  cycleId: string;
  sink: ContinuousDecisionSink;
  /** 候选写入许可 holder（与执行策略共享同一实例才有撤销效力）。 */
  grants: ContinuousCandidateGrantHolder;
  logger?: Logger;
}

/** escalate 问题的标准决策选项：问题的答案由人类给出，选项是「放行/跳过」的授权面。 */
export function standardDecisionOptions(): ContinuousDecisionOptionMirror[] {
  return [
    {
      id: "approve",
      label: "按提议放行",
      consequences: "相关候选在未来 Cycle 按现仓库、Scope 与预算重新核对后实施",
    },
    {
      id: "skip",
      label: "跳过该改进",
      consequences: "相关候选不获得实施许可",
    },
  ];
}

/** 结构化 defer 文案（模型可执行指令 + 机器可判别字段）。 */
export function decisionDeferMessage(defer: {
  decisionId: string;
  fingerprint: string;
  candidateId?: string;
  paths: string[];
}): string {
  const fields = [
    `decisionId=${defer.decisionId}`,
    `fingerprint=${defer.fingerprint}`,
    defer.candidateId === undefined ? "candidateId=none" : `candidateId=${defer.candidateId}`,
    `paths=${defer.paths.length === 0 ? "none" : defer.paths.join(",")}`,
  ].join(" ");
  return (
    `DEFERRED_TO_HUMAN_DECISION ${fields}\n` +
    "此问题需要用户决策，已持久化进 Decision Queue，不会有人在本轮回答。\n" +
    (defer.candidateId === undefined
      ? "当前没有被授权的候选。"
      : `候选 ${defer.candidateId} 的写入许可已撤销，后续写入将被拒绝。`) +
    "不要等待回答、不要重试该候选：按候选边界收尾，跳过它并继续其余可独立完成的工作。"
  );
}

export interface ContinuousDecisionGate {
  /**
   * 包装 actor 的 escalate 端口（run service 经 wrapEscalatePort 接缝下传）。
   * 被包装端口**不被调用**：managed cycle 的 escalate 从不停驻给主代理/人类——这是
   * 本适配器的全部意义（§8「不 await 人类输入」）；接缝保留原端口入参只为可组合。
   */
  wrap(escalatePort: WorkflowEscalatePort): WorkflowEscalatePort;
  /** 依赖注入回显（测试/Host 装配断言用）。 */
  readonly grants: ContinuousCandidateGrantHolder;
}

export function createContinuousDecisionGate(
  deps: ContinuousDecisionGateDeps,
): ContinuousDecisionGate {
  const fingerprintOf = (question: string): string =>
    createHash("sha256").update(`continuous-decision:${question}`, "utf8").digest("hex");
  const deferQidOf = (fingerprint: string): string => `ctdef-${fingerprint.slice(0, 16)}`;

  return {
    grants: deps.grants,
    wrap(_escalatePort: WorkflowEscalatePort): WorkflowEscalatePort {
      return {
        escalate: async (request: EscalateQuestionRequest) => {
          // 顺序即语义（E-05「Decision 先持久化」）：先持久化再撤销许可——持久化失败大声
          // 失败（既不悄悄放行，也不把 actor 挂在一个无人回答的问题上），且此时许可未动，
          // 修复/重试路径可原样重新 escalate。
          const fingerprint = fingerprintOf(request.question);
          const activeAtEscalation = deps.grants.activeGrant();
          const stored = await deps.sink.persist({
            programId: deps.programId,
            cycleId: deps.cycleId,
            fingerprint,
            title: request.question,
            context: request.context ?? request.question,
            options: standardDecisionOptions(),
            recommendation: "skip",
            classification: "blocking",
            blockingScope: {
              candidateIds: activeAtEscalation === null ? [] : [activeAtEscalation.candidateId],
              paths: activeAtEscalation === null ? [] : [...activeAtEscalation.targetPaths],
            },
            evidence: [
              { kind: "escalation", detail: request.question },
              ...(request.context === undefined
                ? []
                : [{ kind: "context", detail: request.context }]),
            ],
          });
          const revokedGrant = deps.grants.revokeActive(
            `deferred to decision ${fingerprint.slice(0, 16)}`,
          );
          deps.logger?.info?.("Continuous decision deferred from escalation", {
            event: "continuous.decision.deferred",
            module: "bootstrap.app",
            programId: deps.programId,
            cycleId: deps.cycleId,
            decisionId: stored.decisionId,
            fingerprint: stored.fingerprint,
            merged: stored.merged,
            decisionStatus: stored.status,
            candidateId: revokedGrant?.candidateId ?? null,
            traceId: request.trace?.traceId as TraceId | undefined,
          });
          // 结构化 defer：不 await 人类；actor 收到普通工具结果后跳过该候选。
          return {
            kind: "answered",
            qid: deferQidOf(stored.fingerprint),
            answer: decisionDeferMessage({
              decisionId: stored.decisionId,
              fingerprint: stored.fingerprint,
              ...(revokedGrant === null ? {} : { candidateId: revokedGrant.candidateId }),
              paths: revokedGrant === null ? [] : [...revokedGrant.targetPaths],
            }),
          };
        },
      };
    },
  };
}
