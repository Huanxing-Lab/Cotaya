// CT-09 真实 E2E runner 核心（docs/tickets/continuous.md CT-09、docs/testing/continuous.md §2/§4）。
//
// 职责：
// - 每次执行新建 testRunId 与系统临时根（os.tmpdir，跨平台不硬编码个人路径）；
//   所有路径型环境变量在生效前校验「解析后（realpath）仍在临时根内」——只设置环境变量
//   不足以证明隔离（测试文档 §2）。
// - 实际构建当前 CLI（scripts/build-desktop-agent-cli.mjs），对暂存 bundle 计算
//   build fingerprint（sha256），并在 Electron 就绪时核对 Host 实际加载的二进制指纹——
//   成功编译不等于已加载新版本（测试文档 §4 步骤 D 第 2/10 条）。
// - 进程登记与清理只作用于本次 testRunId 自己 spawn 的子进程；不按进程名杀 Electron/Node。
// - suite 级标准报告（manifest.json + results.json），case 结果只有
//   passed/failed/blocked/skipped/planned（§10），失败保留 artifact，成功清理临时数据但保留报告。
//
// 本文件只做编排；Electron 启动/就绪在 runnerElectron.mjs（行数上限拆分，非边界变化）。

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  quoteArgsForWindowsShell,
  resolveSpawnRuntimeOptions,
} from "../../../../scripts/spawn-command.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DESKTOP_ROOT = path.join(REPO_ROOT, "packages/desktop");
// Host（unpackaged）解析 agent 的第一候选：zcodeAgentProcessManager 的 findUpward dist 入口。
export const AGENT_DIST_BUNDLE = path.join(REPO_ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs");

export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** realpath 目标或最近存在祖先（目标可能尚未创建，macOS /tmp → /private/tmp 也在这里归一）。 */
export function realPathOfNearestAncestor(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** 校验 candidate（按 realpath 解析后）位于 root 内；越界抛错并带两个真实路径，供证据使用。 */
export function assertInsideRoot(root, candidate, label) {
  const rootReal = realpathSync(root);
  const candidateReal = realPathOfNearestAncestor(candidate);
  const relative = path.relative(rootReal, candidateReal);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `[isolation] ${label} 解析路径越出临时根: candidate=${candidateReal} root=${rootReal}`,
    );
  }
  return candidateReal;
}

/**
 * 每次执行新建隔离 testRun。目录规划按测试文档 §2：
 * 临时根/<testRunId>/{data,electron-user-data,repositories,target-app,artifacts/cases}。
 */
export function createTestRun({ suiteLabel, parentRunId = null }) {
  const testRunId = randomUUID();
  const root = realpathSync(
    mkdtempSync(path.join(realpathSync(os.tmpdir()), `continuous-ct09-${suiteLabel}-`)),
  );
  const dirs = {
    data: path.join(root, "data"),
    home: path.join(root, "data", "home"),
    electronUserData: path.join(root, "electron-user-data"),
    repositories: path.join(root, "repositories"),
    targetApp: path.join(root, "target-app"),
    artifacts: path.join(root, "artifacts"),
    cases: path.join(root, "artifacts", "cases"),
    logs: path.join(root, "artifacts", "logs"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const run = {
    suiteLabel,
    testRunId,
    parentRunId,
    root,
    dirs,
    startedAt: Date.now(),
    children: [],
    cleanupFns: [],
    cases: new Map(),
    checks: [],
    closed: false,
  };
  run.assertInsideRoot = (candidate, label) => assertInsideRoot(run.root, candidate, label);
  run.recordCheck = (id, passed, detail) => {
    run.checks.push({ id, passed, detail });
  };
  return run;
}

/**
 * 隔离环境变量 + 「测试桥双重条件」。
 * 故障注入/只读检查接口只经 test composition 注入（fixtures/进程控制在本 runner 内），
 * 产品侧唯一入口是既有 e2e bridge：VITE_ZCODE_E2E_STORE_BRIDGE（build flag）
 * + ZCODE_E2E_RUN_ID（非空 run ID），缺一不可（packages/shared/src/e2e-test-bridge.ts）。
 * bridgeRunId 为空时拒绝开启 bridge——不允许只凭 ZCODE_ENV=test 扩大 renderer 可读面。
 */
export function buildIsolationEnv(
  run,
  { bridgeRunId = "", userDataDir = run.dirs.electronUserData, appNameSuffix = "" } = {},
) {
  const env = {
    ZCODE_ENV: "test",
    ZCODE_DATA_BASE_DIR: run.dirs.data,
    ZCODE_DESKTOP_HOME_DIR: run.dirs.home,
    ZCODE_DESKTOP_APPLICATION_NAME: `Cotaya Continuous E2E ${run.testRunId.slice(0, 8)}${appNameSuffix}`,
    ZCODE_DESKTOP_USER_DATA_DIR: userDataDir,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(userDataDir, "session"),
    ZCODE_E2E_RUNTIME_LOG_DIR: run.dirs.logs,
    // playwright 自管远程调试端口；不与开发态 9229 抢占（desktop main/index.ts 同名开关）。
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  };
  if (bridgeRunId) {
    env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
    env.ZCODE_E2E_RUN_ID = bridgeRunId;
  }
  // 只设一个环境变量不足以证明隔离：逐个校验路径型变量的最终解析路径都在临时根内。
  for (const name of [
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_DESKTOP_HOME_DIR",
    "ZCODE_DESKTOP_USER_DATA_DIR",
    "ZCODE_DESKTOP_SESSION_DATA_DIR",
    "ZCODE_E2E_RUNTIME_LOG_DIR",
  ]) {
    run.assertInsideRoot(env[name], name);
  }
  return env;
}

export async function sha256File(file) {
  const buffer = await readFile(file);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}

/**
 * 构建当前 CLI 并计算 build fingerprint。
 * 必须走 scripts/build-desktop-agent-cli.mjs（测试文档 §4 步骤 D 第 2 条），产物会经
 * stage-agent-bundle.mjs 暂存到 packages/desktop/bundled-agents/<platform>/glm/zcode.cjs——
 * dev 态 Host 解析 agent 二进制的候选只有 bundled-agents/，不存在误用旧 cli/dist 的路径。
 */
export async function buildAgentCli(run, { log = console.log } = {}) {
  const startedAt = Date.now();
  const result = await spawnCaptured(
    run,
    "build-cli",
    process.execPath,
    ["scripts/build-desktop-agent-cli.mjs"],
    { cwd: REPO_ROOT },
  );
  if (result.exitCode !== 0) {
    throw new Error(`[runner] CLI 构建失败 exit=${result.exitCode}（日志: ${result.logFile}）`);
  }
  const staged = path.join(DESKTOP_ROOT, "bundled-agents", platformKey(), "glm", "zcode.cjs");
  if (!existsSync(staged)) {
    throw new Error(`[runner] 构建后未找到暂存 agent bundle: ${staged}`);
  }
  const fingerprint = { ...(await sha256File(staged)), stagedBundlePath: staged };
  const info = await stat(staged);
  if (info.mtimeMs < startedAt - 2_000) {
    // 暂存文件比本次构建旧：说明构建脚本复用了旧产物（ZCODE_BOOTSTRAP_WITH_REMOTE 的 reuse 分支）。
    // 如实记录，不静默当作新构建（readiness 仍会核对 Host 实际加载的指纹）。
    log(`[runner] 注意: 暂存 bundle mtime 早于本次构建（复用构建缓存）`);
  }
  run.recordCheck("cli-build-fingerprint", true, { staged, ...fingerprint });
  return { staged, fingerprint, builtAt: info.mtimeMs };
}

/**
 * desktop 生产构建（main/host/preload/renderer），复用既有脚本：
 * ensure-local-runtime-assets → build-metadata → run-production-build.mjs。
 * renderer 构建带 VITE_ZCODE_E2E_STORE_BRIDGE=1（test build；生产构建不带该 flag，E-28）。
 * ZCODE_E2E_KEEP_BUILD_CACHE=1 时 run-production-build 跳过清空（沿用其既有语义）。
 * skipDesktopBuild=true 时只校验既有产物存在（由工作流预构建后复用）。
 */
export async function ensureDesktopBuild(run, { skipDesktopBuild = false } = {}) {
  const outDir = path.join(DESKTOP_ROOT, "out");
  const markers = [".main-build-ready", ".host-build-ready", ".preload-build-ready"].map((name) =>
    path.join(outDir, name),
  );
  if (skipDesktopBuild) {
    const missing = [
      ...markers.filter((marker) => !existsSync(marker)),
      ...(existsSync(path.join(outDir, "renderer")) ? [] : [path.join(outDir, "renderer")]),
    ];
    if (missing.length > 0) {
      throw new Error(`[runner] --skip-desktop-build 但 desktop 产物缺失: ${missing.join(", ")}`);
    }
    run.recordCheck("desktop-build", true, { reused: true });
    return { reused: true };
  }
  const buildEnv = {
    ...process.env,
    NODE_ENV: "production",
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
  };
  const steps = [
    ["ensure-runtime-assets", process.execPath, ["scripts/ensure-local-runtime-assets.mjs"]],
    ["build-metadata", process.execPath, ["scripts/build-metadata.mjs"]],
    ["production-build", process.execPath, ["scripts/run-production-build.mjs"]],
  ];
  for (const [label, command, args] of steps) {
    const result = await spawnCaptured(run, label, command, args, {
      cwd: DESKTOP_ROOT,
      env: buildEnv,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `[runner] desktop 构建 ${label} 失败 exit=${result.exitCode}（日志: ${result.logFile}）`,
      );
    }
  }
  const missing = markers.filter((marker) => !existsSync(marker));
  if (missing.length > 0 || !existsSync(path.join(outDir, "main", "index.js"))) {
    throw new Error(
      `[runner] desktop 构建后产物校验失败: ${missing.join(", ") || "out/main/index.js"}`,
    );
  }
  run.recordCheck("desktop-build", true, { reused: false });
  return { reused: false };
}

/** 登记并 spawn 子进程：输出 tee 到控制台与 artifacts/logs/<label>.log；只清理自己 spawn 的进程。 */
export function spawnCaptured(run, label, command, args, options = {}) {
  return new Promise((resolve) => {
    const runtimeOptions = resolveSpawnRuntimeOptions(command, process.platform);
    const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
    const logFile = path.join(run.dirs.logs, `${label}.log`);
    const stream = createWriteStream(logFile, { flags: "a" });
    const child = spawn(command, spawnArgs, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      ...runtimeOptions,
    });
    run.children.push({ label, child });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      stream.end();
      resolve({ ...payload, logFile });
    };
    const pump = (chunk) => {
      process.stdout.write(chunk);
      stream.write(chunk);
    };
    const pumpErr = (chunk) => {
      process.stderr.write(chunk);
      stream.write(chunk);
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pumpErr);
    child.on("error", (error) => finish({ exitCode: null, spawnError: String(error) }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

export function registerCleanup(run, fn) {
  run.cleanupFns.push(fn);
}

export function recordCase(run, entry) {
  const record = {
    caseId: entry.caseId,
    status: entry.status ?? "planned",
    executionKind: entry.executionKind ?? "scripted",
    sourceCommit: entry.sourceCommit ?? null,
    platform: `${process.platform}/${process.arch}`,
    command: entry.command ?? null,
    exitCode: entry.exitCode ?? null,
    assertions: entry.assertions ?? [],
    evidence: entry.evidence ?? [],
    failureReason: entry.failureReason ?? null,
    startedAt: entry.startedAt ?? Date.now(),
    finishedAt: Date.now(),
  };
  run.cases.set(entry.caseId, record);
  return record;
}

export function caseSummary(run) {
  const statuses = ["passed", "failed", "blocked", "skipped", "planned"];
  const summary = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const record of run.cases.values())
    summary[record.status] = (summary[record.status] ?? 0) + 1;
  return summary;
}

/** 停止本次 testRun 自己启动的全部子进程与资源（成功与失败路径都调用）。 */
export async function stopRunResources(run, { reason = "runner-finish" } = {}) {
  if (run.closed) return;
  run.closed = true;
  for (const cleanup of run.cleanupFns.splice(0).reverse()) {
    try {
      await cleanup(reason);
    } catch (error) {
      console.error(`[runner] cleanup 失败: ${String(error)}`);
    }
  }
  for (const { label, child } of run.children.splice(0)) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      console.error(`[runner] 停止子进程 ${label} 失败: ${String(error)}`);
    }
  }
}

/**
 * 写标准报告并按结果清理。失败（或有 blocked/failed case）保留整个临时根供取证；
 * 成功只删数据/fixture 目录，保留 artifacts（验收报告必须保留）。
 * 清理只作用于当前 testRunId 的目录，绝不按进程名或共享目录清理。
 */
export async function finalizeTestRun(run, { sourceCommit, cleanOnSuccess = false } = {}) {
  const finishedAt = Date.now();
  const summary = caseSummary(run);
  const ok = summary.failed === 0 && summary.blocked === 0 && summary.passed > 0;
  const results = {
    suite: run.suiteLabel,
    testRunId: run.testRunId,
    parentRunId: run.parentRunId,
    sourceCommit,
    platform: `${process.platform}/${process.arch}`,
    nodeVersion: process.version,
    startedAt: run.startedAt,
    finishedAt,
    checks: run.checks,
    summary,
    cases: [...run.cases.values()],
  };
  await writeFile(
    path.join(run.dirs.artifacts, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const manifest = {
    testRunId: run.testRunId,
    generatedAt: finishedAt,
    layout: {
      data: run.dirs.data,
      electronUserData: run.dirs.electronUserData,
      repositories: run.dirs.repositories,
      targetApp: run.dirs.targetApp,
      artifacts: run.dirs.artifacts,
    },
    files: {
      results: path.join(run.dirs.artifacts, "results.json"),
    },
  };
  await writeFile(
    path.join(run.dirs.artifacts, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (ok && cleanOnSuccess) {
    for (const dir of [
      run.dirs.data,
      run.dirs.electronUserData,
      run.dirs.repositories,
      run.dirs.targetApp,
    ]) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { ok, results, manifest };
}
