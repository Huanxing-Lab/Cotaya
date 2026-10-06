// CT-15 E2E 业务用例（e2e.test.mjs 的行数拆分；每个用例都是真实 UI 动作 + 事实断言）。
//
// 公共约定：
// - 所有断言三层取材：UI（稳定 test id / role=alert 文本）、服务事实（tasks-index 只读
//   SQL）、执行事实（provider 请求计数、Git/worktree、进程日志）；
// - provider 脚本按全局请求序号步进；barrier 先记录到达再注入（§9）；
// - 不向 UI store 塞状态：Program/Cycle/账本全部由 UI 点击 → Host 服务 → CLI 产生。
//
// 用例对共享上下文（ctx）的字段：run/e2e 运行句柄、window/app、repo、provider、
// evidence 工厂、dbFacts()/worktreeFacts() 读取器、sourceCommit。

import assert from "node:assert/strict";
import { createCaseEvidence, sanitizeText } from "./evidence.mjs";

import {
  openContinuousTab,
  openCreateFormAndReadDefaults,
  submitCreateForm,
  waitFor,
  waitForProgramCard,
} from "./continuousDriver.mjs";

/** E-34：创建表单默认值 = 产品常量；超出安全整数的额度输入被表单层拒绝（无截断）。 */
export async function caseFormDefaultsAndPrecision(ctx) {
  const evidence = createCaseEvidence(ctx.run, "E-34");
  await openContinuousTab(ctx.window);
  await evidence.screenshot(ctx.window, "create-form-defaults");
  const defaults = await openCreateFormAndReadDefaults(ctx.window);
  await evidence.record("form-defaults.json", defaults);
  // 产品常量（规格 §2；表单不自带第二套默认值）：USD 字段以美元显示，tokens/并发/小时直显。
  assert.equal(defaults.dailyBudget, "1000", "每日预算默认 USD 1,000");
  assert.equal(defaults.dailyUnlimited, false, "Unlimited 默认不勾选");
  assert.equal(defaults.cycleBudget, "100", "单轮预算默认 USD 100");
  assert.equal(defaults.tokens, "1000000000", "单轮 tokens 默认 10 亿");
  assert.equal(defaults.concurrency, "10", "并发默认 10");
  assert.equal(defaults.activeHours, "1", "有效执行默认 1 小时");
  assert.equal(defaults.cadenceKind, "interval", "cadence 默认 interval");

  // 超出安全整数的 token 输入：inputToPositiveInt 拒绝非安全整数 → 校验错误，不创建 Program。
  const programsBefore = (await ctx.dbFacts()).programs.length;
  await submitCreateForm(ctx.window, {
    goal: "e2e-unsafe-integer",
    overrides: { "continuous-form-tokens": String(Number.MAX_SAFE_INTEGER + 1) },
  });
  await waitFor(
    () =>
      ctx.window
        .locator('[role="alert"]')
        .first()
        .isVisible()
        .catch(() => false),
    { label: "表单校验错误提示", timeoutMs: 10_000 },
  );
  const alertText = sanitizeText(
    (await ctx.window.locator('[role="alert"]').first().textContent()) ?? "",
  );
  await evidence.screenshot(ctx.window, "unsafe-integer-rejected");
  await evidence.record("unsafe-integer-alert.txt", alertText);
  const factsAfterReject = await ctx.dbFacts();
  assert.equal(
    factsAfterReject.programs.length,
    programsBefore,
    "非法额度输入不得创建 Program（无静默截断）",
  );

  // 以默认值创建 Program（E-34 第二设置：无自定义值）。
  // 创建即自动执行首轮（§2「初次执行到期立即执行一次」）：先布好空候选脚本，
  // 自动轮 completed/no_changes（其终态断言在 E-15 的链路用例中复核）。
  await ctx.window.locator('[data-testid="continuous-form-back"]').first().click();
  await openCreateFormAndReadDefaults(ctx.window);
  const { emptyObservationStep } = await import("./e2eCycles.mjs");
  await ctx.provider.control.setScript({ steps: [emptyObservationStep()] });
  await submitCreateForm(ctx.window, { goal: "e2e-default-budget-program" });
  const programId = await waitForProgramCard(ctx.window, "e2e-default-budget-program");
  const facts = await ctx.dbFacts();
  const program = facts.programs.find((row) => row.id === programId);
  await evidence.record("program-config.json", { programId, config: program?.config_json });
  assert.ok(program, "Program 落库");
  const config = JSON.parse(program.config_json);
  assert.equal(config.budget.maxConcurrentActors, 10, "落库并发 10");
  assert.equal(config.budget.perCycleTokens, 1_000_000_000, "落库 tokens 10 亿");
  assert.equal(config.budget.perCycleCostUsdMicros, 100_000_000, "单轮 USD100 按微美元存储");
  assert.equal(config.budget.dailyCostUsdMicros, 1_000_000_000, "每日 USD1000 按微美元存储");
  assert.equal(config.budget.activeExecutionLimitMs, 3_600_000, "有效执行 3,600,000ms");
  return { programId, evidence, defaults };
}

/** E-24：装配开启时 capability ready/tab 在场/无 unsupported 面；关闭装配的实例 tab 缺席。 */
export async function caseCapabilitySurfaces(ctx, { disabledAssemblyWindow }) {
  const evidence = createCaseEvidence(ctx.run, "E-24");
  await openContinuousTab(ctx.window);
  await evidence.screenshot(ctx.window, "capability-ready");
  const unsupportedVisible = await ctx.window
    .locator('[data-testid="continuous-unsupported"]')
    .isVisible()
    .catch(() => false);
  const platformReadOnlyVisible = await ctx.window
    .locator('[data-testid="continuous-platform-read-only"]')
    .isVisible()
    .catch(() => false);
  await evidence.record("capability-surfaces.json", {
    unsupportedVisible,
    platformReadOnlyVisible,
  });
  assert.equal(unsupportedVisible, false, "支持平台不得显示不支持面（不退回普通 prompt）");
  assert.equal(platformReadOnlyVisible, false, "darwin-arm64 已登记 autonomous，不得显示只读横幅");

  // 对照实例：同一构建、未开 ZCODE_CONTINUOUS_HOST_ENABLED → channel 未注册 → tab 缺席
  //（默认关闭的真实产品形态；不因环境名开放任何执行路径）。
  const { openAutomationsPage } = await import("./runnerWindow.mjs");
  const disabled = await openAutomationsPage(disabledAssemblyWindow);
  await evidence.screenshot(disabledAssemblyWindow, "assembly-off-tab-absent");
  const tabCount = await disabledAssemblyWindow
    .locator('[data-testid="automations-page-tab-continuous"]')
    .count();
  await evidence.record("assembly-off-tab.json", { navigated: disabled.navigated, tabCount });
  assert.equal(disabled.navigated, true, `对照实例必须完成 Automations 导航: ${disabled.reason}`);
  assert.equal(tabCount, 0, "未装配 Host 的实例 Continuous tab 必须缺席（capability 门）");
  const disabledFacts = await ctx.dbFacts();
  assert.equal(disabledFacts.cycles.length, 0, "对照实例不得产生任何 Cycle（无绕过授权写入）");
  return { evidence };
}

/**
 * 其余未完成真实驱动的用例：统一维护 blocked 理由（引用本次预检/装配事实与产品边界，
 * 不引用不存在的证据）。返回写入的 reason。
 */
export function recordRemainingBlockedCases(
  run,
  { caseId, sourceCommit, command, workingTreeDiff },
) {
  const reasons = {
    default:
      "候选路径（三候选实施/验证/提交、10 pending、执行中 Decision、越界拒绝、变更量上限）需要脚本化模型驱动完整的 builder/reviewer 工具调用序列与授权面的声明测试命令（第一版授权面为空——CT-12 已知限制 3；候选授权端口本身已接线：模板 v3 骨架经 continuous-authorize 取得写入许可，2026-10-06 评审修复）；capability 装配与窗口就绪已由本次预检证明可用",
    "E-09":
      "跨日与晚到 usage 需要可注入时钟与跨重启的账本注入（装配级时钟接缝已就位——createContinuousHostRuntime 可选 clock 注入，生产调用点不传；跨进程 e2e 的时钟注入仍需测试桥设计，生产构建不得暴露故障注入）",
    "E-17":
      "退出/强杀/重启链需要首轮链稳定后补驱动（本次未完成；正常退出的 interrupt 收口在 electron 日志可见）",
    "E-18": "跨多周期唤醒与无 Host 场景需要调度器时钟推进注入（同 E-09 时钟边界）",
    "E-19": "旧 owner/epoch 接管需要阻断续租的传输级注入（本 ticket 未实现）",
    "E-22": "390/768/1280 × 主题 × 语言的矩阵取证未驱动（capability 与页面骨架已可达）",
    "E-23": "混合历史审计视图依赖候选路径历史（无候选轮的历史已在 E-15 取证）",
    "E-29":
      "两小时正常等待跨一小时墙钟需要测试时钟注入（装配级时钟接缝已就位；跨进程 e2e 注入仍需测试桥设计，生产构建不得暴露）",
    "E-30": "健康工作一小时暂停需要测试时钟注入（同 E-29）",
    "E-31": "180 秒 + 3 次失败探测需要时钟与探测注入（同 E-29）",
    "E-32": "继续确认的重复回答/旧 version/结束本轮链在 E-08 已取证到 pending 对话框；回答链未驱动",
    "E-33": "11 路并发争抢需要多 actor 脚本序列（候选路径未完成）",
  };
  const reason = reasons[caseId] ?? reasons.default;
  // 不覆盖：真实用例的结论（passed/failed）永远优先——node:test 顶层并发下 blocked
  // 登记测试可能与业务用例体交错执行（run14 实测被覆盖成 30 blocked），报告层只补缺。
  if (run.cases.has(caseId)) {
    return run.cases.get(caseId).failureReason ?? reason;
  }
  run.cases.set(caseId, {
    caseId,
    status: "blocked",
    executionKind: "scripted",
    sourceCommit,
    platform: `${process.platform}/${process.arch}`,
    command,
    exitCode: null,
    assertions: [],
    evidence: [
      { kind: "preflight", detail: "checks.continuous-capability（装配开启，tab 在场）" },
      { kind: "source-tree", detail: workingTreeDiff || "clean" },
    ],
    failureReason: reason,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
  return reason;
}
