// CT-16 打包形态构建与启动（packaged suite 的行数拆分；runner.mjs/e2eSetup.mjs 同源约定）。
//
// 打包链完全复用 packages/desktop 的现有脚本（ticket CT-16：「构建脚本以 packages/desktop
// 实际为准」，不另写打包管线）：
//   1. scripts/build-desktop-agent-cli.mjs —— CLI 构建 + bundled-agents 暂存（与 e2e 同一
//      入口，build fingerprint 同源可比）；
//   2. `pnpm build`（packages/desktop）—— prepare:runtime-assets（agent bundle 暂存进
//      bundled-agents/<platform>/glm）+ production build；renderer 不带 bridge flag
//      （VITE_ZCODE_E2E_STORE_BRIDGE=0，生产形态，E-28 打包半边的事实来源）；
//   3. `pnpm exec electron-builder --config electron-builder.config.js --dir` —— 与
//      scripts/bundle.mjs 同一份打包配置与镜像 env 辅助函数（直接 import 复用，不复制
//      实现）；--dir 只产出 unpacked .app（真实打包形态：app.asar + resources/glm），不出
//      dmg 安装器——安装器只是同一 .app 的分发包装。
// 如实记录的取舍：ZCODE_SKIP_REMOTE_ASSETS=1（远程 workspace 原生资产不进本次产物）——
// D4 第一版仅本地 workspace，远程执行不在验收面；ZCODE_ENV=production（生产身份
// productName=Cotaya，不落 _TEST 后缀）。
//
// 产物核对：app.asar 在场；Contents/Resources/glm/zcode.cjs 的 sha256 == CLI 构建指纹——
// 打包态 Host 经 services providerRuntimeResolver 从 process.resourcesPath 解析的正是这份
// 文件（磁盘层）；进程级证据由 packaged 用例在打包 app 内真实完成 managed Cycle 取得。

import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { DESKTOP_ROOT, buildAgentCli, platformKey, sha256File, spawnCaptured } from "./runner.mjs";
import {
  createElectronBuilderBinariesMirrorEnv,
  createElectronRuntimeMirrorEnv,
  resolveElectronBuilderBinariesMirror,
  resolveElectronMirror,
} from "../../scripts/bundle.mjs";
import { resolveDesktopProductIdentity } from "../../scripts/desktop-product-identity.mjs";

/** 打包构建 env（生产身份 + 生产 renderer；镜像与 bundle.mjs 同一套）。 */
function packagedBuildEnv() {
  const osFlag = process.platform === "darwin" ? "mac" : process.platform;
  const arch = process.arch;
  return {
    NODE_ENV: "production",
    ZCODE_ENV: "production",
    // 显式 "0"：防止先跑过 e2e 的外层进程把 "1" 泄漏进本次生产 renderer 构建。
    VITE_ZCODE_E2E_STORE_BRIDGE: "0",
    ZCODE_TARGET_OS: osFlag,
    ZCODE_TARGET_ARCH: arch,
    // 如实取舍（见文件头）：远程资产不进产物，本地 workspace 验收不消费它。
    ZCODE_SKIP_REMOTE_ASSETS: "1",
    ...createElectronRuntimeMirrorEnv(resolveElectronMirror()),
    ...createElectronBuilderBinariesMirrorEnv(resolveElectronBuilderBinariesMirror()),
  };
}

/** 打包产物路径（macOS：dist/mac[-arm64]/<productName>.app；productName 按构建身份解析）。 */
export function resolvePackagedAppPaths() {
  const identity = resolveDesktopProductIdentity({
    ...process.env,
    ZCODE_ENV: "production",
  });
  const archDir = process.arch === "arm64" && process.platform === "darwin" ? "mac-arm64" : "mac";
  const appPath = path.join(DESKTOP_ROOT, "dist", archDir, `${identity.productName}.app`);
  const executablePath =
    process.platform === "darwin"
      ? path.join(appPath, "Contents", "MacOS", identity.productName)
      : path.join(appPath, `${identity.productName}.exe`);
  const agentBundlePath =
    process.platform === "darwin"
      ? path.join(appPath, "Contents", "Resources", "glm", "zcode.cjs")
      : path.join(appPath, "Resources", "glm", "zcode.cjs");
  const asarPath =
    process.platform === "darwin"
      ? path.join(appPath, "Contents", "Resources", "app.asar")
      : path.join(appPath, "Resources", "app.asar");
  return { productName: identity.productName, appPath, executablePath, agentBundlePath, asarPath };
}

/**
 * 构建打包 app：CLI 构建 → desktop 生产构建 → electron-builder --dir。
 * skip 选项各自复用既有产物（工作流可预构建后传入），但仍做存在性/指纹校验——
 * 复用不等于免检。
 */
export async function buildPackagedApp(
  run,
  { skipCliBuild = false, skipDesktopBuild = false, skipPackage = false, quiet = true } = {},
) {
  const stagedBundle = path.join(DESKTOP_ROOT, "bundled-agents", platformKey(), "glm", "zcode.cjs");
  const cli = skipCliBuild
    ? {
        staged: stagedBundle,
        fingerprint: { ...(await sha256File(stagedBundle)), stagedBundlePath: stagedBundle },
      }
    : await buildAgentCli(run, { quiet });

  const env = { ...process.env, ...packagedBuildEnv() };
  if (!skipDesktopBuild) {
    // `pnpm build` 已含 prepare:runtime-assets（agent bundle/native-search/window-bounds）；
    // 与 bundle.mjs 的「prepare → build」顺序同源（build 脚本自带 prepare，无需重复）。
    const result = await spawnCaptured(run, "packaged-desktop-build", "pnpm", ["build"], {
      cwd: DESKTOP_ROOT,
      env,
      quiet,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `[packaged] desktop 生产构建失败 exit=${result.exitCode}（日志: ${result.logFile}）`,
      );
    }
  }
  const paths = resolvePackagedAppPaths();
  if (!skipPackage) {
    // 与 bundle.mjs 相同的 electron-builder 调用形（--dir 只出 unpacked .app）。
    const builderArgs = [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.config.js",
      process.platform === "darwin" ? "--mac" : `--${process.platform}`,
      `--${process.arch}`,
      "--dir",
    ];
    const result = await spawnCaptured(run, "packaged-electron-builder", "pnpm", builderArgs, {
      cwd: DESKTOP_ROOT,
      env,
      quiet,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `[packaged] electron-builder 失败 exit=${result.exitCode}（日志: ${result.logFile}）`,
      );
    }
  }
  await verifyPackagedApp(run, { paths, fingerprint: cli.fingerprint });
  run.recordCheck("packaged-build", true, {
    productName: paths.productName,
    appPath: paths.appPath,
    skipCliBuild,
    skipDesktopBuild,
    skipPackage,
    remoteAssetsSkipped: true,
    note: "electron-builder --dir（unpacked .app，真实打包形态）；ZCODE_SKIP_REMOTE_ASSETS=1（远程资产不在本地 workspace 验收面）",
  });
  return { cli, ...paths };
}

/** 产物核对：.app/app.asar 在场 + resources/glm/zcode.cjs 指纹 == CLI 构建指纹。 */
export async function verifyPackagedApp(run, { paths, fingerprint }) {
  const missing = [
    paths.appPath,
    paths.executablePath,
    paths.asarPath,
    paths.agentBundlePath,
  ].filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    throw new Error(`[packaged] 打包产物缺失: ${missing.join(", ")}`);
  }
  const digest = await sha256File(paths.agentBundlePath);
  if (digest.sha256 !== fingerprint.sha256) {
    throw new Error(
      `[packaged] 随包 agent 指纹与本次 CLI 构建不一致: ${paths.agentBundlePath} ` +
        `sha=${digest.sha256} builtSha=${fingerprint.sha256}`,
    );
  }
  run.recordCheck("packaged-agent-fingerprint", true, {
    agentBundlePath: paths.agentBundlePath,
    sha256: digest.sha256,
    note: "打包态 Host 从 process.resourcesPath/glm/zcode.cjs 解析并执行（providerRuntimeResolver）；磁盘指纹与构建一致",
  });
}

/**
 * 启动打包 app（playwright _electron + 打包产物内的可执行文件；不传应用参数——
 * 打包 app 的 main 由 app.asar 提供）。输出 tee 进 artifacts/logs，与 launchDesktop 同形。
 *
 * cwd 显式固定在临时根内：agent 命令解析的 dev 候选（findUpward apps/zcode-cli/...）
 * 从 cwd 向上找——cwd 落在仓库里时打包 app 会解析到仓库 checkout 的 dist bundle
 * （字节与随包一致但取证弱化）。中性 cwd 让解析走到真正的打包候选
 * （resources/glm/zcode.cjs，Electron Node 执行），与用户机器形态一致。
 */
export async function launchPackagedApp(
  run,
  { executablePath, env, logFileName = "packaged-main.log", quiet = false },
) {
  const { default: playwright } = await import("playwright-core");
  const electron = await playwright._electron.launch({
    executablePath,
    args: [],
    cwd: run.root,
    env,
  });
  const stream = createWriteStream(path.join(run.dirs.logs, logFileName), { flags: "a" });
  const chunks = [];
  const attach = (source) => {
    source?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      stream.write(text);
      if (!quiet) process.stdout.write(text);
    });
  };
  const child = electron.process();
  attach(child?.stdout);
  attach(child?.stderr);
  run.cleanupFns.push(async () => {
    try {
      await electron.close();
    } catch {
      try {
        electron.process()?.kill("SIGKILL");
      } catch {
        // 已退出则忽略。
      }
    }
  });
  return { electron, stdoutText: () => chunks.join(""), closeLog: () => stream.end() };
}
