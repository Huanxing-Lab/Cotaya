#!/usr/bin/env node
// Continuous 统一测试入口（CT-00；docs/tickets/continuous.md、docs/testing/continuous.md）。
//
// 规则：
// - suite 使用显式 manifest 枚举（仓库相对路径），argv spawn，不依赖 shell glob/平台分隔符。
// - suite 空目录、无测试文件或 runner/entry 缺失：非零退出并标 `missing`，绝不打印通过。
// - 不吞子进程 exit code；任何 suite 非 passed 时整体非零。
// - live suite 必须显式 `--allow-live` 才能启动；`all` 恒排除 live，避免无意消费。
// - 结果状态只有 passed/failed/missing/blocked（用例级 planned/… 由各 suite runner 输出）。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// node-test suite：files 显式枚举 ts/tsx 测试文件（CT-01/CT-04/CT-07 逐步追加）。
// script suite：entry 为独立 runner 入口（CT-09 提供 desktop E2E/手机/live runner）。
// 空数组或缺文件在运行时判 missing，而不是在这里预填占位路径。
const SUITES = {
  unit: {
    description: "单元测试（U-01…U-08：契约、策略、纯领域规则）",
    kind: "node-test",
    files: [
      "packages/services/test/continuous/contract.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/continuous/scope.test.ts",
      "packages/ui/test/continuous/continuousFormat.test.ts",
    ],
  },
  integration: {
    description: "存储与工作区集成（I-01…I-11、I-12；真实 SQLite/Git/文件/子进程执行事实）",
    kind: "node-test",
    files: [
      "packages/services/test/continuous/repository.test.ts",
      "packages/services/test/continuous/workspace.test.ts",
      "packages/services/test/continuous/budget.test.ts",
      "packages/services/test/continuous/continuation.test.ts",
      "packages/services/test/continuous/health.test.ts",
      "packages/services/test/continuous/cycle.test.ts",
      "packages/services/test/continuous/decision.test.ts",
      "packages/services/test/continuous/scheduler.test.ts",
      "packages/services/test/continuous/commands.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/continuous/execution.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/continuous/budget-runtime.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/continuous/template.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/continuous/decision-runtime.test.ts",
    ],
  },
  recovery: {
    description: "崩溃与重启恢复（R-01…R-10；同库新实例模拟 kill，真实 SQLite）",
    kind: "node-test",
    files: ["packages/services/test/continuous/recovery.test.ts"],
  },
  e2e: {
    description: "真实 Electron + 脚本化模型 E2E（CT-09）",
    kind: "script",
    entry: "packages/desktop/test/continuous/e2e.test.mjs",
  },
  mobile: {
    description: "手机真实控制与重连（CT-09）",
    kind: "script",
    entry: "packages/desktop/test/continuous/mobile.test.mjs",
  },
  live: {
    description: "真模型验收（显式 opt-in；CT-09）",
    kind: "script",
    entry: "packages/desktop/test/continuous/live.test.mjs",
    requiresAllowLive: true,
  },
  platform: {
    description: "跨平台路径/取消/限制（CT-10 按平台追加）",
    kind: "node-test",
    files: [],
  },
  regression: {
    description: "普通 Workflow/Automation/Goal/权限回归（CT-09/CT-10 接入）",
    kind: "node-test",
    files: [],
  },
};

const ALL_EXCLUDED = ["live"];
const USAGE = `用法: node scripts/test-continuous.mjs --suite <name> [--allow-live] [--timeout-ms <n>]
suite: ${[...Object.keys(SUITES), "all"].join(", ")}
all = 除 live 外全部 suite（live 必须单独显式运行）`;

function parseArgs(argv) {
  const parsed = { suite: null, allowLive: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--suite") {
      parsed.suite = argv[index + 1];
      index += 1;
    } else if (arg === "--allow-live") {
      parsed.allowLive = true;
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`--timeout-ms 需要正整数，收到: ${argv[index + 1]}`);
      }
      parsed.timeoutMs = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  if (parsed.suite === undefined || parsed.suite === null)
    throw new Error(`缺少 --suite\n${USAGE}`);
  if (parsed.suite !== "all" && !(parsed.suite in SUITES)) {
    throw new Error(`未知 suite: ${parsed.suite}\n${USAGE}`);
  }
  return parsed;
}

function selectedSuites(suiteName) {
  if (suiteName === "all") {
    return Object.keys(SUITES).filter((name) => !ALL_EXCLUDED.includes(name));
  }
  return [suiteName];
}

function runChild(command, args, timeoutMs) {
  return new Promise((resolve) => {
    // 跨平台：不经 shell，全部走 argv；子进程输出直通，不吞 exit code。
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, spawnError: String(error) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : exitCode, timedOut });
    });
  });
}

async function runNodeTestSuite(name, definition, timeoutMs) {
  const files = definition.files.map((file) => path.join(repoRoot, file));
  const fileStatuses = definition.files.map((file) => ({
    file,
    status: existsSync(path.join(repoRoot, file)) ? "found" : "missing",
  }));
  const missingFiles = fileStatuses.filter((item) => item.status === "missing");
  if (definition.files.length === 0) {
    return {
      suite: name,
      kind: "node-test",
      status: "missing",
      exitCode: null,
      failureReason: "suite manifest 没有任何测试文件（空 suite 不是通过）",
      files: fileStatuses,
    };
  }
  if (missingFiles.length > 0) {
    return {
      suite: name,
      kind: "node-test",
      status: "missing",
      exitCode: null,
      failureReason: `manifest 条目不存在: ${missingFiles.map((item) => item.file).join(", ")}`,
      files: fileStatuses,
    };
  }
  const result = await runChild(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    timeoutMs,
  );
  if (result.timedOut) {
    return {
      suite: name,
      kind: "node-test",
      status: "failed",
      exitCode: null,
      failureReason: `suite 超时（>${timeoutMs}ms）被终止`,
      files: fileStatuses,
    };
  }
  if (result.spawnError) {
    return {
      suite: name,
      kind: "node-test",
      status: "missing",
      exitCode: null,
      failureReason: `无法启动 node 测试进程: ${result.spawnError}`,
      files: fileStatuses,
    };
  }
  return {
    suite: name,
    kind: "node-test",
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    failureReason: result.exitCode === 0 ? null : `测试进程退出码 ${result.exitCode}`,
    files: fileStatuses,
  };
}

async function runScriptSuite(name, definition, timeoutMs) {
  const entry = path.join(repoRoot, definition.entry);
  if (!existsSync(entry)) {
    return {
      suite: name,
      kind: "script",
      status: "missing",
      exitCode: null,
      failureReason: `runner 入口不存在: ${definition.entry}（由后续 ticket 提供）`,
      files: [{ file: definition.entry, status: "missing" }],
    };
  }
  const result = await runChild(process.execPath, [entry], timeoutMs);
  if (result.timedOut) {
    return {
      suite: name,
      kind: "script",
      status: "failed",
      exitCode: null,
      failureReason: `suite 超时（>${timeoutMs}ms）被终止`,
      files: [{ file: definition.entry, status: "found" }],
    };
  }
  if (result.spawnError) {
    return {
      suite: name,
      kind: "script",
      status: "missing",
      exitCode: null,
      failureReason: `无法启动 runner: ${result.spawnError}`,
      files: [{ file: definition.entry, status: "found" }],
    };
  }
  return {
    suite: name,
    kind: "script",
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    failureReason: result.exitCode === 0 ? null : `runner 退出码 ${result.exitCode}`,
    files: [{ file: definition.entry, status: "found" }],
  };
}

async function runSuite(name, timeoutMs, allowLive) {
  const definition = SUITES[name];
  if (definition.requiresAllowLive && !allowLive) {
    return {
      suite: name,
      kind: definition.kind,
      status: "blocked",
      exitCode: null,
      failureReason: "live suite 需要显式 --allow-live，已拒绝启动",
      files: [],
    };
  }
  return definition.kind === "node-test"
    ? runNodeTestSuite(name, definition, timeoutMs)
    : runScriptSuite(name, definition, timeoutMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testRunId = randomUUID();
  const startedAt = Date.now();
  const results = [];
  for (const name of selectedSuites(args.suite)) {
    // suite 顺序执行（unit → … → regression），失败不中断后续 suite，汇总统一判定。
    results.push(await runSuite(name, args.timeoutMs, args.allowLive));
  }
  const summary = {
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    missing: results.filter((item) => item.status === "missing").length,
    blocked: results.filter((item) => item.status === "blocked").length,
  };
  const report = {
    testRunId,
    command: `node scripts/test-continuous.mjs ${process.argv.slice(2).join(" ")}`,
    startedAt,
    finishedAt: Date.now(),
    suites: results,
    summary,
  };
  console.log(`\n[continuous] 标准报告 (testRunId=${testRunId})`);
  console.log(JSON.stringify(report, null, 2));
  const allPassed = summary.passed === results.length && results.length > 0;
  const childFailureCode = results.length === 1 ? (results[0].exitCode ?? 0) : 0;
  process.exit(allPassed ? 0 : childFailureCode > 0 ? childFailureCode : 1);
}

main().catch((error) => {
  console.error(`[continuous] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
