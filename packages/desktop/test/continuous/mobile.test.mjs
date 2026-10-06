#!/usr/bin/env node
// CT-15 手机控制与两种交付语义（suite 入口；docs/testing/continuous.md §4 步骤 E）。
//
// 手机链路是「浏览器真实连接桌面同一 Host 的 replayable attachment」，不能用 desktop
// renderer 缩成 390px 代替（测试文档 §4 步骤 E）。浏览器可执行文件由环境显式提供
//（ZCODE_E2E_BROWSER_PATH）；不可用时如实标 blocked，不伪造手机链路结果。
//
// CT-15 真实性核对结论（本 ticket 逐项调查，证据见 preflight JSON 与 checks）：
// 1. 手机 → 桌面 Host 的连接经**外部 relay**（鉴权/配对/心跳/转发，AGENTS.md「外部
//    relay 与 Main 只做…转发及 attachment 调度」）。仓库内没有可本地启动的 relay 服务
//    实现（packages/server 的 remote/* 是 SSH/Docker 远程 workspace，非手机链路）；
//    连接真实 relay 需要个人账号凭据——测试文档 §3/§4 明确禁止输入个人凭据。
//    因此「隔离环境创建测试 attachment」当前不可构造，E-21 如实 blocked，不用
//    renderer 缩 390px 冒充（那是两项独立验收）。
// 2. 已能真实取证的桌面侧事实（relayed 语义的唯一本地证据面）：
//    - 两种交付语义在共享协议里是显式区分的枚举（desktop-continuous ≠ web-remote-replayable，
//      shared task-realtime/任务 clientMode）；手机（replayable）面被产品代码明确收窄
//      （conversationShareAttachmentService：web-remote-replayable 模式 publish/importShare
//      结构化 feature_disabled，getImportedConversation 返回 null——只读补状态语义）。
//    - Continuous 快照/命令面（手机消费同一 snapshot 读面）在 e2e suite 已真实驱动。
// 这些是 grep/源码事实（随证据落盘），不声称手机链路通过。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
    parentRunId: args.parentRunId,
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

  // 桌面侧源码事实（不是手机链路通过的证据；是 blocked 理由的可核对依据）：
  // 1) 两种 clientMode 是共享协议的显式枚举；2) 手机模式的能力收窄在产品代码里。
  const attachmentService = await readFile(
    path.join(REPO_ROOT, "packages/desktop/src/host/conversationShareAttachmentService.ts"),
    "utf8",
  );
  const modeVocabulary = await readFile(
    path.join(REPO_ROOT, "packages/shared/src/task-realtime.ts"),
    "utf8",
  );
  const facts = {
    browserAvailable,
    executable: executable ?? null,
    clientModesDistinct: modeVocabulary.includes('"web-remote-replayable"'),
    mobileShareGated:
      attachmentService.includes('kind: "feature_disabled"') &&
      attachmentService.includes("web-remote-replayable"),
    relayLocalImplementation: false,
  };
  await evidence.record("mobile-preflight.json", facts);
  assert.equal(
    facts.clientModesDistinct,
    true,
    "desktop-continuous 与 web-remote-replayable 必须是显式区分的协议枚举",
  );
  assert.equal(
    facts.mobileShareGated,
    true,
    "手机（replayable）模式必须被产品代码明确收窄（feature_disabled）",
  );

  const reason = !browserAvailable
    ? "手机浏览器不可用：未提供 ZCODE_E2E_BROWSER_PATH 指向的可执行文件（平台不可用标 blocked）"
    : "浏览器可用，但手机→桌面 Host 的连接经外部 relay（鉴权/配对）：仓库内无可本地启动的 relay 实现（packages/server remote/* 为 SSH/Docker 远程 workspace，非手机链路），连接真实 relay 需个人账号凭据（测试文档 §3/§4 禁止输入）——隔离 attachment 不可构造，断线重连/缺口补发/重复回答无法真实驱动；不用 desktop renderer 缩 390px 冒充";
  recordCase(run, {
    caseId: "E-21",
    status: "blocked",
    sourceCommit,
    command: "node scripts/test-continuous.mjs --suite mobile",
    assertions: [
      "两种交付语义为共享协议显式枚举（desktop-continuous ≠ web-remote-replayable）——源码事实",
      "手机（replayable）模式产品能力收窄在 attachment service（publish/importShare feature_disabled、getImportedConversation 只读 null）——源码事实",
    ],
    failureReason: reason,
    evidence: evidence.list(),
  });
  t.skip(`blocked: ${reason}`);
});

test("mobile suite 汇总：failed 必须为 0（blocked 如实记录，§10 退出码语义）", () => {
  const summary = caseSummary(run);
  console.log(`[mobile] case summary: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0);
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
