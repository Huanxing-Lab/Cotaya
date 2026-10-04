// ui-ux-v1 模板脚本文本（CT-05）。独立成文件是架构 max-file-lines 400 上限的拆分结果，
// 不是边界变化：注册表/解析器在 ./ui-ux-v1.ts，脚本内容只经 CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT
// 一个名字暴露。脚本书写约束（拼接而非模板字面量、空数组用显式类型常量）见 ./ui-ux-v1.ts 文件头。

export const CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT = `
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
  changedFiles: string[];
  notes: string;
}

interface TestRunEvidence {
  candidateKey: string;
  argv: string[];
  exitCode: number;
  outputTail: string;
}

interface BrowserCheckResult {
  candidateKey: string;
  outcome: "passed" | "failed" | "unverified";
  assertions: ReportEvidence[];
  reason: string;
}

interface ReviewVerdict {
  candidateKey: string;
  outcome: "passed" | "failed";
  findings: string[];
}

// 空数组字面量会推断为 never[]（schema 合成拒绝）；统一经显式类型的空常量上报。
const noPaths: string[] = [];
const noFiles: string[] = [];
const noCommits: string[] = [];

// ── 单轮上限（Host 经 run args 注入；缺省用产品默认值：3 项 / 10 文件）──
const maxImprovements = typeof args.maxImprovements === "number" && args.maxImprovements > 0
  ? Math.floor(args.maxImprovements)
  : 3;
const maxFiles = typeof args.maxFiles === "number" && args.maxFiles > 0
  ? Math.floor(args.maxFiles)
  : 10;
const goal = typeof args.goal === "string" && args.goal.length > 0 ? args.goal : "持续改进产品的 UI/UX";

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
    "禁止 push/merge/deploy/迁移/安装依赖；测试命令按声明执行并如实回报退出码。",
});
const reviewer = agent("reviewer", {
  system:
    "你是独立只读审查者。逐项审查改动 diff 是否符合候选意图、无越界修改、无测试削弱。" +
    "禁止写入与命令执行，只给出通过或不通过的结论与发现。",
});

let fileBudget = maxFiles;
let doneCount = 0;
let attemptedCount = 0;
const changedAll: string[] = [];
const commitsAll: string[] = [];

for (const candidate of selected) {
  if (fileBudget <= 0) {
    attemptedCount += 1;
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: "rejected",
      changedFiles: noFiles,
      commits: noCommits,
      summary: "单轮文件上限已满，未实施",
      reason: "per-cycle file budget exhausted",
    });
    continue;
  }

  const impl: ImplementationResult = await builder.ask<ImplementationResult>(
    "实施候选 " + candidate.title + "（itemKey " + candidate.itemKey + "）。rationale: " +
      candidate.rationale +
      "。只允许修改这些路径: " + candidate.targetPaths.join(", ") +
      "。完成后返回实际修改的文件列表与说明。",
  );

  const tests: TestRunEvidence = await builder.ask<TestRunEvidence>(
    "为候选 " + candidate.itemKey + " 运行声明的测试命令（完整 argv），如实返回退出码与输出尾部。" +
      "没有可用的测试命令时返回 exitCode 1 并在 outputTail 说明原因。",
  );

  const browser: BrowserCheckResult = await reviewer.ask<BrowserCheckResult>(
    "对候选 " + candidate.itemKey + " 做浏览器/视觉验证（目标页面 390 与 1280 宽度）。" +
      "浏览器不可用时返回 unverified 并说明原因；禁止只凭代码阅读声称通过。",
  );

  const review: ReviewVerdict = await reviewer.ask<ReviewVerdict>(
    "独立审查候选 " + candidate.itemKey + " 的实际改动（diff 相对检查点），验证意图符合、无越界、无测试削弱。",
  );

  const testsPassed = tests.exitCode === 0;
  const browserVerified = browser.outcome === "passed";
  const reviewPassed = review.outcome === "passed";
  attemptedCount += 1;

  if (testsPassed) {
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":tests",
      candidateKey: candidate.itemKey,
      stage: "tests",
      outcome: "passed",
      evidence: [
        { kind: "command", detail: "argv=" + tests.argv.join(" ") + " exit=0" },
      ],
    });
  } else {
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":tests",
      candidateKey: candidate.itemKey,
      stage: "tests",
      outcome: "failed",
      evidence: [
        { kind: "command", detail: "argv=" + tests.argv.join(" ") + " exit=" + tests.exitCode },
      ],
      reason: "exit code " + tests.exitCode + ": " + tests.outputTail,
    });
  }
  report({
    kind: "validation",
    itemKey: candidate.itemKey + ":browser",
    candidateKey: candidate.itemKey,
    stage: "browser",
    outcome: browser.outcome,
    evidence: browser.assertions,
    reason: browser.reason,
  });
  if (reviewPassed) {
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":review",
      candidateKey: candidate.itemKey,
      stage: "review",
      outcome: "passed",
      evidence: [
        { kind: "review", detail: review.findings.join("; ") || "no findings" },
      ],
    });
  } else {
    report({
      kind: "validation",
      itemKey: candidate.itemKey + ":review",
      candidateKey: candidate.itemKey,
      stage: "review",
      outcome: "failed",
      evidence: [
        { kind: "review", detail: review.findings.join("; ") || "no findings" },
      ],
      reason: review.findings.join("; ") || "review rejected",
    });
  }

  if (!testsPassed || !browserVerified || !reviewPassed) {
    // 三验证未全过：不提交（done 只属于全过者）；unverified 明确记录验证不可用。
    const unverified = !browserVerified && browser.outcome === "unverified";
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: unverified ? "unverified" : "rejected",
      changedFiles: impl.changedFiles,
      commits: noCommits,
      summary: "验证未通过，未提交：" + (testsPassed ? "" : "tests failed; ") + browser.reason + (reviewPassed ? "" : " review failed"),
      reason: unverified ? browser.reason : "validation failed",
    });
    continue;
  }

  const addResult = await world.run("git", ["add"].concat(impl.changedFiles));
  if (addResult.exitCode !== 0) {
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: "unverified",
      changedFiles: impl.changedFiles,
      commits: noCommits,
      summary: "git add 失败，未提交",
      reason: "git add exit " + addResult.exitCode,
    });
    continue;
  }
  const commitResult = await world.run("git", ["commit", "-m", "continuous: " + candidate.title]);
  if (commitResult.exitCode !== 0) {
    report({
      kind: "candidate_result",
      itemKey: candidate.itemKey + ":result",
      candidateKey: candidate.itemKey,
      status: "unverified",
      changedFiles: impl.changedFiles,
      commits: noCommits,
      summary: "本地提交失败，未完成",
      reason: "git commit exit " + commitResult.exitCode,
    });
    continue;
  }
  const history = await git.log(2);
  const commitHash = history.length > 0 ? history[0].hash : "";

  doneCount += 1;
  fileBudget -= impl.changedFiles.length;
  for (const path of impl.changedFiles) changedAll.push(path);
  if (commitHash.length > 0) commitsAll.push(commitHash);
  report({
    kind: "candidate_result",
    itemKey: candidate.itemKey + ":result",
    candidateKey: candidate.itemKey,
    status: "done",
    changedFiles: impl.changedFiles,
    commits: commitHash.length > 0 ? [commitHash] : [],
    summary: "实施并通过测试/浏览器/独立 review，已本地提交 " + commitHash,
  });
}

let outcome: "changes_verified" | "no_changes" | "partial" = "partial";
if (doneCount === 0) {
  outcome = selected.length === 0 ? "no_changes" : "partial";
} else if (doneCount === attemptedCount) {
  outcome = "changes_verified";
}
const summary =
  outcome === "no_changes"
    ? "本轮未发现可自主实施的改进（候选 " + observation.candidates.length + " 个均不可自主实施）"
    : "完成 " + doneCount + "/" + attemptedCount + " 项验证提交，提交 " + commitsAll.length + " 个";
// 最终报告（artifact 存储缺席时内容成员会拒绝——v1 的交付面统一走 report()，
// artifact 交付留给 Host 装配了 store 的环境，模板不因缺 store 而失败）。
report({
  kind: "cycle_result",
  itemKey: "cycle-result",
  outcome: outcome,
  changedFiles: changedAll,
  commits: commitsAll,
  evidence: [{ kind: "cycle", detail: summary }],
  summary: summary,
});
return { outcome: outcome, done: doneCount, attempted: attemptedCount };
`;
