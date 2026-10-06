// CT-15 Continuous E2E 驱动面：真实 UI 操作（稳定 test id，docs/testing/continuous.md §9）
// 与只读事实收集（tasks-index SQL facts / Git 事实 / provider 计数）。不向 UI store 塞
// 目标状态——所有业务事实都由 UI 点击 → Host 服务 → CLI/数据库产生后从盘上读回。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ————————————————————————————— UI 驱动 —————————————————————————————

/** 轮询等待条件成立（observable 谓词；超时抛错，禁止「等 N 秒应该完成」式的盲等）。 */
export async function waitFor(predicate, { timeoutMs = 60_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`[e2e] 等待 ${label} 超时（>${timeoutMs}ms）`);
    await sleep(400);
  }
}

/**
 * 从 Automations 页切到 Continuous tab（capability ready 后 tab 必然在场）。
 * 前一个用例可能停在创建表单整页（tab 条不在该视图挂载）——先真实点「返回」回列表；
 * 也可能已离开 Automations 页——重新导航。所有分支都是真实 UI 操作。
 */
export async function openContinuousTab(window, timeoutMs = 10_000) {
  const tab = window.locator('[data-testid="automations-page-tab-continuous"]').first();
  if (!(await tab.isVisible().catch(() => false))) {
    // 前一用例可能留下模态对话框（遮罩拦截一切点击）。真实 UI 收口：
    // - 「资源继续确认」在场 → 点「保持暂停」（stay_paused：保留 pending 工作、不扩额，
    //   §6.1 的显式选项）；
    // - 其它对话框（确认弹窗等）→ Esc 关闭（可关闭对话框的标准交互）。
    const stayButton = window.locator('[data-testid="continuous-continuation-stay"]').first();
    if (await stayButton.isVisible().catch(() => false)) {
      await stayButton.click({ timeout: 5_000 }).catch(() => {});
      await window
        .locator('[data-testid="continuous-continuation-dialog"]')
        .first()
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {});
    } else {
      const overlay = window.locator('[data-slot="dialog-overlay"]').first();
      if (await overlay.isVisible().catch(() => false)) {
        await window.keyboard.press("Escape").catch(() => {});
        await overlay.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      }
    }
    const back = window
      .locator('[data-testid="continuous-form-back"], [data-testid="continuous-detail-back"]')
      .first();
    if (await back.isVisible().catch(() => false)) {
      await back.click();
    } else {
      const { navigateToAutomations } = await import("./runnerWindow.mjs");
      const navigated = await navigateToAutomations(window, timeoutMs).catch(() => false);
      if (!navigated) {
        throw new Error("[driver] 无法回到 Automations 页（既无 tab 也无表单返回入口）");
      }
    }
    await tab.waitFor({ state: "visible", timeout: timeoutMs });
  }
  await tab.click();
  await window
    .locator('[data-testid="continuous-section"], [data-testid="continuous-unsupported"]')
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs });
}

/**
 * 打开创建表单并读取全部默认值（E-34：默认值必须是产品常量，表单不自带第二套）。
 * 返回 input.value 快照；不断言——由调用方按用例断言。
 */
export async function openCreateFormAndReadDefaults(window, timeoutMs = 10_000) {
  await window
    .locator('[data-testid="continuous-create-open"]')
    .first()
    .click({ timeout: timeoutMs });
  const form = window.locator('[data-testid="continuous-create-form"]').first();
  await form.waitFor({ state: "visible", timeout: timeoutMs });
  const read = async (testId) => {
    const locator = window.locator(`[data-testid="${testId}"]`).first();
    return (await locator.getAttribute("type")) === "checkbox"
      ? await locator.isChecked()
      : await locator.inputValue();
  };
  return {
    goal: await read("continuous-form-goal"),
    scopePaths: await read("continuous-form-scope-paths"),
    dailyBudget: await read("continuous-form-daily-budget"),
    dailyUnlimited: await read("continuous-form-daily-unlimited"),
    cycleBudget: await read("continuous-form-cycle-budget"),
    tokens: await read("continuous-form-tokens"),
    concurrency: await read("continuous-form-concurrency"),
    activeHours: await read("continuous-form-active-hours"),
    cadenceKind: await read("continuous-form-cadence-kind"),
  };
}

/** 填写并提交创建表单（真实点击；覆盖字段可选）。 */
export async function submitCreateForm(window, { goal, scopePaths, overrides = {} }) {
  const fill = async (testId, value) => {
    await window.locator(`[data-testid="${testId}"]`).first().fill(value);
  };
  await fill("continuous-form-goal", goal);
  if (scopePaths !== undefined) await fill("continuous-form-scope-paths", scopePaths);
  for (const [testId, value] of Object.entries(overrides)) {
    await fill(testId, String(value));
  }
  await window.locator('[data-testid="continuous-form-submit"]').first().click();
}

/**
 * 等待指定 goal 的 Program 卡出现（创建命令真实完成）并返回 programId。
 * 修复依据：多 Program 共存于同一列表（每个用例各建一个），「取第一张卡」会锚定到
 * 旧 Program——run9 的 E-08 因此断言了别的 Program 的 suspended 轮（错误通过）。
 */
export async function waitForProgramCard(window, goal, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cards = await window.locator('[data-testid^="continuous-program-card-"]').all();
    for (const card of cards) {
      const text = (await card.textContent().catch(() => "")) ?? "";
      if (text.includes(goal)) {
        const testId = await card.getAttribute("data-testid");
        return testId.replace("continuous-program-card-", "");
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`[driver] 等待 Program（goal=${goal}）卡超时（>${timeoutMs}ms）`);
    }
    await sleep(300);
  }
}

/** 打开 Program 详情。 */
export async function openProgramDetail(window, programId, timeoutMs = 15_000) {
  await window
    .locator(`[data-testid="continuous-program-card-${programId}"]`)
    .first()
    .click({ timeout: timeoutMs });
  await window
    .locator('[data-testid="continuous-detail"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function clickDetailButton(window, testId, timeoutMs = 15_000) {
  await window.locator(`[data-testid="${testId}"]`).first().click({ timeout: timeoutMs });
}

export async function clickRunNow(window) {
  return clickDetailButton(window, "continuous-run-now");
}

export async function clickPause(window) {
  return clickDetailButton(window, "continuous-pause");
}

export async function clickResume(window) {
  return clickDetailButton(window, "continuous-resume");
}

export async function clickStopCurrent(window) {
  await clickDetailButton(window, "continuous-stop-current");
  // 立即停止是破坏性操作，产品 UI 先弹确认框（useConfirmDialog）——真实点击「确认」
  // 后 stopCurrentCycle 命令才发出（run13 实测：只点按钮不发命令，确认框遮罩还挡住
  // 后续用例）。确认按钮 = confirm-dialog-confirm（shared test id）。
  const confirm = window.locator('[data-testid="confirm-dialog-confirm"]').first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click({ timeout: 5_000 });
  }
}

/** 读详情页状态徽标文本（状态不靠颜色，用文字表达——E-22 同源）。 */
export async function readDetailStatus(window) {
  return (
    (await window
      .locator('[data-testid="continuous-detail-status"]')
      .first()
      .textContent()
      .catch(() => null)) ?? null
  );
}

/** 读详情页在场的 Cycle 行 testid 后缀（cycleId 列表）。 */
export async function readCycleRows(window) {
  const rows = await window.locator('[data-testid^="continuous-cycle-row-"]').all();
  const ids = [];
  for (const row of rows) {
    ids.push((await row.getAttribute("data-testid")).replace("continuous-cycle-row-", ""));
  }
  return ids;
}

// ————————————————————————————— 事实收集 —————————————————————————————

/** tasks-index 只读事实（evidence.mjs collectSqliteFacts 的 Continuous 专用查询集）。 */
export async function readContinuousDbFacts(dataDir) {
  const empty = {
    programs: [],
    cycles: [],
    leases: [],
    usage: [],
    events: [],
    candidates: [],
    decisions: [],
    continuations: [],
  };
  if (!existsSync(dataDir)) return { ...empty, dbPath: null };
  const { collectSqliteFacts } = await import("./evidence.mjs");
  const dbPath = path.join(dataDir, ".cotaya", "v2", "tasks-index.sqlite");
  if (!existsSync(dbPath)) return { ...empty, dbPath, exists: false };
  const facts = await collectSqliteFacts(dbPath, {
    programs:
      "SELECT id, json_extract(config_json,'$.goal') AS goal, workspace_key, workspace_path, status, status_reason, execution_path, branch_name, next_cycle_at, template_id, template_version, config_json FROM continuous_program ORDER BY created_at",
    cycles:
      "SELECT id, program_id, sequence, status, trigger_key, execution_session_id, workflow_run_id, lease_epoch, health_state, base_commit, active_duration_ms, started_at, completed_at FROM continuous_cycle ORDER BY sequence",
    leases: "SELECT * FROM continuous_workspace_lease",
    usage:
      "SELECT cycle_id, state, pricing_version, reserved_cost_micros, estimated_cost_micros, reserved_tokens, actual_tokens FROM continuous_usage ORDER BY occurred_at",
    events: "SELECT type, count(*) as n FROM continuous_event GROUP BY type ORDER BY type",
    candidates: "SELECT id, program_id, status, fingerprint FROM continuous_candidate",
    decisions: "SELECT id, program_id, status, version, fingerprint FROM continuous_decision",
    continuations:
      "SELECT id, cycle_id, reason, status, version FROM continuous_continuation_request",
  });
  // collectSqliteFacts 把查询结果收在 rows 下；这里摊平成调用方直接可用的形状。
  return { dbPath, tables: facts.tables, ...facts.rows };
}

/** Program worktree 事实：目录、分支、基线 commit 与分支上提交数。 */
export async function readWorktreeFacts(repo) {
  const [branches, head] = await Promise.all([
    repo.listBranches(),
    repo.git(["rev-parse", "HEAD"]),
  ]);
  const continuousBranches = branches.filter((name) => name.startsWith("codex/continuous-"));
  const perBranch = [];
  for (const branch of continuousBranches) {
    // 修复依据：branch 与 ^main 必须是两个独立 argv——模板字符串拼成单参数时 git 报
    // ambiguous argument 'branch ^main'（run12/13 实测），整条 E-01 事实断言被误伤。
    const log = await repo.git(["log", "--oneline", branch, "^main"]);
    perBranch.push({ branch, commits: log.split("\n").filter(Boolean) });
  }
  return { head: head.trim(), branches, continuousBranches: perBranch };
}

/** provider 事实：请求数（commands.jsonl 行数）与已发布 usage 行。 */
export async function readProviderFacts(provider) {
  const facts = provider.facts();
  const countLines = async (file) => {
    try {
      return (await readFile(file, "utf8")).split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return {
    requestCount: facts.requestCount,
    usageRecords: await countLines(facts.usageFile),
    commandRecords: await countLines(facts.commandsFile),
    prices: facts.prices,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
