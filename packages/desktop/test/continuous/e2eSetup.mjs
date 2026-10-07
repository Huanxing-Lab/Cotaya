// CT-15 e2e setup（e2e.test.mjs 的行数拆分）：构建/隔离/种子/启动/就绪/capability 预检。
// 失败由入口记 setup check 并把全部用例标 blocked（预检失败不是 passed，§10）。

import path from "node:path";
import {
  AGENT_DIST_BUNDLE,
  DESKTOP_ROOT,
  REPO_ROOT,
  buildAgentCli,
  buildIsolationEnv,
  ensureDesktopBuild,
  platformKey,
  sha256File,
  spawnCaptured,
} from "./runner.mjs";
import { launchDesktop, waitForFirstWindow, waitForHostFingerprint } from "./runnerElectron.mjs";
import { openAutomationsPage } from "./runnerWindow.mjs";
import { createGitRepoFixture } from "./fixtures.mjs";
import { createTargetAppServer } from "./fixturesTargetApp.mjs";
import { createScriptedProvider } from "./fixturesProvider.mjs";

/** 隔离实例的应用配置种子（provider/设置/价格快照；产品 codec 校验，fail closed）。 */
async function seedAppConfig(run, { providerBaseUrl, workspacePath }) {
  const result = await spawnCaptured(
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
      providerBaseUrl,
      "--workspace-path",
      workspacePath,
    ],
    { cwd: REPO_ROOT, quiet: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(`[e2e] 应用配置种子失败 exit=${result.exitCode}（日志: ${result.logFile}）`);
  }
  run.recordCheck("app-config-seed", true, {
    dataDir: run.dirs.data,
    homeDir: run.dirs.home,
    workspacePath,
  });
}

export async function setupE2e(run, args) {
  const stagedBundle = path.join(DESKTOP_ROOT, "bundled-agents", platformKey(), "glm", "zcode.cjs");
  const cli = args.skipCliBuild
    ? {
        staged: stagedBundle,
        fingerprint: { ...(await sha256File(stagedBundle)), stagedBundlePath: stagedBundle },
      }
    : await buildAgentCli(run, { quiet: true });
  await ensureDesktopBuild(run, { skipDesktopBuild: args.skipDesktopBuild, quiet: true });

  const repo = await createGitRepoFixture(run, { name: "e2e-origin" });
  // 原仓库预置用户未提交修改（E-02）：staged/unstaged/untracked 三类。
  await repo.addUncommittedUserChanges();
  const targetApp = createTargetAppServer(run, { repoDir: repo.dir });
  const provider = createScriptedProvider(run);
  await provider.started;
  await seedAppConfig(run, {
    providerBaseUrl: await provider.url(),
    workspacePath: repo.dir,
  });

  const bridgeEnv = buildIsolationEnv(run, { bridgeRunId: run.testRunId });
  // CT-12 装配门：显式开启（默认关闭形态由 E-24 的对照实例覆盖）。
  const app = await launchDesktop(run, {
    env: { ...process.env, ...bridgeEnv, ZCODE_CONTINUOUS_HOST_ENABLED: "1" },
    quiet: true,
  });
  const window = await waitForFirstWindow(app.electron, 60_000);
  await waitForHostFingerprint(run, {
    stdoutText: app.stdoutText,
    fingerprint: cli.fingerprint,
    distBundlePath: AGENT_DIST_BUNDLE,
    timeoutMs: 60_000,
  });

  // 窗口就绪预检（本 ticket 修复）：等待首屏形态并真实导航 Automations。
  const navigation = await openAutomationsPage(window, 90_000);
  if (!navigation.navigated) {
    throw new Error(`[e2e] 窗口就绪预检失败: ${navigation.reason}`);
  }
  // capability 预检：装配开启后 tab 必须在场（capability ready）。
  const tabCount = await window.locator('[data-testid="automations-page-tab-continuous"]').count();
  run.recordCheck("continuous-capability", tabCount > 0, {
    tabCount,
    note: "ZCODE_CONTINUOUS_HOST_ENABLED=1 实例的 Automations 页 Continuous tab 探测",
  });
  if (tabCount === 0) {
    throw new Error("[e2e] capability 预检失败：装配开启但 Continuous tab 缺席");
  }

  // 对照实例（E-24）：同 build、未开装配 → tab 缺席（默认关闭的真实产品形态）。
  const disabledEnv = buildIsolationEnv(run, {
    bridgeRunId: run.testRunId,
    userDataDir: path.join(run.dirs.electronUserData, "no-assembly"),
    appNameSuffix: " NoAssembly",
  });
  const disabledApp = await launchDesktop(run, {
    env: { ...process.env, ...disabledEnv },
    logFileName: "electron-no-assembly.log",
    quiet: true,
  });
  const disabledAssemblyWindow = await waitForFirstWindow(disabledApp.electron, 60_000);

  return {
    cli,
    bridgeEnv,
    repo,
    targetApp,
    provider,
    app,
    window,
    disabledApp,
    disabledAssemblyWindow,
  };
}
