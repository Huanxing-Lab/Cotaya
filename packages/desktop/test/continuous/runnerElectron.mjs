// CT-09 Electron 启动与就绪（runner.mjs 的行数上限拆分；职责边界不变）。
//
// 启动：playwright-core 的 _electron API + 当前仓库构建的 out/main/index.js（unpackaged），
// cwd 固定 packages/desktop——desktopRuntimeEnv.resolveBundledZCodeAgentBinaryPath 的
// bundled-agents 候选按 cwd 解析，固定 cwd 让「Host 加载哪份 agent」可预测。
//
// 就绪不止等窗口出现（测试文档 §4 步骤 D 第 6 条）：
// 1. 等待首个窗口；
// 2. 等待 main 日志出现 `[spawnHostProcess] glm binary path: <path>`（desktopHostProcess.ts
//    在 fork host 前打印），对该文件计算 sha256 并与 buildAgentCli 的 fingerprint 比对——
//    这就是「实际加载的 build fingerprint」核对：编译成功 ≠ 已加载新版本；
// 3. probe 主窗口的 e2e bridge 暴露状态（双重条件是否命中）。

import { createWriteStream } from "node:fs";
import { sha256File, DESKTOP_ROOT } from "./runner.mjs";
import path from "node:path";

export async function resolveElectronBinaryAsync() {
  // 与 packages/desktop/scripts/dev.mjs 相同的平台分支：显式解析本仓库安装的 Electron，
  // 不依赖 PATH（Windows pnpm/PowerShell 下 spawn("electron") 会 ENOENT）。
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = path.dirname(electronPackageJsonPath);
  if (process.platform === "win32") {
    return path.join(electronPackageRoot, "dist", "electron.exe");
  }
  if (process.platform === "darwin") {
    return path.join(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(electronPackageRoot, "dist", "electron");
}

/**
 * 启动实际 Electron（不另起 dev Electron / vite dev server）。
 * env 为完整环境（process.env 展开后覆盖隔离变量）；输出 tee 进 artifacts/logs。
 * `quiet: true` 时不回显控制台（编排层 stdout 上限环境；stdoutText() 仍可用来做就绪判定）。
 */
export async function launchDesktop(
  run,
  { env, logFileName = "electron-main.log", quiet = false },
) {
  const { default: playwright } = await import("playwright-core");
  const executablePath = await resolveElectronBinaryAsync();
  const mainBundle = path.join(DESKTOP_ROOT, "out", "main", "index.js");
  const electron = await playwright._electron.launch({
    executablePath,
    args: [mainBundle],
    cwd: DESKTOP_ROOT,
    env,
  });
  const stream = createWriteStream(path.join(run.dirs.logs, logFileName), { flags: "a" });
  const chunks = [];
  const attach = (source, prefix) => {
    source?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      stream.write(text);
      if (!quiet) process.stdout.write(prefix ? `${prefix}${text}` : text);
    });
  };
  const child = electron.process();
  attach(child?.stdout);
  attach(child?.stderr);
  registerElectronCleanup(run, electron);
  return {
    electron,
    stdoutText: () => chunks.join(""),
    closeLog: () => stream.end(),
  };
}

function registerElectronCleanup(run, electron) {
  run.cleanupFns.push(async () => {
    try {
      await electron.close();
    } catch {
      // close 失败（进程已退出）时直接杀进程，保证测试进程树不残留。
      try {
        electron.process()?.kill("SIGKILL");
      } catch {
        // 已退出则忽略。
      }
    }
  });
}

export async function waitForFirstWindow(electron, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const window = electron.windows().at(-1);
    if (window) return window;
    if (Date.now() > deadline) {
      throw new Error(`[runner] 等待 Electron 窗口超时（>${timeoutMs}ms）`);
    }
    await sleep(250);
  }
}

/**
 * 等待 Host 就绪并核对 build fingerprint。
 *
 * main 日志的 `[spawnHostProcess] glm binary path:` 是原生 zcode-agent 二进制路径——
 * dev/test（unpackaged + Electron Node runtime）形态下预期为 `<not found>`（agent 由
 * zcodeAgentProcessManager 以 findUpward(dist/zcode.cjs) → bundled-agents/<platform>/glm/
 * zcode.cjs 的顺序用 ELECTRON_RUN_AS_NODE 执行 JS bundle）。因此这里核对的是 agent
 * bundle 链路事实：dist 产物与 staged 拷贝字节一致（同一份构建），两条解析候选的
 * 路径都真实存在且指纹等于本次构建——不把「编译成功」当「已加载」。
 * Host 进程内真正的 agent spawn 只在 workspace 会话建立时发生；capability 未装配的
 * 运行没有会话，进程级加载指纹由有会话的用例（装配后）继续核对。
 */
export async function waitForHostFingerprint(
  run,
  { stdoutText, fingerprint, distBundlePath, timeoutMs },
) {
  const spawnLogPattern = /\[spawnHostProcess\] glm binary path: (<not found>|\S+)/;
  const deadline = Date.now() + timeoutMs;
  let match = null;
  for (;;) {
    match = spawnLogPattern.exec(stdoutText());
    if (match) break;
    if (Date.now() > deadline) {
      throw new Error(
        `[runner] 等待 Host 启动日志超时（>${timeoutMs}ms）：main 日志未出现 host spawn 行`,
      );
    }
    await sleep(250);
  }
  const nativeBinaryLog = match[1];
  if (nativeBinaryLog !== "<not found>") {
    // 打包态/原生链路：日志路径即实际使用的 binary，直接比对指纹。
    const loaded = await sha256File(nativeBinaryLog);
    if (loaded.sha256 !== fingerprint.sha256) {
      throw new Error(
        `[runner] Host 加载的 agent 指纹与本次构建不一致: loaded=${nativeBinaryLog} ` +
          `loadedSha=${loaded.sha256} builtSha=${fingerprint.sha256}`,
      );
    }
    run.recordCheck("host-loaded-agent-fingerprint", true, {
      loadedPath: nativeBinaryLog,
      sha256: loaded.sha256,
    });
    return { loadedPath: nativeBinaryLog, fingerprint: loaded };
  }
  // dev/test 形态：核对 JS bundle 两条解析候选（dist 直连 + staged bundled-agents 拷贝）。
  const { existsSync } = await import("node:fs");
  const stagedBundle = fingerprint.stagedBundlePath;
  const candidates = [
    { label: "cli-dist", path: distBundlePath },
    { label: "staged-bundled-agents", path: stagedBundle },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      throw new Error(`[runner] Host agent 解析候选缺失: ${candidate.label}=${candidate.path}`);
    }
    const digest = await sha256File(candidate.path);
    if (digest.sha256 !== fingerprint.sha256) {
      throw new Error(
        `[runner] Host agent 解析候选指纹与本次构建不一致: ${candidate.label}=${candidate.path} ` +
          `sha=${digest.sha256} builtSha=${fingerprint.sha256}`,
      );
    }
  }
  run.recordCheck("host-agent-bundle-candidates-fingerprint", true, {
    nativeBinaryLog,
    candidates: candidates.map((candidate) => candidate.label),
    sha256: fingerprint.sha256,
    note: "unpackaged 形态 Host 经 Electron Node 执行 JS bundle；dist 与 staged 拷贝同指纹。进程级 spawn 加载指纹随会话用例核对",
  });
  return { loadedPath: stagedBundle, fingerprint };
}

/** 探测 renderer 的 e2e bridge 是否按双重条件暴露（E-28 的正向/反向探针）。 */
export async function probeE2EBridge(window) {
  return window.evaluate(() => ({
    bridgeExposed: typeof window.__zcodeFinalArmsCustomEventsE2E === "object",
    bridgeKeys:
      typeof window.__zcodeFinalArmsCustomEventsE2E === "object"
        ? Object.keys(window.__zcodeFinalArmsCustomEventsE2E).sort()
        : [],
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
