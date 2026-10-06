// CT-15 窗口就绪与 Automations 导航（e2e/regression/mobile 共用；runner.mjs 的行数拆分）。
//
// 修复依据（docs/testing/continuous.md「本次实际结果」：e2e 30 用例 blocked 于「窗口未
// 就绪」、regression E-28 断言 `canary 必须先打开 Automations 页面` 失败）：
// 1. 旧预检只等「首个窗口出现」——窗口出现 ≠ renderer 可交互。首屏可能是欢迎/登录页
//    （隔离环境无凭据）或仍在恢复会话；直接点 automations-open 必然超时，被笼统记成
//    「窗口未就绪」，且 capability/tab 的缺席证据一并不可得。
// 2. 正确语义：先判定首屏形态（主界面侧栏 automations-open vs 登录入口），再按形态驱动
//    ——登录页在场时如实报告（凭据由 fixturesAppSeed 预置解决，见其注释），主界面在场时
//    真实点击侧栏入口并等待 Automations 页骨架挂载（toast 锚点）。
// 等待条件全部是 observable 事件（locator attach/click ACK），无「等 N 秒应该好」。

/** 首屏形态：主界面已就绪 / 登录入口在场 / 超时未就绪。 */
export async function waitForAppShellReady(window, timeoutMs = 60_000) {
  const loginSelector =
    '[data-testid^="oauth-login-button"], [data-testid="login-use-api-key-button"]';
  const mainSelector = '[data-testid="automations-open"]';
  const deadline = Date.now() + timeoutMs;
  // 登录按钮可能因 provider 列表加载（loadingProviders）延迟出现；用短轮询交替探测两类
  // 标记，任何一类 attached 即返回，避免固定 5 秒窗口的竞态（旧实现的漏检根源）。
  for (;;) {
    const loginAttached = await window
      .locator(loginSelector)
      .first()
      .isVisible()
      .catch(() => false);
    if (loginAttached) return { state: "login" };
    const mainAttached = await window
      .locator(mainSelector)
      .first()
      .isVisible()
      .catch(() => false);
    if (mainAttached) return { state: "main" };
    // 首次运行的职业引导（OccupationOnboarding）是覆盖整页的第三种首屏形态：真实点击
    // 「跳过」（页脚第一个按钮；跳过是产品显式答案——记录落 null，不是绕过产品流）。
    // 引导共三步（职业/模式/偏好），最后一步的跳过即 save(skip=true)，页面卸载。
    const onboardingVisible = await window
      .locator('[data-testid="onboarding-page"]')
      .isVisible()
      .catch(() => false);
    if (onboardingVisible) {
      await dismissOnboarding(window).catch(() => {});
    }
    if (Date.now() > deadline) {
      return {
        state: "timeout",
        detail: `>${timeoutMs}ms 内既无登录入口也无主界面侧栏（automations-open）`,
      };
    }
    await sleep(250);
  }
}

/** 逐页点击引导的「跳过」直到引导页卸载（有界尝试；失败由上层就绪超时兜底取证）。 */
async function dismissOnboarding(window) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const page = window.locator('[data-testid="onboarding-page"]');
    if (!(await page.isVisible().catch(() => false))) return true;
    // 页脚 DOM 顺序：跳过（link 样式）在前、继续在后；无稳定 test id，用结构定位。
    const skip = page.locator("footer button").first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 2_000 }).catch(() => {});
    }
    await sleep(700);
  }
  return false;
}

/**
 * 真实导航到 Automations 主视图并等待骨架挂载。
 * 返回是否完成（false 时调用方必须把「tab 缺席证据不可得」如实上报，不得当通过）。
 */
export async function navigateToAutomations(window, timeoutMs = 15_000) {
  const entry = window.locator('[data-testid="automations-open"]').first();
  if (!(await entry.isVisible().catch(() => false))) return false;
  await entry.click({ timeout: timeoutMs });
  await window
    .locator("#automations-main-toast-anchor")
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs });
  return true;
}

/**
 * 一站式：等待首屏形态并尝试进入 Automations 页。
 * 返回 { navigated, shellState, reason? }——navigated=false 时 reason 说明卡点
 * （登录页阻挡/超时/导航失败），供用例如实区分 blocked 依据。
 */
export async function openAutomationsPage(window, timeoutMs = 60_000) {
  const ready = await waitForAppShellReady(window, timeoutMs);
  if (ready.state === "login") {
    return {
      navigated: false,
      shellState: "login",
      reason:
        "欢迎/登录页阻挡（隔离实例无可用 provider 配置；凭据预置见 fixturesAppSeed）——无法到达 Automations 页",
    };
  }
  if (ready.state === "timeout") {
    return { navigated: false, shellState: "timeout", reason: `窗口未就绪: ${ready.detail}` };
  }
  try {
    const navigated = await navigateToAutomations(window);
    return navigated
      ? { navigated: true, shellState: "main" }
      : {
          navigated: false,
          shellState: "main",
          reason: "主界面已就绪但 automations-open 不可见（侧栏未渲染该入口）",
        };
  } catch (error) {
    return {
      navigated: false,
      shellState: "main",
      reason: `导航 Automations 失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
