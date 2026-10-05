#!/usr/bin/env node
// CT-09 真实 Electron + 脚本化模型 E2E（suite 入口；docs/testing/continuous.md §4 步骤 D）。
//
// 流程：隔离 testRun → 构建 CLI 并取 fingerprint → desktop 构建 → fixtures（目标应用/
// 脚本化 provider）→ playwright-core Electron 启动 → Host 就绪 + 加载指纹核对 → 用例 →
// artifacts + 标准报告 → 停止本次 testRun 的全部进程。
//
// 状态语义（§10）：blocked ≠ passed。Continuous channel 尚未在 Electron Host 装配
//（CT-08 记录的边界，属 docs/release/continuous.md §2 的「开启前置」）时，依赖
// capability 的用例如实标 blocked 并附预检证据；blocked 不是失败——退出码由 failed
// 决定（§10 退出码语义），blocked 事实保留在报告里由 release gate 消费（自主实施
// flag 保持关闭），绝不把 runner 存在或截图生成写成验收通过。
//
// 输出契约（§4 步骤 D）：构建与 Electron 输出写入 artifacts/logs/，控制台只留结论行
//（批量构建子进程 300KB+ 输出会让有 stdout 上限的编排门禁整条拒收）。

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
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
})
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
  // quiet：CLI/desktop 构建 300KB+ 输出与 Electron 主进程日志只落 artifacts/logs/（§4 步骤 D
  // 输出契约；编排门禁存在 stdout 上限，整条命令会被拒收），失败时错误消息指向日志文件。
  const cli = args.skipCliBuild
    ? {
        staged: stagedBundle,
        fingerprint: {
          ...(await sha256File(stagedBundle)),
          stagedBundlePath: stagedBundle,
        },
      }
    : await buildAgentCli(run, { quiet: true });
  await ensureDesktopBuild(run, { skipDesktopBuild: args.skipDesktopBuild, quiet: true });
  const bridgeEnv = buildIsolationEnv(run, { bridgeRunId: run.testRunId });
  const repo = await createGitRepoFixture(run, { name: "e2e-origin" });
  const targetApp = createTargetAppServer(run, { repoDir: repo.dir });
  const provider = createScriptedProvider(run);
  const app = await launchDesktop(run, {
    env: { ...process.env, ...bridgeEnv },
    quiet: true,
  });
  const window = await waitForFirstWindow(app.electron, 60_000);
  const fingerprint = await waitForHostFingerprint(run, {
    stdoutText: app.stdoutText,
    fingerprint: cli.fingerprint,
    distBundlePath: AGENT_DIST_BUNDLE,
    timeoutMs: 60_000,
  });
  return {
    cli,
    bridgeEnv,
    repo,
    targetApp,
    provider,
    app,
    window,
    fingerprint,
  };
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
// （capability 探测无结论 = 默认关闭，spec §13）。这是「不可用」的真实产品行为证据。
// 评审修复：Continuous tab 只在用户进入 Automations 页面时才挂载——必须先真实导航过去
// 再扫描，否则「selector 不存在」无法区分「被门隐藏」与「页面根本没打开」（空转 canary）。
async function probeContinuousCapability() {
  const selector = '[data-testid="automations-page-tab-continuous"]';
  const windows = context.app.electron.windows();
  for (const [index, window] of windows.entries()) {
    try {
      // 欢迎页阻挡探测（修复依据）：每次 testRun 使用全新 electron-user-data，凭据必然缺席
      //（测试文档 §4 步骤 E 禁止输入个人凭据），产品此时首屏为登录/欢迎页——侧栏与
      // automations 入口不渲染。若不区分，「点击 automations-open 超时」会被笼统记成
      // 「窗口未就绪」，而实际上根因是欢迎页 gating；此时「tab 隐藏 = 默认关闭」的证据
      // 也并未取到，必须如实分开陈述，避免 blocked 理由引用不存在的证据。
      // 登录按钮 testid 是 oauth-login-button(-<providerId>) 前缀族 + API key 入口，
      // 用前缀选择器覆盖全部 provider 变体；count() 立即返回存在渲染竞态，先等挂载。
      try {
        await window
          .locator('[data-testid^="oauth-login-button"], [data-testid="login-use-api-key-button"]')
          .first()
          .waitFor({ state: "attached", timeout: 5_000 });
        return {
          available: false,
          reason:
            "欢迎/登录页阻挡（隔离环境无凭据，且禁止输入个人凭据）：无法到达 Automations 页，tab 缺席证据不成立",
        };
      } catch {
        // 欢迎页未出现（可能已登录/已有凭据）：继续尝试导航 Automations 页。
      }
      // 导航到 Automations 主视图（侧栏入口），并等待页面骨架挂载（toast 锚点 main 元素）。
      await window.locator('[data-testid="automations-open"]').first().click({ timeout: 10_000 });
      await window
        .locator("#automations-main-toast-anchor")
        .first()
        .waitFor({ state: "attached", timeout: 10_000 });
      if ((await window.locator(selector).count()) > 0) {
        return {
          available: true,
          evidence: `selector 命中于 window#${index}（已导航至 automations 页）`,
        };
      }
      return {
        available: false,
        reason:
          "automations 页已打开但未出现 Continuous tab：Host 未装配 ServiceChannels.Continuous（CT-08 记录的装配边界，功能默认关闭）",
      };
    } catch {
      // 窗口导航态不稳定时继续探测其余窗口。
    }
  }
  return {
    available: false,
    reason: "无法完成 automations 页导航（窗口未就绪）；tab 缺席证据不成立",
  };
}

const capability = await probeContinuousCapability();
run.recordCheck(
  "continuous-capability",
  capability.available,
  capability.reason ?? capability.evidence,
);
// 修复依据：该理由陈述的是代码事实（desktop main 从未传入 continuousManagedCycles，
// release 文档 §2 记录的「开启前置——尚未实施」），不是本次 capability 探测的结论——
// 探测在无凭据隔离环境可能停在欢迎页（见 probeContinuousCapability），二者不能混写。
const CAPABILITY_BLOCKED_REASON =
  "Continuous channel 未在 Electron Host 装配（desktop 侧无 continuousManagedCycles 接线，属开启前置未实施；探测记录见 checks.continuous-capability）；无法从真实 UI 驱动该用例，标 blocked 而非通过";

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
    quiet: true,
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
        "无 VITE_ZCODE_E2E_STORE_BRIDGE 的普通 production build 半边不在本 suite 执行（需第二份 renderer 构建；CT-10 起由 regression suite 真实执行并出证）",
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
  // 修复依据：blocked 理由必须引用真实取到的证据。capability 探测可能停在欢迎页
  //（无凭据隔离环境，见 probeContinuousCapability），此时「tab 隐藏 = 默认关闭」并未
  // 被证明，理由按探测结论如实生成，不静态声称已取到 tab 缺席证据。
  blockedCase(
    t,
    "E-24",
    `capability 探测结论：${capability.reason ?? capability.evidence}；远程 workspace/旧 CLI/平台不可用完整子场景需 capability 装配后驱动`,
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

test("e2e suite 汇总：failed 必须为 0（blocked 如实记录，§10 退出码语义）", () => {
  const summary = caseSummary(run);
  console.log(`[e2e] case summary: ${JSON.stringify(summary)}`);
  // 修复依据：blocked 是 capability/平台不可用的如实状态（Host 装配属 release 文档 §2
  // 「开启前置」），不是 runner 失败——把 blocked 编码成非零退出会让默认关闭阶段的
  // suite 永远无法通过门禁，且与「blocked 见 artifacts/results.json」的发布语义冲突。
  // 汇总只断言 failed === 0；blocked 数量经 writeReport 写入报告（status=blocked），
  // 由 release gate 消费（自主实施 flag 保持关闭）。
  assert.equal(summary.failed, 0, `failed 用例: ${summary.failed}`);
  // 用例必须全部有结论（无 planned 悬空）；capability 缺席时结论为 blocked 而非 passed。
  assert.equal(summary.planned, 0, `planned 用例: ${summary.planned}（用例没有结论）`);
  assert.ok(
    summary.blocked + summary.passed > 0,
    "没有任何用例结论时 suite 不能通过（runner 空转不是验收）",
  );
});

after(async () => {
  await writeReport();
  await stopRunResources(run);
});
