#!/usr/bin/env node
// CT-09 真实 Electron + 脚本化模型 E2E（suite 入口；docs/testing/continuous.md §4 步骤 D）。
//
// 流程：隔离 testRun → 构建 CLI 并取 fingerprint → desktop 构建 → fixtures（目标应用/
// 脚本化 provider）→ playwright-core Electron 启动 → Host 就绪 + 加载指纹核对 → 用例 →
// artifacts + 标准报告 → 停止本次 testRun 的全部进程。
//
// 状态语义（§10）：blocked ≠ passed。Continuous channel 尚未在 Electron Host 装配
//（CT-08 记录的边界）时，依赖 capability 的用例如实标 blocked 并附预检证据，
// 汇总测试因此失败（非零退出）——绝不把 runner 存在或截图生成写成验收通过。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  AGENT_DIST_BUNDLE,
  DESKTOP_ROOT,
  REPO_ROOT,
  buildAgentCli,
  buildIsolationEnv,
  caseSummary,
  createTestRun,
  ensureDesktopBuild,
  finalizeTestRun,
  platformKey,
  recordCase,
  sha256File,
  stopRunResources,
} from "./runner.mjs";
import {
  launchDesktop,
  probeE2EBridge,
  waitForFirstWindow,
  waitForHostFingerprint,
} from "./runnerElectron.mjs";
import { createGitRepoFixture } from "./fixtures.mjs";
import { createTargetAppServer } from "./fixturesTargetApp.mjs";
import { createScriptedProvider } from "./fixturesProvider.mjs";
import { createCaseEvidence } from "./evidence.mjs";

// 脚本化 e2e suite 覆盖的用例清单（E-21 手机链路在 mobile suite；E-25…E-27 在 platform/regression）。
const SCRIPTED_E2E_CASE_IDS = [
  "E-01",
  "E-02",
  "E-03",
  "E-04",
  "E-05",
  "E-06",
  "E-07",
  "E-08",
  "E-09",
  "E-10",
  "E-11",
  "E-12",
  "E-13",
  "E-14",
  "E-15",
  "E-16",
  "E-17",
  "E-18",
  "E-19",
  "E-20",
  "E-22",
  "E-23",
  "E-24",
  "E-28",
  "E-29",
  "E-30",
  "E-31",
  "E-32",
  "E-33",
  "E-34",
];

function parseArgs(argv) {
  const parsed = {
    skipDesktopBuild: false,
    skipCliBuild: false,
    parentRunId: null,
    reportFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-desktop-build") parsed.skipDesktopBuild = true;
    else if (arg === "--skip-cli-build") parsed.skipCliBuild = true;
    else if (arg === "--parent-run-id") parsed.parentRunId = argv[(index += 1)];
    else if (arg === "--report-file") parsed.reportFile = argv[(index += 1)];
    else {
      console.error(`[e2e] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .toString()
  .trim();
const run = createTestRun({ suiteLabel: "e2e", parentRunId: args.parentRunId });

async function writeReport(statusOverride) {
  // 成功（无 failed/blocked 且有 passed）时清理数据/fixture 目录、保留 artifacts 验收报告；
  // 有 failed/blocked 时保留整个临时根供取证（测试文档 §2）。
  await finalizeTestRun(run, { sourceCommit, cleanOnSuccess: true });
  const summary = caseSummary(run);
  const payload = {
    suite: "e2e",
    testRunId: run.testRunId,
    parentRunId: run.parentRunId,
    status:
      statusOverride ??
      (summary.failed > 0
        ? "failed"
        : summary.blocked === 0 && summary.passed > 0
          ? "passed"
          : "blocked"),
    summary,
    cases: [...run.cases.values()],
    checks: run.checks,
    artifacts: {
      root: run.root,
      manifest: path.join(run.dirs.artifacts, "manifest.json"),
      results: path.join(run.dirs.artifacts, "results.json"),
    },
  };
  if (args.reportFile) {
    const { writeFile: writeReportFile } = await import("node:fs/promises");
    await writeReportFile(args.reportFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  console.log(`[e2e] artifacts root: ${run.root}`);
  return payload;
}

/** 预检与 fixtures；失败时写入报告后以非零退出（runner 启动失败不是 passed，§10）。 */
async function setup() {
  const stagedBundle = path.join(DESKTOP_ROOT, "bundled-agents", platformKey(), "glm", "zcode.cjs");
  const cli = args.skipCliBuild
    ? {
        staged: stagedBundle,
        fingerprint: { ...(await sha256File(stagedBundle)), stagedBundlePath: stagedBundle },
      }
    : await buildAgentCli(run);
  await ensureDesktopBuild(run, { skipDesktopBuild: args.skipDesktopBuild });
  const bridgeEnv = buildIsolationEnv(run, { bridgeRunId: run.testRunId });
  const repo = await createGitRepoFixture(run, { name: "e2e-origin" });
  const targetApp = createTargetAppServer(run, { repoDir: repo.dir });
  const provider = createScriptedProvider(run);
  const app = await launchDesktop(run, { env: { ...process.env, ...bridgeEnv } });
  const window = await waitForFirstWindow(app.electron, 60_000);
  const fingerprint = await waitForHostFingerprint(run, {
    stdoutText: app.stdoutText,
    fingerprint: cli.fingerprint,
    distBundlePath: AGENT_DIST_BUNDLE,
    timeoutMs: 60_000,
  });
  return { cli, bridgeEnv, repo, targetApp, provider, app, window, fingerprint };
}

let context;
try {
  context = await setup();
} catch (error) {
  run.recordCheck("setup", false, String(error));
  for (const caseId of SCRIPTED_E2E_CASE_IDS) {
    recordCase(run, {
      caseId,
      status: "blocked",
      sourceCommit,
      failureReason: `runner 预检失败（构建/启动/就绪）: ${String(error?.message ?? error)}`,
    });
  }
  await writeReport("failed");
  await stopRunResources(run);
  throw error;
}

// capability 预检：Host 未装配 Continuous channel 时 UI 的 Continuous tab 必须隐藏
//（accessor.continuousService 缺席 = 默认关闭，spec §13）。这是「不可用」的真实产品行为证据。
async function probeContinuousCapability() {
  const selector = '[data-testid="automations-page-tab-continuous"]';
  const windows = context.app.electron.windows();
  for (const [index, window] of windows.entries()) {
    try {
      if ((await window.locator(selector).count()) > 0) {
        return { available: true, evidence: `selector 命中于 window#${index}` };
      }
    } catch {
      // 窗口导航态不稳定时继续探测其余窗口。
    }
  }
  return {
    available: false,
    reason:
      "automations 页未出现 Continuous tab：Host 未装配 ServiceChannels.Continuous（CT-08 记录的装配边界，功能默认关闭）",
  };
}

const capability = await probeContinuousCapability();
run.recordCheck(
  "continuous-capability",
  capability.available,
  capability.reason ?? capability.evidence,
);
const CAPABILITY_BLOCKED_REASON =
  "Continuous channel 未在 Electron Host 装配（见 checks.continuous-capability）；无法从真实 UI 驱动该用例，标 blocked 而非通过";

function blockedCase(t, caseId, reason, evidenceRefs = []) {
  recordCase(run, {
    caseId,
    status: "blocked",
    sourceCommit,
    command: "node scripts/test-continuous.mjs --suite e2e",
    failureReason: reason,
    evidence: evidenceRefs,
  });
  t.skip(`blocked: ${reason}`);
}

test("E-28 生产测试桥关闭（双重条件）", async (t) => {
  const evidence = createCaseEvidence(run, "E-28");
  const positive = await probeE2EBridge(context.window);
  await evidence.screenshot(context.window, "bridge-positive-instance");
  evidence.reference("bridge-positive-probe", positive);
  assert.equal(positive.bridgeExposed, true, "test build + run ID 双条件命中时 bridge 必须暴露");
  // 反向对照：同 build、无 ZCODE_E2E_RUN_ID（只有 ZCODE_ENV=test 不算测试标识，E-28 第二设置）。
  const negativeEnv = buildIsolationEnv(run, {
    userDataDir: path.join(run.dirs.electronUserData, "no-run-id"),
    appNameSuffix: " NoRunId",
  });
  const negativeApp = await launchDesktop(run, {
    env: { ...process.env, ...negativeEnv },
    logFileName: "electron-no-run-id.log",
  });
  try {
    const negativeWindow = await waitForFirstWindow(negativeApp.electron, 60_000);
    const negative = await probeE2EBridge(negativeWindow);
    await evidence.screenshot(negativeWindow, "bridge-negative-instance");
    evidence.reference("bridge-negative-probe", negative);
    assert.equal(negative.bridgeExposed, false, "缺 run ID 时 bridge 不得暴露（不因环境名开放）");
    await evidence.record("bridge-probes.json", { positive, negative });
    recordCase(run, {
      caseId: "E-28",
      status: "blocked",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite e2e",
      assertions: [
        "test build + run ID：bridge 暴露（真实 Electron 断言）",
        "同 build 无 run ID：bridge 不暴露（真实 Electron 断言）",
      ],
      evidence: evidence.list(),
      failureReason:
        "无 VITE_ZCODE_E2E_STORE_BRIDGE 的普通 production build 半边未执行（需第二份 renderer 构建，归 platform/regression suite）",
    });
    t.skip("blocked: production（无 bridge flag）build 半边待 platform suite");
  } finally {
    await negativeApp.electron.close().catch(() => {});
    negativeApp.closeLog();
  }
});

test("E-24 不支持的环境与旧 CLI", async (t) => {
  const evidence = createCaseEvidence(run, "E-24");
  await evidence.screenshot(context.window, "capability-absent");
  await evidence.record("capability-probe.json", capability);
  blockedCase(
    t,
    "E-24",
    "capability 缺席分支已取真实证据（tab 隐藏=默认关闭），但远程 workspace/旧 CLI/平台不可用完整子场景需 capability 装配后驱动",
    evidence.list(),
  );
});

for (const caseId of SCRIPTED_E2E_CASE_IDS) {
  if (caseId === "E-24" || caseId === "E-28") continue;
  test(`${caseId}（脚本化 E2E）`, (t) => {
    blockedCase(t, caseId, CAPABILITY_BLOCKED_REASON, [
      { kind: "preflight", detail: "checks.continuous-capability" },
    ]);
  });
}

test("e2e suite 汇总：blocked/failed 必须为 0", () => {
  const summary = caseSummary(run);
  console.log(`[e2e] case summary: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0, `failed 用例: ${summary.failed}`);
  assert.equal(
    summary.blocked,
    0,
    `blocked 用例: ${summary.blocked}（Host 装配/矩阵完成后应归零）`,
  );
  assert.ok(summary.passed > 0, "没有任何用例通过时 suite 不能通过");
});

after(async () => {
  await writeReport();
  await stopRunResources(run);
});
