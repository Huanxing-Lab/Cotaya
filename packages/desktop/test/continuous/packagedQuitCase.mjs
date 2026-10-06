// CT-16 打包 app 的退出/重启恢复用例（E-17 的可驱动半边：正常退出 + 同 Run 恢复）。
//
// 产品语义（规格 §10/D2）：应用退出 → interruptForShutdown 保存 interrupted（lease 保留
// 持久化占用）；重启 → Host 启动核对（recoverAllOnStartup）先核对未结束 Cycle → 同 Cycle/
// 同 Run 恢复，不创建第二个 Cycle/执行者。全部断言取自真实事实：tasks-index 只读 SQL、
// provider 请求计数（恢复真实重放观察者请求）、UI 状态徽标。
//
// 强杀半边（R 屏障下的 SIGKILL 注入）不在本用例——CT-16 只要求在打包 app 中重复
// 「暂停/退出/恢复/停止/本地提交」；强杀恢复链需要传输级注入面（e2e E-17 的既有 blocked
// 理由），不在这里伪造。

import assert from "node:assert/strict";
import { createCaseEvidence } from "./evidence.mjs";
import {
  clickRunNow,
  openContinuousTab,
  openProgramDetail,
  submitCreateForm,
  waitFor,
  waitForProgramCard,
} from "./continuousDriver.mjs";
import { emptyObservationStep } from "./e2eCycles.mjs";
import { launchPackagedApp } from "./packagedBuild.mjs";
import { waitForFirstWindow } from "./runnerElectron.mjs";
import { openAutomationsPage } from "./runnerWindow.mjs";

const OPEN_CYCLE_STATUSES = ["preparing", "running", "settling", "interrupted", "suspended"];

/** 按 program_id 圈定的事实读取器（e2eCycles.scopedFacts 同一约定：跨 Program 不污染）。 */
function scopedFacts(ctx, programId) {
  return async () => {
    const facts = await ctx.dbFacts();
    return {
      program: facts.programs.find((row) => row.id === programId) ?? null,
      cycles: facts.cycles.filter((row) => row.program_id === programId),
      leases: facts.leases,
    };
  };
}

/**
 * E-17（打包形态）：静止态建 Program → 带_barrier 的 Run now 挂住在飞请求 → 正常退出
 * （窗口关闭 = 产品退出链）→ 断言 interrupted 保存 → 同数据根重启 → 启动核对同 Run 恢复
 * → 终态 completed。relaunchEnv/executablePath 由入口提供（与首实例同一隔离 env）。
 */
export async function caseQuitAndRestartRecovery(ctx, { env, executablePath }) {
  const evidence = createCaseEvidence(ctx.run, "E-17");
  const relaunch = async () => {
    const app = await launchPackagedApp(ctx.run, { executablePath, env, quiet: true });
    const window = await waitForFirstWindow(app.electron, 60_000);
    const navigation = await openAutomationsPage(window, 90_000);
    if (!navigation.navigated) {
      throw new Error(`[packaged] 重启后窗口未就绪: ${navigation.reason}`);
    }
    ctx.window = window;
    ctx.app = app;
    return { window, app };
  };

  // 静止态创建（脚本无 barrier：自动首轮立即 no_changes 完成，不与本用例的挂起轮争请求序）。
  await openContinuousTab(ctx.window);
  await ctx.provider.control.setScript({ steps: [emptyObservationStep()] });
  await ctx.window.locator('[data-testid="continuous-create-open"]').first().click();
  await ctx.window
    .locator('[data-testid="continuous-create-form"]')
    .first()
    .waitFor({ state: "visible" });
  await submitCreateForm(ctx.window, { goal: "packaged-quit-restart" });
  const programId = await waitForProgramCard(ctx.window, "packaged-quit-restart");
  const read = scopedFacts(ctx, programId);
  await openProgramDetail(ctx.window, programId);
  await evidence.screenshot(ctx.window, "created");
  await waitFor(
    async () => {
      const facts = await read();
      return (
        facts.cycles.length > 0 &&
        facts.cycles.every((row) => !OPEN_CYCLE_STATUSES.includes(row.status))
      );
    },
    { label: "自动首轮终态（no_changes）", timeoutMs: 180_000 },
  );
  const cyclesBefore = (await read()).cycles.length;

  // 带 Barrier 的 Run now：观察者请求真实到达 provider 后挂住（在飞，未完成）。
  await ctx.provider.control.setScript({ steps: [emptyObservationStep("pk-quit-ask")] });
  await clickRunNow(ctx.window);
  await waitFor(async () => (await read()).cycles.length > cyclesBefore, {
    label: "退出用例的 Cycle 创建",
  });
  await waitFor(() => ctx.provider.control.barrierState("pk-quit-ask").arrived, {
    label: "退出用例的模型请求到达（在飞）",
    timeoutMs: 120_000,
  });
  const inFlight = await read();
  const openCycle = inFlight.cycles.find((row) => OPEN_CYCLE_STATUSES.includes(row.status));
  assert.ok(openCycle, "退出前必须存在开放 Cycle");
  const runIdBeforeQuit = openCycle.workflow_run_id;
  await evidence.screenshot(ctx.window, "in-flight-before-quit");
  await evidence.record("in-flight-before-quit.json", inFlight);

  // 正常退出：playwright close 关闭窗口 → Electron 默认 window-all-closed 退出 →
  // Host shutdown phases 的 continuous-interrupt（保存 interrupted、interrupt 引擎并等收尾）。
  const quitStartedAt = Date.now();
  await ctx.app.electron.close();
  ctx.app.closeLog();
  const quitDurationMs = Date.now() - quitStartedAt;
  // close() resolve = 应用进程退出；这里给出宽裕上限并把时长写入证据（悬挂是产品缺陷，
  // 由超时失败如实暴露，不用 kill 冒充正常退出）。
  assert.ok(quitDurationMs < 180_000, `正常退出耗时异常: ${quitDurationMs}ms`);
  const afterQuit = await read();
  const quitCycle = afterQuit.cycles.find((row) => row.id === openCycle.id);
  await evidence.record("after-quit.json", { quitDurationMs, facts: afterQuit });
  assert.equal(
    quitCycle?.status,
    "interrupted",
    `退出必须保存 interrupted（实际 ${quitCycle?.status}）`,
  );
  assert.equal(quitCycle.workflow_run_id, runIdBeforeQuit, "退出不改变执行身份");

  // 放行挂住的 barrier（fixture 卫生）并把脚本切回无 barrier：恢复后的重放请求立即完成。
  await ctx.provider.control.release("pk-quit-ask").catch(() => {});
  await ctx.provider.control.setScript({ steps: [emptyObservationStep()] });
  const requestsBeforeRestart = ctx.provider.facts().requestCount;

  // 同数据根重启：Host 启动核对（recoverAllOnStartup）应先核对未结束 Cycle——同 Cycle/
  // 同 Run 恢复，不创建第二个 Cycle。
  await relaunch();
  await openContinuousTab(ctx.window);
  await openProgramDetail(ctx.window, programId);
  const recovered = await waitFor(
    async () => {
      const facts = await read();
      return facts.cycles.find(
        (row) => row.id === openCycle.id && !OPEN_CYCLE_STATUSES.includes(row.status),
      );
    },
    { label: "重启后旧 Cycle 恢复至终态", timeoutMs: 240_000 },
  );
  const afterRestart = await read();
  await evidence.screenshot(ctx.window, "recovered-after-restart");
  await evidence.record("after-restart.json", afterRestart);
  assert.equal(recovered.status, "completed", `恢复轮应完成（实际 ${recovered.status}）`);
  assert.equal(recovered.workflow_run_id, runIdBeforeQuit, "恢复必须是同一 Run（不铸第二执行者）");
  assert.equal(afterRestart.cycles.length, cyclesBefore + 1, "重启不得创建第二个 Cycle");
  assert.equal(
    new Set(afterRestart.cycles.map((row) => row.workflow_run_id)).size,
    afterRestart.cycles.length,
    "每个 Cycle 唯一 Run 身份",
  );
  assert.ok(
    ctx.provider.facts().requestCount > requestsBeforeRestart,
    "恢复必须真实重放模型请求（provider 计数增加）",
  );
  return { programId, evidence };
}
