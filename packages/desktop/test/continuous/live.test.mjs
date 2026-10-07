#!/usr/bin/env node
// CT-09 真模型验收（suite 入口；docs/testing/continuous.md §3「真实模型」/§4 步骤 F）。
//
// live 默认不运行：CT-00 runner 已要求显式 --allow-live 才会启动本入口；入口内再自查一次
//（defense in depth）。使用显式测试 provider 配置与有限额度，不读取生产凭据；
// 没有已配置的测试身份（ZCODE_E2E_LIVE_PROVIDER_KEY）时如实标 blocked——
// 不能由 agent 输入个人密码/OTP/API key，也不能用模拟通过替代（CT-10 验收同样要求）。
//
// live 结果单独汇总：至少执行真实 E-01/E-03/E-04（生成候选、修改 fixture、运行测试、
// 验证目标页面、完成 Review、本地提交）。输出波动时记录实际失败，不重跑直到成功。

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
  stopRunResources,
} from "./runner.mjs";
import { createCaseEvidence } from "./evidence.mjs";

const LIVE_CASE_IDS = ["E-01", "E-03", "E-04"];

function parseArgs(argv) {
  const parsed = { allowLive: false, parentRunId: null, reportFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-live") parsed.allowLive = true;
    else if (arg === "--parent-run-id") parsed.parentRunId = argv[(index += 1)];
    else if (arg === "--report-file") parsed.reportFile = argv[(index += 1)];
    else {
      console.error(`[live] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .toString()
  .trim();
const run = createTestRun({ suiteLabel: "live", parentRunId: args.parentRunId });

async function writeReport(statusOverride) {
  await finalizeTestRun(run, { sourceCommit, cleanOnSuccess: true });
  const summary = caseSummary(run);
  const payload = {
    suite: "live",
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
  console.log(`[live] artifacts root: ${run.root}`);
  return payload;
}

test("live 准入与测试身份检查", async (t) => {
  const evidence = createCaseEvidence(run, "live-preflight");
  if (!args.allowLive) {
    // CT-00 runner 已拦截；这里兜底再拒绝一次，保证入口单独被执行时也不会消费。
    const reason = "live suite 需要显式 --allow-live，已拒绝启动";
    for (const caseId of LIVE_CASE_IDS) {
      recordCase(run, { caseId, status: "blocked", sourceCommit, failureReason: reason });
    }
    await writeReport("blocked");
    await stopRunResources(run);
    t.skip(`blocked: ${reason}`);
    return;
  }
  const providerKeyPresent = Boolean(process.env.ZCODE_E2E_LIVE_PROVIDER_KEY?.trim());
  run.recordCheck("live-provider-identity", providerKeyPresent, "ZCODE_E2E_LIVE_PROVIDER_KEY");
  await evidence.record("live-preflight.json", {
    allowLive: true,
    providerKeyPresent,
    note: "真模型链路依赖 Host 装配（capability blocked，同 e2e suite 预检结论）；装配后在此驱动真实 E-01/E-03/E-04",
  });
  const reason = providerKeyPresent
    ? "测试身份已配置，但 Continuous channel 未在 Electron Host 装配；真实模型链路无法驱动，标 blocked"
    : "无已配置的测试身份（ZCODE_E2E_LIVE_PROVIDER_KEY）；没有凭据时真模型验收 blocked，不能替代为模拟通过";
  for (const caseId of LIVE_CASE_IDS) {
    recordCase(run, {
      caseId,
      status: "blocked",
      sourceCommit,
      executionKind: "live",
      command: "node scripts/test-continuous.mjs --suite live --allow-live",
      failureReason: reason,
      evidence: evidence.list(),
    });
  }
  t.skip(`blocked: ${reason}`);
});

test("live suite 汇总：failed 必须为 0（blocked 如实记录，§10 退出码语义）", () => {
  // CT-16 修复依据（docs/testing/continuous.md §10）：旧断言要求 blocked===0，使「无已配置
  // 测试身份 → 如实 blocked」被折叠成 Node 非零（failed）——entryReport 状态 blocked 与
  // 退出码 1 矛盾，还会触发编排层 CT-15 的不一致守卫。§10 明确 blocked 不是失败：凭据
  // 不可用时 runner 如实记 blocked、退出码 0，由 release gate（步骤 G）消费 blocked 并
  // 保持自主实施 flag 关闭。failed/planned 仍必须为 0（真失败与无结论不允许静默）。
  const summary = caseSummary(run);
  console.log(`[live] case summary: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0);
  assert.equal(summary.planned, 0, "planned 用例（没有结论）不允许");
  assert.ok(summary.blocked + summary.passed > 0, "没有任何用例结论时 suite 不能通过");
});

after(async () => {
  await writeReport();
  await stopRunResources(run);
});
