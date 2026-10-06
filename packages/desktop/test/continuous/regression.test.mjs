#!/usr/bin/env node
// CT-10 兼容回归 suite 入口（docs/testing/continuous.md §4 步骤 G、§8 E-26/E-27/E-28）。
//
// 覆盖三块可真实执行 的回归：
//   E-26 普通功能回归 —— bootstrap 既有测试（普通 Workflow actor 模型/imported cache、
//         OpenAI login 等）真实重跑 + 权限 mode 枚举 canary（不得出现 continuous）+
//         Continuous 代码不引入并行 Goal continuation 链（grep 事实）；
//   E-27 关闭与回滚 —— 无 bridge flag 的普通 production build 上 Continuous tab 缺席
//         （默认关闭的真实产品行为）+ recovery suite 的停止链语义重跑 + 回滚顺序文档在场；
//   E-28 生产测试桥关闭 —— production build（VITE_ZCODE_E2E_STORE_BRIDGE=0）上：
//         ZCODE_ENV=test 无双重测试标识 → bridge 不暴露（真实 Electron 探针）；
//         测试专用符号（barrier/controllable clock/scripted provider）不出现在产物 bundle。
//
// 与 e2e suite 的分工：那边是 bridge build + run ID 的正向用例；这边补 production 半边。
// UI 级普通 Workflow Run 回归与手机 replayable 链路不在此声称（归 e2e/mobile suite，
// 其 blocked 状态如实见各自 results.json）。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DESKTOP_ROOT,
  REPO_ROOT,
  buildIsolationEnv,
  caseSummary,
  createTestRun,
  ensureDesktopBuild,
  finalizeTestRun,
  recordCase,
  recordCaseFailure,
  spawnCaptured,
  stopRunResources,
} from "./runner.mjs";
import { launchDesktop, probeE2EBridge, waitForFirstWindow } from "./runnerElectron.mjs";
import { openAutomationsPage } from "./runnerWindow.mjs";
import { createGitRepoFixture } from "./fixtures.mjs";
import { createCaseEvidence } from "./evidence.mjs";

function parseArgs(argv) {
  const parsed = { parentRunId: null, reportFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--parent-run-id") parsed.parentRunId = argv[(index += 1)];
    else if (arg === "--report-file") parsed.reportFile = argv[(index += 1)];
    else {
      console.error(`[regression] 未知参数: ${arg}`);
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
const run = createTestRun({
  suiteLabel: "regression",
  parentRunId: args.parentRunId,
});

async function writeReport(statusOverride) {
  await finalizeTestRun(run, { sourceCommit, cleanOnSuccess: true });
  const summary = caseSummary(run);
  const payload = {
    suite: "regression",
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
  console.log(`[regression] artifacts root: ${run.root}`);
  return payload;
}

/** 递归收集目录下指定后缀文件（产物 bundle 扫描用）。 */
function collectFiles(root, suffixes) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) out.push(full);
    }
  };
  visit(root);
  return out;
}

test("E-26: bootstrap 既有测试真实重跑（普通 Workflow/登录/Continuous 接缝零回归）", async () => {
  const evidence = createCaseEvidence(run, "E-26");
  try {
    // quiet：完整测试输出只落 artifacts/logs（编排层对 stdout 有 262144 字节上限，回显全部
    // 用例的 spec 输出会超限）；控制台只留结论行，证据取自退出码与日志文件。
    const result = await spawnCaptured(
      run,
      "bootstrap-tests",
      "pnpm",
      ["--dir", "apps/zcode-cli/packages/bootstrap", "test"],
      { cwd: REPO_ROOT, quiet: true },
    );
    console.log(`[regression] bootstrap-tests exit=${result.exitCode} log=${result.logFile}`);
    await evidence.record("bootstrap-tests.json", {
      command: "pnpm --dir apps/zcode-cli/packages/bootstrap test",
      exitCode: result.exitCode,
      logFile: result.logFile,
    });
    // 普通 Workflow 的人类确认/escalation 不改（规格 §11「保持不变」）：actor 模型 pin 与
    // imported cache 语义由 workflow-actor-model.test.ts 等既有用例承载（真实重跑）。
    assert.equal(result.exitCode, 0, "bootstrap 既有测试必须全绿（旧失败需单独记录，不得写通过）");

    // 权限 mode 枚举 canary：不得出现 continuous（E-26「不新增 mode 枚举」）。
    // cwd 取 packages/services（其 node_modules 解析 @zcode/shared；root 非直接依赖不可解析）。
    const modes = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--eval",
          "import('@zcode/shared').then((m) => process.stdout.write(JSON.stringify(m.zcodeTaskModeSchema.options)))",
        ],
        { cwd: path.join(REPO_ROOT, "packages/services") },
      )
        .toString()
        .trim(),
    );
    await evidence.record("task-modes.json", { modes });
    assert.deepEqual(
      [...modes].sort(),
      ["auto", "autoEdit", "build", "edit", "plan", "yolo"],
      "权限 mode 枚举必须保持既有六值（无 continuous）",
    );

    // Continuous 不引入并行 Goal continuation 链（E-26；services/bootstrap 的 Continuous
    // 代码不得引用 target-continuation-loop —— grep 是真实事实检查）。
    const grepTargets = [
      path.join(REPO_ROOT, "packages/services/src/continuous"),
      path.join(REPO_ROOT, "apps/zcode-cli/packages/bootstrap/src/app"),
    ];
    const offenders = [];
    for (const dir of grepTargets) {
      for (const file of collectFiles(dir, [".ts"])) {
        const text = await readFile(file, "utf8");
        if (/target-continuation-loop|TargetContinuationLoop/.test(text)) offenders.push(file);
      }
    }
    await evidence.record("goal-loop-grep.json", { offenders });
    assert.deepEqual(offenders, [], "Continuous 代码不得引用 Goal continuation 实现");
    recordCase(run, {
      caseId: "E-26",
      status: "passed",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite regression",
      assertions: [
        "pnpm --dir apps/zcode-cli/packages/bootstrap test 退出码 0（普通 Workflow actor 模型/imported cache/确认接缝零回归）",
        "权限 mode 枚举 = yolo/plan/edit/auto/autoEdit/build（无 continuous）",
        "Continuous 代码不引用 target-continuation-loop（无并行 Goal 链）",
      ],
      evidence: evidence.list(),
      failureReason:
        "UI 级普通 Workflow Run 回归与手机 replayable 链路归 e2e/mobile suite（未在此声称；其 blocked 状态见各自 results.json）",
    });
  } catch (error) {
    // 失败先落 failed 记录与证据（报告与退出码一致；不把故障改写成通过）。
    recordCaseFailure(run, {
      caseId: "E-26",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite regression",
      error,
      evidence: evidence.list(),
    });
    throw error;
  }
});

test("E-28: production build（无 bridge flag）——测试桥不可用、测试符号不进产物", async (t) => {
  const evidence = createCaseEvidence(run, "E-28");
  try {
    // 普通 production build：rendererBridge=false（显式 "0"，防外层 e2e 残留泄漏）；quiet——
    // vite 生产构建输出 300KB+，回显会撞编排层 stdout 上限，完整日志在 artifacts/logs。
    await ensureDesktopBuild(run, { rendererBridge: false, quiet: true });

    // bundle 检查：测试专用 fixture 符号不得出现在任何产物 bundle（main/host/preload/renderer）。
    const outDir = path.join(DESKTOP_ROOT, "out");
    const bundles = collectFiles(outDir, [".js", ".mjs"]);
    assert.ok(bundles.length > 0, "production build 产物为空");
    const testSymbols = [
      "createBarrier",
      "createControllableClock",
      "createScriptedProvider",
      "e2eAppConfigSeed",
    ];
    const symbolHits = [];
    for (const file of bundles) {
      const text = await readFile(file, "utf8");
      for (const symbol of testSymbols) {
        if (text.includes(symbol)) symbolHits.push({ file: path.relative(outDir, file), symbol });
      }
    }
    await evidence.record("bundle-scan.json", { bundles: bundles.length, symbolHits });
    assert.deepEqual(symbolHits, [], "测试专用符号（barrier/时钟/provider/种子）不得进入生产产物");

    // CT-15 修复：无凭据隔离实例曾被欢迎/登录页挡住而到不了 Automations 页（E-28 断言
    // `canary 必须先打开 Automations 页面` 失败、case 漏记 failed）。现在按产品配置面预置
    // 一个可用 provider + workspace 会话（e2eAppConfigSeed，与 e2e suite 同一产品路径），
    // 首屏直达主界面——tab canary 成为可满足的真实断言（production 无 env 门 → channel
    // 未注册 → capability 挂起 → tab 缺席）。
    const repo = await createGitRepoFixture(run, { name: "regression-origin" });
    const seed = await spawnCaptured(
      run,
      "seed-app-config",
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/services/test/continuous/e2eAppConfigSeed.ts",
        "--data-dir",
        run.dirs.data,
        "--home-dir",
        run.dirs.home,
        // regression 实例不发模型请求：provider 指向不可路由占位地址即可（可用性判定只看
        // 配置在不在，不发网络探测）。
        "--provider-base-url",
        "http://127.0.0.1:9/v1",
        "--workspace-path",
        repo.dir,
      ],
      { cwd: REPO_ROOT, quiet: true },
    );
    assert.equal(seed.exitCode, 0, "应用配置种子必须成功（产品 codec 校验）");

    // 真实访问：普通 production build + 只有 ZCODE_ENV=test（无双重测试标识）。
    const plainEnv = buildIsolationEnv(run, {
      userDataDir: path.join(run.dirs.electronUserData, "plain"),
      appNameSuffix: " Plain",
    });
    const app = await launchDesktop(run, {
      env: { ...process.env, ...plainEnv },
      quiet: true,
    });
    try {
      const window = await waitForFirstWindow(app.electron, 60_000);
      const probe = await probeE2EBridge(window);
      await evidence.screenshot(window, "production-bridge-probe");
      await evidence.record("production-bridge-probe.json", probe);
      assert.equal(
        probe.bridgeExposed,
        false,
        "production build + ZCODE_ENV=test（无双重测试标识）不得暴露测试桥",
      );
      // 窗口就绪预检（CT-15 修复）：等待首屏形态再真实导航，欢迎页不再吞掉 canary。
      const navigation = await openAutomationsPage(window, 90_000);
      const tabPresent =
        navigation.navigated &&
        (await window.locator('[data-testid="automations-page-tab-continuous"]').count()) > 0;
      await evidence.record("continuous-tab-probe.json", {
        tabPresent,
        navigated: navigation.navigated,
        shellState: navigation.shellState,
        reason: navigation.reason ?? null,
      });
      await evidence.screenshot(window, "production-automations");
      run.recordCheck("production-continuous-default-off", navigation.navigated && !tabPresent, {
        detail: navigation.navigated
          ? tabPresent
            ? "tab 出现（默认关闭被破坏）"
            : "已导航至 automations 页，tab 缺席 = 默认关闭"
          : `导航未完成: ${navigation.reason}`,
      });
      // 默认关闭 canary（规格 §13）：production build 上 Continuous tab 必须缺席。
      // 将来正式开启功能时，此断言应随装配 consciously 更新，而不是默默失效。
      assert.equal(
        navigation.navigated,
        true,
        `canary 必须先打开 Automations 页面: ${navigation.reason}`,
      );
      assert.equal(tabPresent, false, "production build 上 Continuous 必须默认关闭（tab 缺席）");
      recordCase(run, {
        caseId: "E-28",
        status: "passed",
        sourceCommit,
        command: "node scripts/test-continuous.mjs --suite regression",
        assertions: [
          "VITE_ZCODE_E2E_STORE_BRIDGE=0 的 production build：ZCODE_ENV=test 无双重测试标识 → bridge 不暴露（真实 Electron 探针）",
          "测试专用符号（barrier/controllable clock/scripted provider/配置种子）不出现在 main/host/preload/renderer bundle",
          "真实导航至 Automations 页后 Continuous tab 缺席（production 无装配 env → capability 门，默认关闭）",
        ],
        evidence: evidence.list(),
        failureReason: null,
      });
      t.diagnostic("E-28 production 半边通过（bridge build + run ID 正向半边在 e2e suite）");
    } finally {
      await app.electron.close().catch(() => {});
      app.closeLog();
    }
  } catch (error) {
    // 修复依据（本 ticket）：E-28 的断言失败曾被 runner 漏记（entryReport 显示 passed 而
    // Node 退出码 1）。失败必须先落 failed 记录与证据，再原样上抛——报告与退出码一致。
    recordCaseFailure(run, {
      caseId: "E-28",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite regression",
      error,
      evidence: evidence.list(),
    });
    throw error;
  }
});

test("E-27: 关闭与回滚——停止链语义重跑 + 回滚顺序文档在场", async () => {
  const evidence = createCaseEvidence(run, "E-27");
  try {
    const recovery = await spawnCaptured(
      run,
      "recovery-tests",
      process.execPath,
      ["--import", "tsx", "--test", "packages/services/test/continuous/recovery.test.ts"],
      { cwd: REPO_ROOT, quiet: true },
    );
    console.log(`[regression] recovery-tests exit=${recovery.exitCode} log=${recovery.logFile}`);
    await evidence.record("recovery-tests.json", {
      command: "node --import tsx --test packages/services/test/continuous/recovery.test.ts",
      exitCode: recovery.exitCode,
      logFile: recovery.logFile,
    });
    assert.equal(recovery.exitCode, 0, "停止链（interruptCyclesForShutdown/立即停止）语义必须保持");

    const releaseDoc = path.join(REPO_ROOT, "docs", "release", "continuous.md");
    const docText = await readFile(releaseDoc, "utf8");
    const hasRollbackOrder =
      /1[.、]\s*停止调度与唤醒/.test(docText) && /保留.*DB|DB.*保留/.test(docText);
    await evidence.record("rollback-doc.json", {
      path: releaseDoc,
      hasRollbackOrder,
    });
    assert.ok(hasRollbackOrder, "docs/release/continuous.md 必须包含有序回滚步骤与数据保留规则");

    recordCase(run, {
      caseId: "E-27",
      status: "passed",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite regression",
      assertions: [
        "recovery suite 重跑通过（正常退出保存 interrupted、立即停止撤销→取消→等待停止、用户取消不自动恢复）",
        // 修复依据：「production build 上 Continuous 默认关闭」的证据由 E-28 的
        // checks.production-continuous-default-off 独家记录（导航成功才有 tab 缺席证据；
        // 欢迎页阻挡时该 check 为 false，E-27 不得在未取到证据时随 E-26 一并声称通过）。
        "docs/release/continuous.md 含有序回滚步骤与「保留 DB/worktree/历史」规则",
      ],
      evidence: evidence.list(),
      failureReason:
        "「历史/分支/提交/用户文件保留」的完整停机取证（真实在飞 Cycle 上的关闭演练）需 Host 装配后由 e2e suite 驱动",
    });
  } catch (error) {
    recordCaseFailure(run, {
      caseId: "E-27",
      sourceCommit,
      command: "node scripts/test-continuous.mjs --suite regression",
      error,
      evidence: evidence.list(),
    });
    throw error;
  }
});

test("regression suite 汇总：failed 必须为 0（blocked 如实记录，§10 退出码语义）", () => {
  const summary = caseSummary(run);
  console.log(`[regression] case summary: ${JSON.stringify(summary)}`);
  // 修复依据：blocked 是证据不可得的如实状态（如 E-28 tab canary 受欢迎页阻挡），
  // 不是 runner 失败（§10 退出码语义）；把 blocked 编码成非零退出会让无凭据隔离环境
  // 的 regression 永远无法通过门禁。blocked 经 writeReport 写入报告由 release gate 消费。
  assert.equal(summary.failed, 0, `failed 用例: ${summary.failed}`);
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
