// CT-16 packaged suite 的构建/种子/启动/就绪预检（packaged.test.mjs 的行数上限拆分；
// 与 e2eSetup.mjs 同一约定：失败由入口记 setup check 并把全部用例标 blocked，§10）。

import path from "node:path";
import { REPO_ROOT, buildIsolationEnv, spawnCaptured } from "./runner.mjs";
import { waitForFirstWindow } from "./runnerElectron.mjs";
import { openAutomationsPage } from "./runnerWindow.mjs";
import { createGitRepoFixture } from "./fixtures.mjs";
import { createScriptedProvider } from "./fixturesProvider.mjs";
import { buildPackagedApp, launchPackagedApp } from "./packagedBuild.mjs";

/**
 * 打包形态的 agent 解析事实（进程级）：运行期日志的 spawn preflight 必须显示 agent 以
 * 随包 resources/glm/zcode.cjs 启动（Electron Node 执行）。修复依据：launcher 此前不固定
 * cwd，dev 候选（findUpward apps/zcode-cli/...）会从仓库 cwd 解析到 checkout 的 dist
 * bundle——字节虽与随包一致（指纹校验），但「打包 app 用随包 runtime」就没了进程级证据。
 */
export async function assertPackagedAgentResolution(run, packaged) {
  const { readFile, readdir } = await import("node:fs/promises");
  const expected = path.join(packaged.appPath, "Contents", "Resources", "glm", "zcode.cjs");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const files = (await readdir(run.dirs.logs)).filter((name) => name.endsWith(".log"));
    let preflight = null;
    for (const name of files) {
      const text = await readFile(path.join(run.dirs.logs, name), "utf8").catch(() => "");
      for (const line of text.split("\n").reverse()) {
        if (line.includes("spawn preflight")) {
          preflight = line;
          break;
        }
      }
      if (preflight) break;
    }
    if (preflight) {
      const resolvedInsideBundle = preflight.includes(JSON.stringify(expected).slice(1, -1));
      run.recordCheck("packaged-agent-resolution", resolvedInsideBundle, {
        expectedBundle: expected,
        preflightLine: preflight.slice(0, 600),
      });
      if (!resolvedInsideBundle) {
        throw new Error(
          "[packaged] agent 未按打包形态解析（spawn preflight 不含随包 resources/glm/zcode.cjs）",
        );
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("[packaged] 等待 agent spawn preflight 日志超时（>30s）");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * 打包实例 setup：构建打包 app → 临时 Git 原仓库（预置用户未提交改动）→ 脚本 provider →
 * 应用配置种子（与 e2e 同一入口）→ 启动打包 app（生产形态 env：无 bridge build flag，
 * 单独注入 ZCODE_E2E_RUN_ID 作 E-28 负向事实；ZCODE_CONTINUOUS_HOST_ENABLED=1 装配开启）
 * → 窗口就绪 + capability 预检 + 随包 agent 解析断言。
 */
export async function setupPackaged(run, args) {
  const packaged = await buildPackagedApp(run, {
    skipCliBuild: args.skipCliBuild,
    skipDesktopBuild: args.skipDesktopBuild,
    skipPackage: args.skipPackage,
  });
  const repo = await createGitRepoFixture(run, { name: "packaged-origin" });
  await repo.addUncommittedUserChanges();
  const provider = createScriptedProvider(run);
  await provider.started;
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
      "--provider-base-url",
      await provider.url(),
      "--workspace-path",
      repo.dir,
    ],
    { cwd: REPO_ROOT, quiet: true },
  );
  if (seed.exitCode !== 0) {
    throw new Error(`[packaged] 应用配置种子失败 exit=${seed.exitCode}（日志: ${seed.logFile}）`);
  }
  // 生产形态实例：隔离 env 不带 bridge build flag（buildIsolationEnv 无 bridgeRunId 即不设
  // VITE_*/RUN_ID），再单独注入 ZCODE_E2E_RUN_ID——E-28 打包半边的负向事实：run ID 在场、
  // build flag 缺席（构建期与运行期都不在场）→ 测试桥必须保持关闭。
  const appEnv = buildIsolationEnv(run, {});
  appEnv.ZCODE_E2E_RUN_ID = run.testRunId;
  appEnv.ZCODE_CONTINUOUS_HOST_ENABLED = "1";
  const app = await launchPackagedApp(run, {
    executablePath: packaged.executablePath,
    env: { ...process.env, ...appEnv },
    quiet: true,
  });
  const window = await waitForFirstWindow(app.electron, 90_000);
  const navigation = await openAutomationsPage(window, 90_000);
  if (!navigation.navigated) {
    throw new Error(`[packaged] 窗口就绪预检失败: ${navigation.reason}`);
  }
  const tabCount = await window.locator('[data-testid="automations-page-tab-continuous"]').count();
  run.recordCheck("continuous-capability", tabCount > 0, {
    tabCount,
    note: "打包实例（装配开启）的 Automations 页 Continuous tab 探测",
  });
  if (tabCount === 0) {
    throw new Error("[packaged] capability 预检失败：装配开启但 Continuous tab 缺席");
  }
  await assertPackagedAgentResolution(run, packaged);
  return { packaged, repo, provider, app, window, appEnv };
}
