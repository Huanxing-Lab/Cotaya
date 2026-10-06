#!/usr/bin/env node
// CT-16 真实打包 app 验收（suite 入口；docs/tickets/continuous-release-gaps.md CT-16、
// docs/testing/continuous.md §4 步骤 F/G 的打包平台项）。
//
// 在 electron-builder 产物（unpacked .app，真实打包形态：app.asar + resources/glm）内重复
// 暂停/退出/恢复/停止/本地提交（构建链见 packagedBuild.mjs 文件头），并取证生产形态无
// 测试故障接口（E-28 打包半边）。用例全部复用 e2e 的真实驱动面（稳定 test id + 只读
// SQL facts + provider 计数/Git 事实），只是宿主从 out/main/index.js（unpackaged）换成
// 打包产物内的可执行文件——同一产品链路，打包形态重复。
//
// 退出码语义（§10）：failed>0 → 非零；blocked 如实传播、exit 0，由 release gate 消费。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPO_ROOT,
  caseSummary,
  createTestRun,
  finalizeTestRun,
  recordCase,
  recordCaseFailure,
  stopRunResources,
} from "./runner.mjs";
import { readContinuousDbFacts } from "./continuousDriver.mjs";
import { probeE2EBridge } from "./runnerElectron.mjs";
import { setupPackaged } from "./packagedSetup.mjs";

const PACKAGED_CASE_IDS = ["PK-01", "E-34", "E-01", "E-02", "E-15", "E-16", "E-11", "E-17", "E-28"];

function parseArgs(argv) {
  const parsed = {
    skipDesktopBuild: false,
    skipCliBuild: false,
    skipPackage: false,
    parentRunId: null,
    reportFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-desktop-build") parsed.skipDesktopBuild = true;
    else if (arg === "--skip-cli-build") parsed.skipCliBuild = true;
    else if (arg === "--skip-package") parsed.skipPackage = true;
    else if (arg === "--parent-run-id") parsed.parentRunId = argv[(index += 1)];
    else if (arg === "--report-file") parsed.reportFile = argv[(index += 1)];
    else {
      console.error(`[packaged] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .toString()
  .trim();
const workingTreeDiff = execFileSync("git", ["status", "--short"], { cwd: REPO_ROOT })
  .toString()
  .trim();
const run = createTestRun({ suiteLabel: "packaged", parentRunId: args.parentRunId });
run.recordCheck("source-tree", true, {
  sourceCommit,
  workingTreeDiff,
  nodeVersion: process.version,
  platform: `${process.platform}/${process.arch}`,
});
const COMMAND = "node scripts/test-continuous.mjs --suite packaged";

async function writeReport(statusOverride) {
  await finalizeTestRun(run, { sourceCommit, cleanOnSuccess: true });
  const summary = caseSummary(run);
  const payload = {
    suite: "packaged",
    testRunId: run.testRunId,
    parentRunId: run.parentRunId,
    sourceCommit,
    workingTreeDiff,
    nodeVersion: process.version,
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
  console.log(`[packaged] artifacts root: ${run.root}`);
  return payload;
}

let context;
try {
  context = await setupPackaged(run, args);
} catch (error) {
  run.recordCheck("setup", false, String(error));
  for (const caseId of PACKAGED_CASE_IDS) {
    recordCase(run, {
      caseId,
      status: "blocked",
      sourceCommit,
      failureReason: `runner 预检失败（打包构建/启动/种子/就绪）: ${String(error?.message ?? error)}`,
    });
  }
  await writeReport("failed");
  await stopRunResources(run);
  throw error;
}

const ctx = {
  run,
  window: context.window,
  app: context.app,
  repo: context.repo,
  provider: context.provider,
  dbFacts: () => readContinuousDbFacts(run.dirs.data),
  sourceCommit,
};

// 用例串行（共享同一打包实例的 UI 视图；与 e2e 同一纪律）。
let serialChain = Promise.resolve();
function queuedTest(name, fn) {
  test(name, (t) => {
    const attempt = () => fn(t);
    const outcome = serialChain.then(attempt, attempt);
    serialChain = outcome.catch(() => {});
    return outcome;
  });
}

async function guardedCase(caseId, fn) {
  try {
    return await fn();
  } catch (error) {
    recordCaseFailure(run, { caseId, sourceCommit, command: COMMAND, error });
    throw error;
  }
}

queuedTest("PK-01 打包产物与生产形态", async () => {
  const result = await guardedCase("PK-01", async () => {
    const { createCaseEvidence } = await import("./evidence.mjs");
    const evidence = createCaseEvidence(run, "PK-01");
    const bridge = await probeE2EBridge(ctx.window);
    await evidence.screenshot(ctx.window, "packaged-main");
    await evidence.record("packaged-form.json", {
      appPath: context.packaged.appPath,
      productName: context.packaged.productName,
      bridgeProbe: bridge,
    });
    return { evidence, bridge };
  });
  recordCase(run, {
    caseId: "PK-01",
    status: "passed",
    sourceCommit,
    command: COMMAND,
    assertions: [
      "electron-builder 产物（unpacked .app）在场：app.asar + Contents/Resources/glm/zcode.cjs",
      "随包 agent 指纹 == 本次 CLI 构建指纹（checks.packaged-agent-fingerprint）",
      "打包实例 capability ready（Continuous tab 在场）——打包形态装配链路真实可用",
    ],
    evidence: result.evidence.list(),
    failureReason: null,
  });
});

queuedTest("E-28 生产测试桥关闭（打包半边）", async () => {
  const result = await guardedCase("E-28", async () => {
    const { createCaseEvidence } = await import("./evidence.mjs");
    const evidence = createCaseEvidence(run, "E-28");
    const bridge = await probeE2EBridge(ctx.window);
    await evidence.record("packaged-bridge-probe.json", bridge);
    assert.equal(
      bridge.bridgeExposed,
      false,
      "打包生产形态不得暴露测试桥（run ID 在场、build flag 缺席）",
    );
    return { evidence, bridge };
  });
  recordCase(run, {
    caseId: "E-28",
    status: "passed",
    sourceCommit,
    command: COMMAND,
    assertions: [
      "打包生产构建（renderer 不带 VITE_ZCODE_E2E_STORE_BRIDGE）+ 运行期 ZCODE_E2E_RUN_ID 在场：bridge 不暴露",
      "测试桥不因 run ID 单独在场而开放（双条件；打包形态复核）",
    ],
    evidence: result.evidence.list(),
    failureReason:
      "打包半边为负向探针（run ID 在场、build flag 缺席）；正向双条件半边由 e2e suite 出证（bridge build + run ID）",
  });
});

queuedTest("E-34 表单默认值（打包形态重复）", async () => {
  await guardedCase("E-34", () =>
    import("./e2eCases.mjs").then((m) => m.caseFormDefaultsAndPrecision(ctx)),
  ).then((result) => {
    recordCase(run, {
      caseId: "E-34",
      status: "passed",
      sourceCommit,
      command: COMMAND,
      assertions: [
        "打包实例创建表单默认值 = 产品常量（USD1000/USD100/10亿 tokens/并发10/1 小时）",
        "超出安全整数的输入被表单拒绝且不创建 Program；默认创建按微美元整数落库",
      ],
      evidence: result.evidence.list(),
      failureReason: null,
    });
  });
});

queuedTest("首轮链：E-01/E-02/E-15/E-16（打包形态重复，含本地提交边界）", async () => {
  const facts = await ctx.dbFacts();
  const created = facts.programs.find((row) => row.goal === "e2e-default-budget-program");
  assert.ok(created, "E-34 的 Program 必须在场（用例顺序依赖）");
  const result = await guardedCase("E-01", () =>
    import("./e2eCycles.mjs").then((m) => m.caseFirstCycleChain(ctx, { programId: created.id })),
  );
  for (const caseId of ["E-01", "E-02", "E-15", "E-16"]) {
    recordCase(run, {
      caseId,
      status: "passed",
      sourceCommit,
      command: COMMAND,
      assertions: [
        `${caseId}：打包 app 内经真实 UI→Host→CLI→provider 链路完成（与 e2e suite 同一断言集，宿主为打包产物）`,
      ],
      evidence: result.evidences[caseId].list(),
      failureReason:
        caseId === "E-01"
          ? "本地提交边界：无验证通过的候选时零本地提交（提交门 fail closed）。正向本地提交链需要授权面的声明测试命令（第一版为空，CT-12 已知限制 3），如实未驱动"
          : null,
    });
  }
});

queuedTest("E-11 Pause 与立即停止（打包形态重复）", async () => {
  await guardedCase("E-11", () =>
    import("./e2eCycles.mjs").then((m) => m.casePauseAndStop(ctx)),
  ).then((result) => {
    recordCase(run, {
      caseId: "E-11",
      status: "passed",
      sourceCommit,
      command: COMMAND,
      assertions: [
        "Pause（静止态）：Program paused、零新 Cycle；Resume 恢复 active",
        "立即停止本轮：在飞 Cycle cancelled、Program paused（撤销→取消→等待停止）",
      ],
      evidence: result.evidence.list(),
      failureReason: null,
    });
  });
});

queuedTest("E-17 退出与重启恢复（打包形态）", async () => {
  await guardedCase("E-17", () =>
    import("./packagedQuitCase.mjs").then((m) =>
      m.caseQuitAndRestartRecovery(ctx, {
        env: { ...process.env, ...context.appEnv },
        executablePath: context.packaged.executablePath,
      }),
    ),
  ).then((result) => {
    recordCase(run, {
      caseId: "E-17",
      status: "passed",
      sourceCommit,
      command: COMMAND,
      assertions: [
        "正常退出（窗口关闭→产品退出链）：在飞 Cycle 保存 interrupted，执行身份不变",
        "同数据根重启：Host 启动核对先处理旧轮——同 Cycle/同 Run 恢复至 completed，无第二个 Cycle/执行者",
        "恢复真实重放模型请求（provider 计数增加）",
      ],
      evidence: result.evidence.list(),
      failureReason:
        "强杀半边（R 屏障 SIGKILL 注入）未驱动：需要传输级注入面（e2e 同名 blocked 理由），不伪造",
    });
  });
});

queuedTest("packaged suite 汇总：failed 必须为 0（blocked 如实记录，§10）", () => {
  const summary = caseSummary(run);
  console.log(`[packaged] case summary: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0, `failed 用例: ${summary.failed}`);
  assert.equal(summary.planned, 0, `planned 用例: ${summary.planned}（用例没有结论）`);
  assert.ok(summary.blocked + summary.passed > 0, "没有任何用例结论时 suite 不能通过");
});

after(async () => {
  await writeReport();
  await stopRunResources(run);
});
