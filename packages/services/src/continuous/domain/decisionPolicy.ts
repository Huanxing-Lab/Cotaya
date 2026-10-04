// Continuous 决策策略（CT-06，规格 §8）：Decision Queue 的纯产品规则。
//
// 规则来源：docs/specs/continuous.md §8（语义分类与操作能力双检查、模型分类不是授权、
// 未知类别默认进决策不扩大 allowed、fingerprint 去重合并来源证据、局部 blockingScope
// 不默认覆盖整个 UI 包、versioned resolve/dismiss、Dismiss 不授权实施）。
//
// 纯函数：不做 IO、不读时钟；输入由调用方（decisionService/reportIngestion/
// candidatePolicy）备好。candidatePolicy 的选择期过滤复用本文件的
// decisionBlocksCandidate——局部阻塞判定只有一个实现。
//

import type { Candidate, Decision, DecisionSourceRecord } from "./types.js";
import type { ContinuousScopePolicy } from "@zcode/shared";

/** 模型侧语义分类词表（观察报告里的 classification 字段）；v1 不接受关闭 unknown→Decision。 */
export const CONTINUOUS_MODEL_CLASSIFICATIONS = ["autonomous", "needs_decision"] as const;
export type ContinuousModelClassification = (typeof CONTINUOUS_MODEL_CLASSIFICATIONS)[number];

/** 分类结论：可自主实施 / 进入决策队列 / 排除（Scope 边界，决策不能授权）。 */
export type CandidateClassificationAction =
  | { action: "autonomous"; reason: "dual_check_passed" }
  | { action: "to_decision"; reason: "unknown_classification" | "declared_needs_decision" }
  | {
      action: "excluded";
      reason: "forbidden_path" | "outside_allowed_paths";
    };

/** 前缀包含（段边界）：child 等于 prefix 或以 prefix + "/" 开头；按段比较，不拼字符串。 */
function pathPrefixMatch(prefix: string, path: string): boolean {
  const normalized = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/");
  const prefixSegments = normalized.split("/").filter((segment) => segment.length > 0);
  if (prefixSegments.length === 0 || segments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => segment === segments[index]);
}

function underAnyPrefix(prefixes: readonly string[], targetPaths: readonly string[]): boolean {
  return targetPaths.some((path) => prefixes.some((prefix) => pathPrefixMatch(prefix, path)));
}

/**
 * 语义分类 + 操作能力**双检查**（§8「服务同时检查语义分类和操作能力；模型分类不是授权」）：
 *   1. 操作能力先行且独立于模型标签：forbidden 命中或完全不在 allowedPaths 内的候选排除——
 *      这两条是 Scope 边界，任何决策回答都不能授权（决策不扩大 allowed）；
 *   2. 语义标签不在词表内（未知类别）→ 进入决策：unknownToDecision 是 v1 锁定行为，
 *      未知不扩大 allowed（不因「模型没说不」而放行）；
 *   3. 标签 needs_decision → 进入决策；
 *   4. 标签 autonomous 且操作检查通过 → 可自主实施（双检查都过才算）。
 */
export function evaluateCandidateClassification(input: {
  declared: string;
  targetPaths: readonly string[];
  scope: Pick<ContinuousScopePolicy, "allowedPaths" | "forbiddenPaths">;
}): CandidateClassificationAction {
  if (underAnyPrefix(input.scope.forbiddenPaths, input.targetPaths)) {
    return { action: "excluded", reason: "forbidden_path" };
  }
  if (!underAnyPrefix(input.scope.allowedPaths, input.targetPaths)) {
    return { action: "excluded", reason: "outside_allowed_paths" };
  }
  if (!(CONTINUOUS_MODEL_CLASSIFICATIONS as readonly string[]).includes(input.declared)) {
    return { action: "to_decision", reason: "unknown_classification" };
  }
  if (input.declared === "needs_decision") {
    return { action: "to_decision", reason: "declared_needs_decision" };
  }
  return { action: "autonomous", reason: "dual_check_passed" };
}

/** 决策阻塞判定的候选最小面。 */
export type BlockableCandidate = Pick<Candidate, "id" | "targetPaths">;

/**
 * blockingScope 局部重叠判定（§8「不默认阻止当前 Cycle、不默认覆盖整个 UI 包」）：
 * candidateIds 命中或 paths 与候选路径段前缀重叠才阻塞；capability 刻意**不**单独触发——
 * capability 级决策（如「design system 替换须决策」）只有同时经 candidateIds/paths 显式
 * 点名候选才推迟它们，否则它会默认覆盖整个 Program 的候选面。空 scope 阻塞零个候选
 * （记录给人类看，不挡自主工作）。candidatePolicy 的选择期过滤复用本谓词。
 */
export function decisionBlocksCandidate(
  decision: Pick<Decision, "id" | "blockingScope">,
  candidate: BlockableCandidate,
): boolean {
  const scope = decision.blockingScope;
  if (scope === undefined) return false;
  if (scope.candidateIds.includes(candidate.id)) return true;
  return underAnyPrefix(scope.paths, candidate.targetPaths);
}

/** 来源合并的稳定键：同一 Cycle 的重复发现只保留一条来源记录（幂等）。 */
function sourceKey(source: DecisionSourceRecord): string {
  return source.cycleId;
}

/**
 * fingerprint 去重合并（§8「追加来源和证据」）：同一 Decision 的重复发现合并到一行——
 *   - 稳定身份保持首见值：id/title/context/options/recommendation/classification/
 *     sourceCycleId/createdAt（人类看到的决策面不随后续措辞漂移）；
 *   - 状态不可逆：status/resolution/version/resolvedAt 一律取现存值——resolved/dismissed
 *     不因重复发现重开，version 不回退（resolve 的乐观并发不被旧观察冲掉）；
 *   - sources 按 cycleId 去重追加（后来的 context 作为证据留在来源记录里）；
 *   - blockingScope 取并集（仍然局部：并集只含显式点名的候选/路径）；
 *   - updatedAt 取较大者（单调）。
 */
export function mergeDecisionOnRediscovery(existing: Decision, incoming: Decision): Decision {
  const sourcesByCycle = new Map<string, DecisionSourceRecord>();
  for (const source of existing.sources ?? []) sourcesByCycle.set(sourceKey(source), source);
  for (const source of incoming.sources ?? []) {
    const key = sourceKey(source);
    if (!sourcesByCycle.has(key)) sourcesByCycle.set(key, source);
  }
  const sources = [...sourcesByCycle.values()];
  const existingScope = existing.blockingScope;
  const incomingScope = incoming.blockingScope;
  const blockingScope =
    existingScope === undefined && incomingScope === undefined
      ? undefined
      : {
          candidateIds: [
            ...new Set([
              ...(existingScope?.candidateIds ?? []),
              ...(incomingScope?.candidateIds ?? []),
            ]),
          ],
          paths: [...new Set([...(existingScope?.paths ?? []), ...(incomingScope?.paths ?? [])])],
          ...(existingScope?.capability !== undefined
            ? { capability: existingScope.capability }
            : incomingScope?.capability !== undefined
              ? { capability: incomingScope.capability }
              : {}),
        };
  return {
    ...existing,
    ...(blockingScope === undefined ? {} : { blockingScope }),
    ...(sources.length === 0 ? {} : { sources }),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

/** resolve/dismiss 的输入面（version 防覆盖；optionId/text 至少一项由 wire schema 保证）。 */
export interface DecisionResolutionInput {
  kind: "resolve" | "dismiss";
  version: number;
  optionId?: string;
  text?: string;
}

/** 回答相同判定：kind 一致且（resolve 时）optionId/text 与已落库回答一致。 */
function sameAnswer(decision: Decision, input: DecisionResolutionInput): boolean {
  if (decision.status === "pending") return false;
  const kindOf = decision.status === "resolved" ? "resolve" : "dismiss";
  if (kindOf !== input.kind) return false;
  if (input.kind === "dismiss") return true;
  return (
    decision.resolution?.optionId === input.optionId && decision.resolution?.text === input.text
  );
}

/**
 * versioned resolve/dismiss 裁决（§8「Resolve 使用 version 防止覆盖其他回答」；
 * §6.1「重复回答/version 校验必须幂等」的决策侧同款）：
 *   - apply：pending 且 version 等于当前值 → 允许落库（version+1）；optionId 必须引用既有选项；
 *   - idempotent：已按**同一回答**结算且携带的是回答前的 version → 重复提交 no-op；
 *   - version_conflict：旧 version、或已按不同回答结算——防止覆盖其他回答；
 *   - invalid_option：resolve 的 optionId 不在该决策的选项表内。
 */
export type DecisionResolutionPlan =
  | { plan: "apply" }
  | { plan: "idempotent" }
  | { plan: "version_conflict"; currentVersion: number }
  | { plan: "invalid_option" };

export function planDecisionResolution(
  decision: Decision,
  input: DecisionResolutionInput,
): DecisionResolutionPlan {
  if (decision.status !== "pending") {
    if (sameAnswer(decision, input) && input.version === decision.version - 1) {
      return { plan: "idempotent" };
    }
    return { plan: "version_conflict", currentVersion: decision.version };
  }
  if (input.version !== decision.version) {
    return { plan: "version_conflict", currentVersion: decision.version };
  }
  if (
    input.kind === "resolve" &&
    input.optionId !== undefined &&
    !decision.options.some((option) => option.id === input.optionId)
  ) {
    return { plan: "invalid_option" };
  }
  return { plan: "apply" };
}
