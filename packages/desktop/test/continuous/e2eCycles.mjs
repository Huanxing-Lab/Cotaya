// CT-15 E2E 执行链用例（e2eCases.mjs 的行数拆分；E-01/E-02/E-15/E-16 合流链、E-08 预算
// 暂停、E-11 Pause/停止）。公共约定见 e2eCases.mjs 文件头。
//
// 产品语义前提（规格 §2「初次执行：创建并授权后到期立即执行一次」）：createProgram 后
// 首轮 Cycle 自动启动。因此每个用例都在创建前先布好 provider 脚本，断言全部按
// program_id 圈定（多 Program 共存于同一 workspace，全局计数会互相污染）。
// 资源暂停不释放 workspace 执行占用（§10）：保留 suspended 轮的用例（E-08）必须排在
// 其它同 workspace 用例之后执行。

import assert from "node:assert/strict";
import path from "node:path";
import { buildIsolationEnv } from "./runner.mjs";
import { launchDesktop, probeE2EBridge, waitForFirstWindow } from "./runnerElectron.mjs";
import { createCaseEvidence, sanitizeText } from "./evidence.mjs";
import {
  clickPause,
  clickResume,
  clickRunNow,
  clickStopCurrent,
  openContinuousTab,
  openProgramDetail,
  readProviderFacts,
  readWorktreeFacts,
  submitCreateForm,
  waitFor,
  waitForProgramCard,
} from "./continuousDriver.mjs";

/** 观察者 typed 结果：空候选（E-01/E-15 的 no_changes 路径）。 */
export function emptyObservationStep(barrier) {
  return {
    ...(barrier ? { barrier } : {}),
    toolCalls: [
      {
        id: "call-observer-1",
        type: "function",
        function: {
          name: "submit_result",
          arguments:
            '{"result":{"candidates":[],"decisions":[],"notes":"scripted: no candidates"}}',
        },
      },
    ],
    usage: { inputTokens: 2_000, outputTokens: 400 },
  };
}

/** 按 program_id 圈定的事实读取器（避免跨 Program 污染）。 */
function scopedFacts(ctx, programId) {
  return async () => {
    const facts = await ctx.dbFacts();
    return {
      program: facts.programs.find((row) => row.id === programId) ?? null,
      cycles: facts.cycles.filter((row) => row.program_id === programId),
      leases: facts.leases,
      usage: facts.usage,
      continuations: facts.continuations,
    };
  };
}

const OPEN_CYCLE_STATUSES = ["preparing", "running", "settling", "interrupted", "suspended"];

/** 等待 Program 无开放 Cycle（自动首轮到达终态；suspended 视为开放——占用保留）。 */
async function waitForProgramQuiet(read, timeoutMs = 180_000) {
  return waitFor(
    async () => {
      const facts = await read();
      return facts.cycles.every((row) => !OPEN_CYCLE_STATUSES.includes(row.status));
    },
    { label: "Program 无开放 Cycle（自动首轮终态）", timeoutMs },
  );
}

/** 经真实 UI 创建 Program 并返回 programId（表单默认值 + goal）。 */
async function createProgramViaForm(ctx, goal) {
  await ctx.window.locator('[data-testid="continuous-create-open"]').first().click();
  await ctx.window
    .locator('[data-testid="continuous-create-form"]')
    .first()
    .waitFor({ state: "visible" });
  await submitCreateForm(ctx.window, { goal });
  return waitForProgramCard(ctx.window, goal);
}

/**
 * 首轮执行链（E-01/E-02/E-15/E-16 合流取证）：
 * 等自动首轮静止 → Run now（barrier 挂住在飞请求）→ 重复 Run now（E-16 幂等）→ 放行 →
 * 空候选 completed（E-15）→ worktree/交付/原仓库保护（E-01/E-02）。
 */
export async function caseFirstCycleChain(ctx, { programId }) {
  const evidences = {
    "E-01": createCaseEvidence(ctx.run, "E-01"),
    "E-02": createCaseEvidence(ctx.run, "E-02"),
    "E-15": createCaseEvidence(ctx.run, "E-15"),
    "E-16": createCaseEvidence(ctx.run, "E-16"),
  };
  const read = scopedFacts(ctx, programId);
  await openContinuousTab(ctx.window);
  await openProgramDetail(ctx.window, programId);
  await evidences["E-01"].screenshot(ctx.window, "detail-before-run");

  const originBefore = await ctx.repo.snapshotState();
  await evidences["E-02"].record("origin-before.json", originBefore);
  const worktreeBefore = await readWorktreeFacts(ctx.repo);

  // 自动首轮（创建即执行）先到终态，避免与手动 Run now 的 barrier 争用全局请求序。
  await waitForProgramQuiet(read);
  const baselineCycles = (await read()).cycles.length;
  await evidences["E-15"].record("auto-first-cycle.json", (await read()).cycles);

  // 脚本：本 Program 的观察者请求挂 barrier（到达即记录），返回空候选 typed submit_result。
  await ctx.provider.control.setScript({ steps: [emptyObservationStep("observer-ask")] });
  const requestCountBefore = ctx.provider.facts().requestCount;
  await clickRunNow(ctx.window);

  // 新 Cycle 打开 + provider 请求到达 barrier（到达=真实链路已通到模型层）。
  await waitFor(async () => (await read()).cycles.length > baselineCycles, {
    label: "手动 Run now 的新 Cycle 创建",
  });
  await waitFor(() => ctx.provider.control.barrierState("observer-ask").arrived, {
    label: "观察者模型请求到达 barrier",
    timeoutMs: 120_000,
  });
  await evidences["E-16"].screenshot(ctx.window, "cycle-running-barrier");

  // E-16：同触发键重发（重复 Run now）——必须幂等吸收，不得并行新开第二个 Cycle。
  await clickRunNow(ctx.window).catch((error) => {
    // UI 侧命令失败是预期路径之一（open_cycle_exists 结构化拒绝）；记录后继续。
    evidences["E-16"].reference("second-run-now-error", { message: sanitizeText(String(error)) });
  });
  await waitFor(
    async () =>
      (await ctx.window
        .locator('[role="alert"]')
        .first()
        .isVisible()
        .catch(() => false)) || (await read()).cycles.length > baselineCycles + 1,
    { label: "重复 Run now 的结构化回执（alert 或新 Cycle）", timeoutMs: 15_000 },
  ).catch(() => {});
  const alertText = sanitizeText(
    (await ctx.window
      .locator('[role="alert"]')
      .first()
      .textContent()
      .catch(() => null)) ?? "",
  );
  await evidences["E-16"].record("second-run-now.json", {
    alertText,
    providerRequestCount: ctx.provider.facts().requestCount,
  });
  const factsAtBarrier = await read();
  assert.equal(
    factsAtBarrier.cycles.length,
    baselineCycles + 1,
    "重复 Run now 不得创建第二个 Cycle（trigger key 幂等）",
  );
  const openCycles = factsAtBarrier.cycles.filter((row) =>
    OPEN_CYCLE_STATUSES.includes(row.status),
  );
  assert.equal(openCycles.length, 1, "唯一开放 Cycle");
  assert.equal(
    new Set(factsAtBarrier.cycles.map((row) => row.workflow_run_id)).size,
    baselineCycles + 1,
    "每个 Cycle 唯一 Run 身份",
  );

  // 放行 barrier：观察者返回空候选 → run 完成 → Host 结算 no_changes。
  await ctx.provider.control.release("observer-ask");
  const terminal = await waitFor(
    async () => {
      const cycles = (await read()).cycles;
      return cycles.find(
        (row) =>
          row.status === "completed" || row.status === "failed" || row.status === "suspended",
      );
    },
    { label: "Cycle 终态", timeoutMs: 180_000 },
  );
  const factsAfter = await read();
  await evidences["E-15"].screenshot(ctx.window, "cycle-terminal");
  await evidences["E-01"].record("db-facts-terminal.json", factsAfter);
  await evidences["E-01"].record("provider-facts.json", await readProviderFacts(ctx.provider));

  // E-15：空候选 → completed → Program sleeping，nextCycleAt 为未来时点。
  assert.equal(terminal.status, "completed", `空候选轮必须 completed（实际 ${terminal.status}）`);
  assert.ok(terminal.base_commit, "Cycle 记录起始 commit");
  assert.equal(
    factsAfter.program.status,
    "sleeping",
    `空候选后 Program sleeping（实际 ${factsAfter.program.status}）`,
  );
  assert.ok(
    factsAfter.program.next_cycle_at &&
      factsAfter.program.next_cycle_at > terminal.completed_at &&
      factsAfter.program.next_cycle_at > Date.now() - 60_000,
    "nextCycleAt 必须是未来时点",
  );
  await evidences["E-15"].record("no-changes-facts.json", {
    cycleStatus: terminal.status,
    programStatus: factsAfter.program.status,
    nextCycleAt: factsAfter.program.next_cycle_at,
  });

  // E-01：worktree/执行 cwd/交付事实。
  const worktreeAfter = await readWorktreeFacts(ctx.repo);
  await evidences["E-01"].record("worktree-facts.json", worktreeAfter);
  assert.ok(
    worktreeAfter.continuousBranches.length >= worktreeBefore.continuousBranches.length,
    "Program 分支存在",
  );
  assert.ok(factsAfter.program.execution_path, "Program 记录 executionPath（受管 worktree）");
  const providerFacts = await readProviderFacts(ctx.provider);
  assert.ok(
    providerFacts.requestCount > requestCountBefore,
    "Run 期间有真实模型请求（journal 之外的执行证据）",
  );
  // 空候选轮没有成功项：不允许出现任何本地提交（提交门 fail closed 的真实产品行为）。
  const branchCommits = worktreeAfter.continuousBranches.flatMap((item) => item.commits);
  assert.deepEqual(branchCommits, [], "无验证通过的候选时不得产生本地提交");

  // E-02：原仓库未提交改动原样、HEAD 不变、无 push/merge（隔离仓库无远端）、独立分支交付。
  const originAfter = await ctx.repo.snapshotState();
  await evidences["E-02"].record("origin-after.json", originAfter);
  assert.equal(originAfter.head, originBefore.head, "原仓库 HEAD 不变");
  assert.deepEqual(
    originAfter.statusPorcelain,
    originBefore.statusPorcelain,
    "原仓库 staged/unstaged/untracked 改动原样保留",
  );
  assert.deepEqual(originAfter.trackedFiles, originBefore.trackedFiles, "跟踪文件集不变");
  const diff = await ctx.repo.diffPatch();
  const beforeDiff = await ctx.repo.git(["diff", "HEAD"]).catch(() => "");
  assert.equal(diff, beforeDiff, "原仓库工作树字节不变（diff 相同）");
  return { terminal, factsAfter, evidences };
}

/**
 * E-11：Pause（静止态不新开轮）与立即停止本轮（撤销→取消→等待停止→cancelled）。
 * 必须排在保留 suspended 轮的用例（E-08）之前——资源暂停不释放 workspace 执行占用。
 */
export async function casePauseAndStop(ctx) {
  const evidence = createCaseEvidence(ctx.run, "E-11");
  await openContinuousTab(ctx.window);
  await ctx.provider.control.setScript({ steps: [emptyObservationStep()] });
  const programId = await createProgramViaForm(ctx, "e2e-pause-and-stop");
  const read = scopedFacts(ctx, programId);
  await openProgramDetail(ctx.window, programId);
  // 自动首轮到终态后再验证 Pause 语义（Pause 不误取消已在执行项——静止形态）。
  await waitForProgramQuiet(read);
  const cyclesBeforePause = (await read()).cycles.length;

  await clickPause(ctx.window);
  await waitFor(async () => (await read()).program?.status === "paused", {
    label: "Program paused",
  });
  await evidence.screenshot(ctx.window, "paused-no-new-cycle");
  await sleep(2_000);
  const afterPause = await read();
  assert.equal(afterPause.program.status, "paused", "Pause 后 paused");
  assert.equal(
    afterPause.cycles.length,
    cyclesBeforePause,
    "Pause 期间不得新开 Cycle（本轮结束前禁止新轮）",
  );
  await clickResume(ctx.window);
  await waitFor(async () => (await read()).program?.status === "active", {
    label: "Program resumed",
  });

  // 立即停止本轮：Run（barrier 挂住在飞）→ Stop → cancelled，Program paused。
  // 先等静止：自动首轮若仍在飞（run13 实测 resume 后可能未完结），Run now 会被
  // open_cycle_exists 幂等吸收，后面的「新 Cycle 创建」等待必然超时。
  await waitForProgramQuiet(read);
  await ctx.provider.control.setScript({ steps: [emptyObservationStep("stop-ask")] });
  const cyclesBeforeRun = (await read()).cycles.length;
  await clickRunNow(ctx.window);
  await waitFor(async () => (await read()).cycles.length > cyclesBeforeRun, {
    label: "停止用例的 Cycle 创建",
  });
  await waitFor(() => ctx.provider.control.barrierState("stop-ask").arrived, {
    label: "停止用例的模型请求到达",
    timeoutMs: 120_000,
  });
  await clickStopCurrent(ctx.window);
  const cancelled = await waitFor(
    async () =>
      (await read()).cycles.find(
        (row) => row.status === "cancelled" && !OPEN_CYCLE_STATUSES.includes(row.status),
      ),
    { label: "立即停止：Cycle cancelled", timeoutMs: 120_000 },
  );
  const facts = await read();
  await evidence.screenshot(ctx.window, "stopped-cycle-cancelled");
  await evidence.record("stop-facts.json", {
    cycle: cancelled,
    programStatus: facts.program.status,
    cycles: facts.cycles.map((row) => ({ sequence: row.sequence, status: row.status })),
  });
  assert.equal(facts.program.status, "paused", "立即停止后 Program paused");
  await ctx.provider.control.release("stop-ask").catch(() => {});
  return { programId, evidence };
}

/** E-08：单轮预算耗尽（自动首轮即触发）——provider 零到达 + suspended/paused/继续确认。 */
export async function caseBudgetSuspend(ctx) {
  const evidence = createCaseEvidence(ctx.run, "E-08");
  await openContinuousTab(ctx.window);
  await ctx.provider.control.setScript({ steps: [emptyObservationStep()] });
  const requestsBefore = ctx.provider.facts().requestCount;
  // 单轮预算 USD 1（保守预留约 $2.26 > $1 → 首个模型请求在 provider 前被拒）。
  await ctx.window.locator('[data-testid="continuous-create-open"]').first().click();
  await ctx.window
    .locator('[data-testid="continuous-create-form"]')
    .first()
    .waitFor({ state: "visible" });
  await submitCreateForm(ctx.window, {
    goal: "e2e-budget-suspend",
    overrides: { "continuous-form-cycle-budget": "1" },
  });
  const programId = await waitForProgramCard(ctx.window, "e2e-budget-suspend");
  const read = scopedFacts(ctx, programId);
  const suspendedCycle = await waitFor(
    async () => (await read()).cycles.find((row) => row.status === "suspended"),
    { label: "预算暂停：Cycle suspended", timeoutMs: 180_000 },
  );
  const facts = await read();
  await evidence.screenshot(ctx.window, "budget-suspended");
  await evidence.record("budget-suspend-facts.json", {
    programId,
    cycle: suspendedCycle,
    programStatus: facts.program.status,
    continuations: facts.continuations,
    usage: facts.usage,
    providerRequestDelta: ctx.provider.facts().requestCount - requestsBefore,
  });
  // 超额请求未发 provider：预留被拒（保守预留 > $1 单轮上限）。
  assert.equal(
    ctx.provider.facts().requestCount,
    requestsBefore,
    "超额请求必须先冻结（provider 收到的请求数不增加）",
  );
  assert.equal(facts.program.status, "paused", "Program paused");
  assert.ok(
    facts.continuations.some((row) => row.status === "pending"),
    "存在唯一 pending 继续确认",
  );
  // 继续确认对话框（AskUserQuestion 形态）真实出现。
  await openProgramDetail(ctx.window, programId).catch(() => {});
  await waitFor(
    () =>
      ctx.window
        .locator('[data-testid="continuous-continuation-dialog"]')
        .first()
        .isVisible()
        .catch(() => false),
    { label: "继续确认对话框", timeoutMs: 30_000 },
  );
  await evidence.screenshot(ctx.window, "continuation-dialog");
  // 用户同意前不结算、不创建新轮：保持暂停（不点击任何授权）观察一段事实窗口。
  await sleep(2_000);
  const factsIdle = await read();
  assert.equal(factsIdle.cycles.length, 1, "保持暂停不创建新轮");
  assert.equal(ctx.provider.facts().requestCount, requestsBefore, "保持暂停期间零新请求");
  return { programId, evidence };
}

/** E-28（e2e 半边）：测试桥双重条件——test build + run ID 暴露；同 build 无 run ID 不暴露。 */
export async function caseBridgeDualCondition(ctx, context) {
  const evidence = createCaseEvidence(ctx.run, "E-28");
  const positive = await probeE2EBridge(context.window);
  await evidence.screenshot(context.window, "bridge-positive-instance");
  evidence.reference("bridge-positive-probe", positive);
  assert.equal(positive.bridgeExposed, true, "test build + run ID 双条件命中时 bridge 必须暴露");
  const negativeEnv = buildIsolationEnv(ctx.run, {
    bridgeRunId: "",
    userDataDir: path.join(ctx.run.dirs.electronUserData, "no-run-id"),
    appNameSuffix: " NoRunId",
  });
  const negativeApp = await launchDesktop(ctx.run, {
    env: { ...process.env, ...negativeEnv },
    logFileName: "electron-no-run-id.log",
    quiet: true,
  });
  try {
    const negativeWindow = await waitForFirstWindow(negativeApp.electron, 60_000);
    const negative = await probeE2EBridge(negativeWindow);
    await evidence.screenshot(negativeWindow, "bridge-negative-instance");
    evidence.reference("bridge-negative-probe", negative);
    assert.equal(negative.bridgeExposed, false, "缺 run ID 时 bridge 不得暴露（不因环境名开放）");
    await evidence.record("bridge-probes.json", { positive, negative });
    return { evidence };
  } finally {
    await negativeApp.electron.close().catch(() => {});
    negativeApp.closeLog();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
