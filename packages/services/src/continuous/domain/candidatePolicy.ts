// Continuous 候选选择策略（CT-05，规格 §7/§8）：有限候选选择的纯产品规则。
//
// 规则来源：docs/specs/continuous.md §7（固定骨架「选择最多3项自主候选」）与 §8（选择时
// 过滤 forbidden、依赖 pending Decision 及与 blockingScope 重叠的候选；其余照常排序实施）。
// 本文件是 Host 侧的权威规则：固定模板在 Run 内做**操作性挑选**（编排需要），Host 在
// 结算/入队时用本规则复核——两侧词表一致（autonomous/deferred 的语义以这里为准）。
//
// 纯函数：不做 IO、不读时钟；输入由调用方（supervisor/reportIngestion）备好。

import type { Candidate, Decision } from "./types.js";
import { decisionBlocksCandidate } from "./decisionPolicy.js";
import type { ContinuousScopePolicy } from "@zcode/shared";

/** 参与选择的候选最小面（报告导入后的队列行即满足）。 */
export type SelectableCandidate = Pick<
  Candidate,
  "id" | "fingerprint" | "targetPaths" | "impact" | "confidence" | "effort"
>;

/** pending Decision 的最小面（只看 blockingScope）。 */
export type BlockingDecision = Pick<Decision, "id" | "blockingScope">;

/** 候选被排除/推迟的稳定原因（审计事件与选择理由的词汇表）。 */
export type CandidateExclusionReason =
  | "forbidden_path"
  | "outside_allowed_paths"
  | "blocked_by_pending_decision";

export interface CandidateSelectionEntry {
  candidate: SelectableCandidate;
  score: number;
  rank: number;
}

export interface CandidateDeferralEntry {
  candidate: SelectableCandidate;
  reason: CandidateExclusionReason;
  /** blocked_by_pending_decision 时的关联 Decision id 列表。 */
  decisionIds: string[];
}

export interface CandidateSelection {
  selected: CandidateSelectionEntry[];
  deferred: CandidateDeferralEntry[];
  /** 选择理由（规格 §7「保存选择理由」）：排序依据 + 过滤统计的一段稳定文本。 */
  rationale: string;
}

export interface CandidateSelectionInput {
  candidates: SelectableCandidate[];
  scope: Pick<ContinuousScopePolicy, "allowedPaths" | "forbiddenPaths">;
  pendingDecisions: BlockingDecision[];
  /** 单轮最多实施项数（Program 预算 perCycleMaxImprovements，默认 3 见 shared 默认值）。 */
  maxImprovements: number;
}

/** 前缀包含（段边界）：child 等于 prefix 或以 prefix + "/" 开头；按段比较，不拼字符串。 */
function pathPrefixMatch(prefix: string, path: string): boolean {
  const normalized = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/");
  const prefixSegments = normalized.split("/").filter((segment) => segment.length > 0);
  if (prefixSegments.length === 0 || segments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => segment === segments[index]);
}

/** 候选是否落在任一前缀内（allowedPaths 放行 / forbiddenPaths 拒绝共用一个谓词）。 */
function underAnyPrefix(prefixes: readonly string[], targetPaths: readonly string[]): boolean {
  return targetPaths.some((path) => prefixes.some((prefix) => pathPrefixMatch(prefix, path)));
}

/**
 * 排序分：impact × confidence / effort（effort 为 0 时按极小值，避免除零放大）。
 * 只用于排序，不是展示事实；确定性并列时按 fingerprint 字典序稳定排序。
 */
export function candidateScore(candidate: SelectableCandidate): number {
  const effort = candidate.effort <= 0 ? 0.01 : candidate.effort;
  return (candidate.impact * candidate.confidence) / effort;
}

/**
 * 有限候选选择（§7/§8）：
 *   1. forbidden 路径命中的候选排除（Scope 禁止项不能通过“继续”绕过，也不能被选择实施）；
 *   2. 完全不在 allowedPaths 内的候选排除（Scope 外写入本就 scope_denied）；
 *   3. 与任一 pending Decision 的 blockingScope 重叠（candidateIds 或 paths）的候选**推迟**
 *      （不删除：resolution 后的未来 Cycle 重新核对，§8）；Decision 从不暂停 Program；
 *   4. 其余按分数降序取前 maxImprovements 项。
 * 落选的非推迟候选不进 deferred（它们只是本轮名额不够，下一轮照常参与）。
 */
export function selectCandidates(input: CandidateSelectionInput): CandidateSelection {
  const eligible: CandidateSelectionEntry[] = [];
  const deferred: CandidateDeferralEntry[] = [];

  for (const candidate of input.candidates) {
    if (underAnyPrefix(input.scope.forbiddenPaths, candidate.targetPaths)) {
      deferred.push({ candidate, reason: "forbidden_path", decisionIds: [] });
      continue;
    }
    if (!underAnyPrefix(input.scope.allowedPaths, candidate.targetPaths)) {
      deferred.push({ candidate, reason: "outside_allowed_paths", decisionIds: [] });
      continue;
    }
    // 局部阻塞判定复用 decisionPolicy.decisionBlocksCandidate（CT-06 起单一实现）。
    const blockingIds = input.pendingDecisions
      .filter((decision) => decisionBlocksCandidate(decision, candidate))
      .map((decision) => decision.id);
    if (blockingIds.length > 0) {
      deferred.push({ candidate, reason: "blocked_by_pending_decision", decisionIds: blockingIds });
      continue;
    }
    eligible.push({ candidate, score: candidateScore(candidate), rank: 0 });
  }

  eligible.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return left.candidate.fingerprint < right.candidate.fingerprint ? -1 : 1;
  });
  const selected = eligible.slice(0, Math.max(0, input.maxImprovements)).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  const rationale =
    `已选 ${selected.length}/${input.candidates.length}（上限 ${input.maxImprovements}，` +
    `排序 impact×confidence/effort）：${
      selected.map((entry) => `${entry.rank}.${entry.candidate.fingerprint}`).join("、") || "无"
    }；` +
    `推迟 ${deferred.length}：${
      deferred.map((entry) => `${entry.candidate.fingerprint}(${entry.reason})`).join("、") || "无"
    }`;

  return { selected, deferred, rationale };
}

// 局部阻塞判定（candidateIds/paths 命中；capability 刻意不单独阻塞——一个 capability 级
// 决策若默认覆盖整个 Program 的候选面，就违反 §8「pending Decision 不默认阻止当前 Cycle、
// blockingScope 不默认覆盖整个 UI 包」）自 CT-06 起唯一实现在 decisionPolicy.decisionBlocksCandidate；
// 本文件经 import 复用，不再保留第二份。
