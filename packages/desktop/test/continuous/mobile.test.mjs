#!/usr/bin/env node
// CT-09 手机控制与两种交付语义（suite 入口；docs/testing/continuous.md §4 步骤 E）。
//
// 手机链路是「浏览器真实连接桌面同一 Host 的 replayable attachment」，不能用 desktop
// renderer 缩成 390px 代替（测试文档 §4 步骤 E）。浏览器可执行文件由环境显式提供
//（ZCODE_E2E_BROWSER_PATH）；不可用时如实标 blocked，不伪造手机链路结果。
//
// 当前边界（如实记录）：配对/attachment 创建依赖 Host 侧装配与 relay 链路驱动，
// Continuous channel 未装配时 E-21 的 Pause/Resolve 无法从手机侧驱动——blocked 而非通过。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPO_ROOT,
  caseSummary,
  createTestRun,
  finalizeTestRun,
  recordCase,
  stopRunResources,
} from "./runner.mjs";
import { createCaseEvidence } from "./evidence.mjs";

function parseArgs(argv) {
  const parsed = { parentRunId: null, reportFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--parent-run-id") parsed.parentRunId = argv[(index += 1)];
    else if (arg === "--report-file") parsed.reportFile = argv[(index += 1)];
    else {
      console.error(`[mobile] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .toString()
  .trim();
const run = createTestRun({ suiteLabel: "mobile", parentRunId: args.parentRunId });

function browserExecutable() {
  return process.env.ZCODE_E2E_BROWSER_PATH?.trim() || null;
}

async function writeReport(statusOverride) {
  await finalizeTestRun(run, { sourceCommit, cleanOnSuccess: true });
  const summary = caseSummary(run);
  const payload = {
    suite: "mobile",
    testRunId: run.testRunId,
    parentRunId: run.parentRunId,
    status:
      statusOverride ??
      (summary.blocked + summary.failed === 0 && summary.passed > 0 ? "passed" : "blocked"),
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.reportFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  console.log(`[mobile] artifacts root: ${run.root}`);
  return payload;
}

test("E-21 手机真实控制与重连（390px replayable）", async (t) => {
  const evidence = createCaseEvidence(run, "E-21");
  const executable = browserExecutable();
  const browserAvailable = Boolean(executable && existsSync(executable));
  run.recordCheck(
    "mobile-browser",
    browserAvailable,
    executable ?? "未设置 ZCODE_E2E_BROWSER_PATH",
  );
  await evidence.record("mobile-preflight.json", {
    browserAvailable,
    executable: executable ?? null,
    capabilityNote: "Continuous channel 未在 Electron Host 装配（同 e2e suite 预检结论）",
  });
  let reason;
  if (!browserAvailable) {
    reason =
      "手机浏览器不可用：未提供 ZCODE_E2E_BROWSER_PATH 指向的可执行文件（平台不可用标 blocked）";
  } else {
    reason =
      "浏览器可用，但配对/attachment 与 Continuous 控制链路依赖 Host 装配（capability blocked）；重连/重复命令断言无法真实驱动";
  }
  recordCase(run, {
    caseId: "E-21",
    status: "blocked",
    sourceCommit,
    command: "node scripts/test-continuous.mjs --suite mobile",
    failureReason: reason,
    evidence: evidence.list(),
  });
  t.skip(`blocked: ${reason}`);
});

test("mobile suite 汇总：blocked/failed 必须为 0", () => {
  const summary = caseSummary(run);
  console.log(`[mobile] case summary: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0);
  assert.equal(summary.blocked, 0);
  assert.ok(summary.passed > 0);
});

after(async () => {
  await writeReport();
  await stopRunResources(run);
});
