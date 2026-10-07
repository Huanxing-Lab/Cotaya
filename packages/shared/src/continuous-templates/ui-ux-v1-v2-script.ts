// ui-ux-v1 模板 v2 脚本文本（冻结副本）：评审修复（候选授权接线）把模板升到 v3（骨架
// 在每个候选实施前经 continuous-authorize 取得写入许可）。版本化纪律要求内容变更必须
// 升 templateVersion 并保留旧条目——授权绑定 v2 hash 的既有 Program 按本副本继续 resolve
//（规格 §6「旧模板不可用则明确失败，不静默换脚本」的另一半：旧模板可用时不静默换脚本）。
// 本文件内容 = v2 原文（自 ui-ux-v1-script.ts 冻结，勿再修改）；v3 是现行条目。

// ui-ux-v1 模板脚本文本（CT-05；CT-11 修订为可信工具端口版 v2）。独立成文件是架构
// max-file-lines 400 上限的拆分结果，不是边界变化：注册表/解析器在 ./ui-ux-v1.ts，
// 脚本内容只经 CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT 一个名字暴露。脚本书写约束
//（拼接而非模板字面量、空数组用显式类型常量）见 ./ui-ux-v1.ts 文件头。
//
// v2（CT-11）安全边界：
//   - 测试执行/浏览器验证/Git diff/本地提交只经可信工具端口（world.run 的保留命令
//     continuous-test / continuous-browser / continuous-diff / continuous-commit）；
//     退出码、输出、文件/行数、commit hash 全部来自工具端口返回值，模型转述不算证据；
//   - 移除 world.run("git", add/commit) 直接路径——actor 无任意 Git 写能力；
//   - 验证不可用（缺隔离实现/缺浏览器端口）如实上报 unverified，不 done 不提交。

export const CONTINUOUS_TEMPLATE_UI_UX_V1_V2_SCRIPT = `
interface ReportEvidence {
  kind: string;
  detail: string;
}

interface CandidateFinding {
  itemKey: string;
  fingerprint: string;
  title: string;
  rationale: string;
  targetPaths: string[];
  impact: number;
  confidence: number;
  effort: number;
  risk: "low" | "medium" | "high";
  classification: "autonomous" | "needs_decision";
  evidence: ReportEvidence[];
}

interface DecisionOptionChoice {
  id: string;
  label: string;
  consequences: string;
}

interface DecisionFinding {
  itemKey: string;
  fingerprint: string;
  title: string;
  context: string;
  options: DecisionOptionChoice[];
  recommendation: string;
  relatedCandidateKeys: string[];
}

interface ObservationResult {
  candidates: CandidateFinding[];
  decisions: DecisionFinding[];
  notes: string;
}

interface ImplementationResult {
  candidateKey: string;
  notes: string;
}

interface ReviewVerdict {
  candidateKey: string;
  outcome: "passed" | "failed";
  findings: string[];
}

// 可信工具端口的 JSON 信封（工具端口是唯一事实源；模型只消费其返回值）。
interface TrustedTestResult {
  status: "ok" | "unavailable" | "refused";
  exitCode: number | null;
  argv: string[];
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  isolationKey: string;
  reason?: string;
  runId: string;
  epoch: number;
}

interface TrustedDiffResult {
  status: "ok" | "suspended" | "refused";
  changedFiles: string[];
  added: number;
  removed: number;
  cumulative: { files: number; changedLines: number };
  reason?: string;
  runId: string;
  epoch: number;
}

interface TrustedBrowserResult {
  status: "ok" | "refused";
  outcome: "passed" | "failed" | "unverified";
  assertions: ReportEvidence[];
  reason: string;
  runId: string;
  epoch: number;
}

interface TrustedCommitResult {
  status: "ok" | "refused" | "suspended";
  commit?: string;
  changedFiles?: string[];
  reason?: string;
  runId: string;
  epoch: number;
}

// 空数组字面量会推断为 never[]（schema 合成拒绝）；统一经显式类型的空常量上报。
const noPaths: string[] = [];
const noFiles: string[] = [];
const noCommits: string[] = [];
const noEvidence: ReportEvidence[] = [];

// ── 单轮上限（Host 经 run args 注入；缺省用产品默认值：3 项 / 10 文件 / 400 行）──
const maxImprovements = typeof args.maxImprovements === "number" && args.maxImprovements > 0
  ? Math.floor(args.maxImprovements)
  : 3;
const maxFiles = typeof args.maxFiles === "number" && args.maxFiles > 0
  ? Math.floor(args.maxFiles)
  : 10;
const maxChangedLines = typeof args.maxChangedLines === "number" && args.maxChangedLines > 0
  ? Math.floor(args.maxChangedLines)
  : 400;
const testCommandCount = typeof args.testCommandCount === "number" && args.testCommandCount > 0
  ? Math.floor(args.testCommandCount)
  : 1;
const goal = typeof args.goal === "string" && args.goal.length > 0 ? args.goal : "持续改进产品的 UI/UX";

function parseTrusted<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

phase("观察产品并列出候选改进");

const observer = agent("observer", {
  system:
    "你是只读的产品观察者。检视目标应用的界面代码与可用截图，找出 UI/UX、响应式、无障碍、视觉一致性的小改进候选。" +
    "禁止任何写入或命令执行。对每个候选给出证据（文件路径、行号、现象）。" +
    "涉及导航架构、重大信息结构、设计系统替换或破坏性流程的发现必须标为 needs_decision 并给出决策项，不能自行实施。",
});

const observation: ObservationResult = await observer.ask<ObservationResult>(
  "观察当前工作区，产出至多 6 个候选改进与需要用户决策的事项。goal: " + goal +
    "。targetPaths 必须是仓库相对路径。impact/confidence/effort 取 0-10/0-1/0-10。",
);

// 决策先于实施上报（运行中即持久化，阻塞只作用于相关候选）。
for (const decision of observation.decisions) {
  report({
    kind: "decision",
    itemKey: decision.itemKey,
    fingerprint: decision.fingerprint,
    title: decision.title,
    context: decision.context,
    options: decision.options,
    recommendation: decision.recommendation,
    classification: "blocking",
    blockingScope: { candidateKeys: decision.relatedCandidateKeys, paths: noPaths },
  });
}
for (const candidate of observation.candidates) {
  report({
    kind: "candidate",
    itemKey: candidate.itemKey,
    fingerprint: candidate.fingerprint,
    title: candidate.title,
    rationale: candidate.rationale,
    targetPaths: candidate.targetPaths,
    impact: candidate.impact,
    confidence: candidate.confidence,
    effort: candidate.effort,
    risk: candidate.risk,
    evidence: candidate.evidence,
  });
}

// 服务分类与依赖检查 + 有限选择：只自主实施 autonomous 候选，按 impact×confidence/effort
// 降序取前 maxImprovements 项（Host 侧 candidatePolicy 复核同一规则）。
const autonomous: CandidateFinding[] = [];
for (const candidate of observation.candidates) {
  if (candidate.classification === "autonomous") autonomous.push(candidate);
}
autonomous.sort(function (left: CandidateFinding, right: CandidateFinding): number {
  const effortL = left.effort <= 0 ? 0.01 : left.effort;
  const effortR = right.effort <= 0 ? 0.01 : right.effort;
  return (right.impact * right.confidence) / effortR - (left.impact * left.confidence) / effortL;
});
const selected: CandidateFinding[] = [];
for (const candidate of autonomous) {
  if (selected.length >= maxImprovements) break;
  selected.push(candidate);
}
log("候选 " + observation.candidates.length + " 个，自主实施 " + selected.length + " 个");

phase("逐项实施、验证并本地提交");

const builder = agent("builder", {
  system:
    "你是实施者。一次只实施一个给定的候选改进，只修改该候选的 targetPaths 内的文件。" +
    "禁止 push/merge/deploy/迁移/安装依赖；禁止自行执行测试或 git 命令（验证与提交由可信端口执行）。",
});
const reviewer = agent("reviewer", {
  system:
    "你是独立只读审查者。逐项审查改动 diff 是否符合候选意图、无越界修改、无测试削弱。" +
    "禁止写入与命令执行，只给出通过或不通过的结论与发现。",
});

let doneCount = 0;
let attemptedCount = 0;
const changedAll: string[] = [];
const commitsAll: string[] = [];
let cycleSuspended = false;

for (const candidate of selected) {
  if (cycleSuspended) {
    break;
  }
  const impl: ImplementationResult = await builder.ask<ImplementationResult>(
    "实施候选 " + candidate.title + "（itemKey " + candidate.itemKey + "）。rationale: " +
      candidate.rationale +
      "。只允许修改这些路径: " + candidate.targetPaths.join(", ") +
      "。完成后返回说明（改动清单由可信端口核对，不需要你转述）。",
  );

  // 实际改动事实：Git diff 由工具端口产生（changedFiles/cumulative 是可信值）。
  const diffRun = await world.run("continuous-diff", [candidate.itemKey]);
  const diff: TrustedDiffResult = parseTrusted<TrustedDiffResult>(diffRun.stdout);
  if (diff.status !== "ok") {
    // 达到单轮文件/行数上限：可信端口已触发同轮挂起（继续只增加本轮额度）。
    cycleSuspended = diff.status === "suspended";
    attemptedCount += 1;
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: "rejected",
      changedFiles: diff.changedFiles === undefined ? noFiles : diff.changedFiles,
      commits: noCommits,
      summary: "可信端口拒绝继续：" + (diff.reason ?? diff.status),
      reason: diff.reason ?? "trusted diff refused",
    });
    continue;
  }

  // 声明测试命令逐条经受控 argv 端口真实执行；退出码/输出是工具端口事实。
  let testsPassed = true;
  let testsRan = false;
  let testsUnavailable: string | undefined;
  let lastTest: TrustedTestResult | undefined;
  for (let index = 0; index < testCommandCount; index += 1) {
    const runResult = await world.run("continuous-test", [candidate.itemKey, String(index)]);
    const test: TrustedTestResult = parseTrusted<TrustedTestResult>(runResult.stdout);
    lastTest = test;
    if (test.status === "unavailable") {
      testsUnavailable = test.reason ?? "confined_execution_not_supported";
      testsPassed = false;
      break;
    }
    if (test.status === "refused") {
      testsUnavailable = test.reason ?? "test_command_not_declared";
      testsPassed = false;
      break;
    }
    testsRan = true;
    if (test.exitCode !== 0) testsPassed = false;
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":tests:" + index,
      candidateKey: candidate.itemKey,
      stage: "tests",
      outcome: test.exitCode === 0 ? "passed" : "failed",
      evidence: [
        {
          kind: "command",
          detail:
            "argv=" + test.argv.join(" ") + " exit=" + String(test.exitCode) +
            " isolation=" + test.isolationKey + " run=" + test.runId + " epoch=" + String(test.epoch),
        },
      ],
      ...(test.exitCode === 0
        ? {}
        : { reason: "exit " + String(test.exitCode) + ": " + test.stderrTail.slice(0, 400) }),
    });
  }
  if (!testsRan) {
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":tests",
      candidateKey: candidate.itemKey,
      stage: "tests",
      outcome: "unverified",
      evidence: noEvidence,
      reason: testsUnavailable ?? "tests did not run",
    });
  }

  // 浏览器验证（390/1280）：证据由工具端口产生；提供方缺席如实 unverified。
  const browserRun = await world.run("continuous-browser", [candidate.itemKey]);
  const browser: TrustedBrowserResult = parseTrusted<TrustedBrowserResult>(browserRun.stdout);
  report({
    kind: "validation",
    itemKey: candidate.itemKey + ":browser",
    candidateKey: candidate.itemKey,
    stage: "browser",
    outcome: browser.outcome,
    evidence: browser.assertions,
    reason: browser.reason,
  });

  // 独立 Review（只读 reviewer 会话的模型判断：否决面；不单独构成授权）。
  const review: ReviewVerdict = await reviewer.ask<ReviewVerdict>(
    "独立审查候选 " + candidate.itemKey + " 的实际改动（diff 相对检查点），验证意图符合、无越界、无测试削弱。",
  );
  report({
    kind: "validation",
    itemKey: candidate.itemKey + ":review",
    candidateKey: candidate.itemKey,
    stage: "review",
    outcome: review.outcome,
    evidence: [{ kind: "review", detail: review.findings.join("; ") || "no findings" }],
    ...(review.outcome === "passed" ? {} : { reason: review.findings.join("; ") || "review rejected" }),
  });

  attemptedCount += 1;
  const browserVerified = browser.outcome === "passed";
  const reviewPassed = review.outcome === "passed";

  if (!testsPassed || !browserVerified || !reviewPassed) {
    // 三验证未全过：不提交（done 只属于全过者）；unverified 明确记录验证不可用
    //（测试端口不可用，或浏览器证据不可用——两者都无法证明「已验证失败」）。
    const unverified =
      (!testsPassed && testsUnavailable !== undefined) || browser.outcome === "unverified";
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: unverified ? "unverified" : "rejected",
      changedFiles: diff.changedFiles,
      commits: noCommits,
      summary:
        "验证未通过，未提交：" +
        (testsPassed ? "" : "tests failed/unavailable; ") +
        browser.reason +
        (reviewPassed ? "" : " review failed"),
      reason: unverified ? testsUnavailable ?? "validation unavailable" : "validation failed",
    });
    continue;
  }

  // 可信本地提交：授权路径 + 三阶段证据门 + 工作区复查都在工具端口内完成。
  const commitRun = await world.run("continuous-commit", [
    candidate.itemKey,
    "continuous: " + candidate.title,
    JSON.stringify({ review: { outcome: review.outcome, findings: review.findings } }),
  ]);
  const commitResult: TrustedCommitResult = parseTrusted<TrustedCommitResult>(commitRun.stdout);
  if (commitResult.status !== "ok" || commitResult.commit === undefined) {
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: "unverified",
      changedFiles: diff.changedFiles,
      commits: noCommits,
      summary: "可信提交端口拒绝：" + (commitResult.reason ?? commitResult.status),
      reason: commitResult.reason ?? "trusted commit refused",
    });
    continue;
  }

  doneCount += 1;
  for (const path of diff.changedFiles) changedAll.push(path);
  commitsAll.push(commitResult.commit);
  report({
    kind: "candidate_result",
    itemKey: candidate.itemKey + ":result",
    candidateKey: candidate.itemKey,
    status: "done",
    changedFiles: diff.changedFiles,
    commits: [commitResult.commit],
    summary:
      "实施并通过测试/浏览器/独立 review，可信端口已本地提交 " + commitResult.commit +
      "（run " + commitResult.runId + " epoch " + String(commitResult.epoch) + "）",
  });
  void impl;
  void lastTest;
}

let outcome: "changes_verified" | "no_changes" | "partial" = "partial";
if (doneCount === 0) {
  outcome = selected.length === 0 ? "no_changes" : "partial";
} else if (doneCount === attemptedCount && !cycleSuspended) {
  outcome = "changes_verified";
}
const summary =
  outcome === "no_changes"
    ? "本轮未发现可自主实施的改进（候选 " + observation.candidates.length + " 个均不可自主实施）"
    : "完成 " + doneCount + "/" + attemptedCount + " 项验证提交，提交 " + commitsAll.length + " 个" +
      (cycleSuspended ? "（单轮变更量上限已触发同轮挂起）" : "");
report({
  kind: "cycle_result",
  itemKey: "cycle-result",
  outcome: outcome,
  changedFiles: changedAll,
  commits: commitsAll,
  evidence: [{ kind: "cycle", detail: summary }],
  summary: summary,
});
return { outcome: outcome, done: doneCount, attempted: attemptedCount, suspended: cycleSuspended };
`;
