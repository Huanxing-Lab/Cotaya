// CT-04 预算准入集成测试：U-04（日预算与价格：原子预留、整数微美元、价格版本、unknown、
// timezone、跨日、Unlimited）、U-05 的额度拒绝部分、I-07（多请求并行/重复/未知 usage：
// reservation 不超发、幂等结算、费用与 token 持久化）、R-07（reservation 后 usage 前 kill：
// unknown 保留、晚到重复结算最多一次）、E-34 的大整数精度。
// 用例定义见 docs/testing/continuous.md §5/§6/§7；全部真实 SQLite（node:sqlite + 真实
// migration），进程死亡以「同一 DB 文件上新 repo/admission 实例」模拟（CT-01/03 同款）。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import {
  ContinuousAdmissionClosedError,
  ContinuousBudgetAdmission,
  ContinuousBudgetDeniedError,
} from "../../src/continuous/application/budgetAdmission.js";
import { dayWindowFor } from "../../src/continuous/domain/budgetPolicy.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct04-budget-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

interface Fixture {
  path: string;
  repo: SqliteContinuousRepository;
  admission: ContinuousBudgetAdmission;
  program: Program;
  cycle: Cycle;
  setNow: (at: number) => void;
  dispose: () => Promise<void>;
  /** 同一 DB 上的「下一个进程」（kill 模拟）。 */
  nextProcess: () => { repo: SqliteContinuousRepository; admission: ContinuousBudgetAdmission };
}

/** 单请求预留值（微美元整数）：与闸门同一份 shared 估算数学在此手算对照。 */
const PRICE_INPUT_PER_M = 333;
const PRICE_OUTPUT_PER_M = 150_000;
const CAPS = { inputTokenCap: 1_000, outputTokenCap: 1_000 };
const RESERVED_MICROS =
  Math.ceil((PRICE_INPUT_PER_M * CAPS.inputTokenCap) / 1_000_000) +
  Math.ceil((PRICE_OUTPUT_PER_M * CAPS.outputTokenCap) / 1_000_000); // 1 + 150 = 151
const RESERVED_TOKENS = CAPS.inputTokenCap + CAPS.outputTokenCap;

async function makeFixture(overrides: Partial<Program["budget"]> = {}): Fixture {
  dbCounter += 1;
  const path = join(tmpRoot, `tasks-${dbCounter}.sqlite`);
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  let now = Date.UTC(2026, 2, 7, 20, 0, 0); // 2026-03-07T20:00:00Z（NY 时区 15:00 EST）
  const clock = () => now;
  const build = () => {
    // busy timeout 放宽到 30s：并发用例在完整套件（多文件并行）下会与其它 fixture 争 IO，
    // BEGIN IMMEDIATE 的锁等待不是被测语义——被测的是「检查+落库」原子性本身。
    const repo = new SqliteContinuousRepository(path, 30_000);
    return {
      repo,
      admission: new ContinuousBudgetAdmission({ repository: repo, clock: { now: clock } }),
    };
  };
  const first = build();
  const program: Program = {
    id: nextId("program"),
    workspaceKey: "/repos/app",
    workspacePath: "/repos/app",
    revision: 1,
    goal: "持续改进桌面 UI",
    timeZone: "America/New_York",
    scope: {
      allowedPaths: ["packages/ui/src"],
      forbiddenPaths: [],
      forbiddenCapabilities: ["push", "merge"],
    },
    budget: { ...CONTINUOUS_DEFAULT_BUDGET, ...overrides },
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    authorization: {
      revision: 1,
      templateHash: "a".repeat(64),
      grantedAt: "2026-10-05T00:00:00Z",
    },
    templateId: "ui-ux-v1",
    templateVersion: "1",
    templateHash: "a".repeat(64),
    status: "active",
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
  const cycle: Cycle = {
    id: nextId("cycle"),
    programId: program.id,
    sequence: 1,
    triggerKey: "manual-1",
    trigger: { kind: "manual" },
    status: "running",
    configurationSnapshot: {},
    scriptText: "return {}",
    scriptHash: "b".repeat(64),
    executionSessionId: nextId("session"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    leaseEpoch: 1,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    createdAt: now,
    updatedAt: now,
  };
  await first.repo.insertProgram(program);
  await first.repo.insertCycle(cycle);
  return {
    path,
    repo: first.repo,
    admission: first.admission,
    program,
    cycle,
    setNow: (at: number) => {
      now = at;
    },
    dispose: async () => {
      first.repo.close();
    },
    nextProcess: () => build(),
  };
}

function reserveInput(fixture: Fixture, requestKey: string, overrides = {}) {
  return {
    programId: fixture.program.id,
    cycleId: fixture.cycle.id,
    requestKey,
    provider: "fixture",
    model: "fixture-model",
    pricingVersion: "prices-v1",
    reservedCostMicros: RESERVED_MICROS,
    reservedTokens: RESERVED_TOKENS,
    ...overrides,
  };
}

test("U-04 原子预留落库：整数微美元向上取整、价格版本、token 预留基数", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.admission.reserve(reserveInput(fixture, "req-1"));
    const record = await fixture.repo.getUsageRecord("req-1");
    assert.ok(record, "reservation 必须落库");
    assert.equal(record.state, "reserved");
    assert.equal(record.pricingVersion, "prices-v1");
    assert.equal(record.reservedCostMicros, 151);
    assert.equal(record.reservedTokens, RESERVED_TOKENS);
    assert.equal(record.provider, "fixture");
    assert.equal(record.occurredAt, Date.UTC(2026, 2, 7, 20, 0, 0), "发生时间取预留时刻");
  } finally {
    await fixture.dispose();
  }
});

test("U-04 额度拒绝：无行落库、结构化 limitKind 与观测快照", async () => {
  // 日 200 微美元只够一次 151 的预留；第二次必须拒绝且不落行。
  const fixture = await makeFixture({ dailyCostUsdMicros: 200 });
  try {
    await fixture.admission.reserve(reserveInput(fixture, "req-1"));
    await assert.rejects(
      fixture.admission.reserve(reserveInput(fixture, "req-2")),
      (error: unknown) => {
        assert.ok(error instanceof ContinuousBudgetDeniedError);
        assert.equal(error.code, "budget_denied");
        assert.equal(error.limitKind, "daily_cost");
        assert.equal(error.observed.daily?.unsettledCostMicros, 151);
        return true;
      },
    );
    assert.equal(await fixture.repo.getUsageRecord("req-2"), null, "拒绝不落行");
  } finally {
    await fixture.dispose();
  }
});

test("U-04 单轮 token/费用上限独立生效；Unlimited 只取消日额度", async () => {
  // Unlimited（null）+ 单轮费用 151 微美元（恰够一次）：第二笔同额预留按单轮费用拒绝。
  const fixture = await makeFixture({ dailyCostUsdMicros: null, perCycleCostUsdMicros: 151 });
  try {
    await fixture.admission.reserve(reserveInput(fixture, "req-1"));
    await assert.rejects(
      fixture.admission.reserve(reserveInput(fixture, "req-2")),
      (error: unknown) =>
        error instanceof ContinuousBudgetDeniedError && error.limitKind === "cycle_cost",
    );
    // 单独把 token 上限压到预留基数之下：token 拒绝路径。
    const tokenFixture = await makeFixture({ dailyCostUsdMicros: null, perCycleTokens: 1_999 });
    try {
      await assert.rejects(
        tokenFixture.admission.reserve(reserveInput(tokenFixture, "req-t")),
        (error: unknown) =>
          error instanceof ContinuousBudgetDeniedError && error.limitKind === "cycle_token",
      );
    } finally {
      await tokenFixture.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("I-07 多请求并行预留不超发：双连接并发竞争，账本不超额度（原子事务，不靠内存锁）", async () => {
  // 日额度 4×151：两条连接各发 4 笔并发预留，恰好 4 笔准入、账本预留总额 ≤ 限值。
  const fixture = await makeFixture({ dailyCostUsdMicros: 4 * RESERVED_MICROS });
  const second = fixture.nextProcess();
  try {
    const requests = Array.from({ length: 4 }, (_, index) => index);
    const outcomes = await Promise.allSettled(
      requests.flatMap((index) => [
        fixture.admission.reserve(reserveInput(fixture, `a-${index}`)),
        second.admission.reserve(reserveInput(fixture, `b-${index}`)),
      ]),
    );
    const admitted = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const denied = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected" && outcome.reason instanceof ContinuousBudgetDeniedError,
    );
    assert.equal(admitted.length, 4, "恰好 4 笔准入");
    assert.equal(
      denied.length,
      4,
      `其余全部按额度拒绝（实际拒绝详情: ${outcomes
        .filter((outcome) => outcome.status === "rejected")
        .map((outcome) => String((outcome as PromiseRejectedResult).reason))
        .join(" | ")}）`,
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected" && !(outcome.reason instanceof ContinuousBudgetDeniedError))
        throw outcome.reason;
    }
    // 每条预留都读了同一额度，准入判定必须全部在事务内看到彼此的行。
    const summary = await fixture.repo.summarizeUsage({ programId: fixture.program.id });
    assert.equal(
      summary.unsettledCostMicros,
      4 * RESERVED_MICROS,
      "并发预留恰好打满日额度，绝不超发",
    );
    const rows: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      rows.push(await fixture.repo.getUsageRecord(`a-${index}`));
      rows.push(await fixture.repo.getUsageRecord(`b-${index}`));
    }
    assert.equal(
      rows.filter((row) => row !== null).length,
      4,
      "恰好 4 行 reservation 落库（其余被拒）",
    );
  } finally {
    second.repo.close();
    await fixture.dispose();
  }
});

test("U-04 timezone 日窗口与跨日：DST 边界窗口长度、晚到结算归原窗口", async () => {
  const fixture = await makeFixture({ dailyCostUsdMicros: 200 });
  try {
    // 窗口数学（纯函数直测）：2026-03-08 NY 进入 DST（02:00 EST→03:00 EDT），当天 23 小时。
    const t1 = Date.UTC(2026, 2, 7, 20, 0, 0);
    const t2 = Date.UTC(2026, 2, 8, 6, 0, 0);
    const window1 = dayWindowFor(t1, "America/New_York");
    const window2 = dayWindowFor(t2, "America/New_York");
    assert.equal(window1.key, "2026-03-07");
    assert.equal(window2.key, "2026-03-08");
    assert.equal(window1.endMs - window1.startMs, 24 * 3_600_000);
    assert.equal(window2.endMs - window2.startMs, 23 * 3_600_000, "DST 日 23 小时");
    assert.equal(window1.endMs, window2.startMs, "相邻窗口无缝衔接");

    // 第一天：151/200 准入；同日第二笔拒绝（daily_cost）。
    await fixture.admission.reserve(reserveInput(fixture, "day1-1"));
    await assert.rejects(
      fixture.admission.reserve(reserveInput(fixture, "day1-2")),
      (error: unknown) =>
        error instanceof ContinuousBudgetDeniedError && error.limitKind === "daily_cost",
    );
    // 跨日（同一 Cycle 内）：新窗口额度独立，准入。
    fixture.setNow(t2);
    await fixture.admission.reserve(reserveInput(fixture, "day2-1"));
    // 晚到 usage：day1 的结算发生在 day2——按预留时的 occurred_at 归原窗口（§9）。
    await fixture.admission.settle({
      requestKey: "day1-1",
      actualTokens: 900,
      estimatedCostMicros: 120,
      usage: { totalTokens: 900 },
    });
    const day1 = await fixture.repo.summarizeUsage({
      programId: fixture.program.id,
      windowFromMs: window1.startMs,
      windowToMs: window1.endMs,
    });
    const day2 = await fixture.repo.summarizeUsage({
      programId: fixture.program.id,
      windowFromMs: window2.startMs,
      windowToMs: window2.endMs,
    });
    assert.equal(day1.settledCostMicros, 120, "晚到结算计入原（day1）窗口");
    assert.equal(day1.unsettledCostMicros, 0);
    assert.equal(day2.settledCostMicros, 0);
    assert.equal(day2.unsettledCostMicros, RESERVED_MICROS, "day2 只有自己那笔预留");
  } finally {
    await fixture.dispose();
  }
});

test("I-07 幂等结算与未知保留：同值重放 no-op、不同值冲突、unknown 保留、晚到结算归位", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.admission.reserve(reserveInput(fixture, "req-1"));
    await fixture.admission.settle({
      requestKey: "req-1",
      actualTokens: 800,
      estimatedCostMicros: 100,
      usage: { totalTokens: 800 },
    });
    // 相同 usage 重放：no-op（不抛、不双计）。
    await fixture.admission.settle({
      requestKey: "req-1",
      actualTokens: 800,
      estimatedCostMicros: 100,
      usage: { totalTokens: 800 },
    });
    const settled = await fixture.repo.getUsageRecord("req-1");
    assert.equal(settled?.state, "settled");
    assert.equal(settled?.estimatedCostMicros, 100);
    // 不同值重复结算：冲突拒绝（同一 requestKey 两份 usage 是账本错误）。
    await assert.rejects(
      fixture.admission.settle({
        requestKey: "req-1",
        actualTokens: 999,
        estimatedCostMicros: 999,
        usage: {},
      }),
      (error: unknown) => (error as { kind?: string }).kind === "already_settled",
    );
    // 无证据终局：unknown 保留 reservation，不清零。
    await fixture.admission.reserve(reserveInput(fixture, "req-2"));
    await fixture.admission.markUnknown("req-2");
    const unknown = await fixture.repo.getUsageRecord("req-2");
    assert.equal(unknown?.state, "unknown");
    assert.equal(unknown?.reservedCostMicros, RESERVED_MICROS, "unknown 保留预留");
    // 晚到 usage 仍可结算已有 ticket（unknown → settled）。
    await fixture.admission.settle({
      requestKey: "req-2",
      actualTokens: 700,
      estimatedCostMicros: 90,
      usage: { totalTokens: 700 },
    });
    const recovered = await fixture.repo.getUsageRecord("req-2");
    assert.equal(recovered?.state, "settled");
    assert.equal(recovered?.actualTokens, 700);
  } finally {
    await fixture.dispose();
  }
});

test("R-07 reservation 后 usage 前 kill：新进程读到 unknown 语义保留，仅显式核销消除", async () => {
  const fixture = await makeFixture();
  await fixture.admission.reserve(reserveInput(fixture, "req-1"));
  // kill：同 DB 上的「下一个进程」。
  const next = fixture.nextProcess();
  try {
    const summary = await next.repo.summarizeUsage({ programId: fixture.program.id });
    assert.equal(summary.unsettledCostMicros, RESERVED_MICROS, "无静默归零");
    // 新进程晚到重复结算最多一次：第一份 usage 落账，重放同值 no-op。
    await next.admission.settle({
      requestKey: "req-1",
      actualTokens: 800,
      estimatedCostMicros: 110,
      usage: { totalTokens: 800 },
    });
    await next.admission.settle({
      requestKey: "req-1",
      actualTokens: 800,
      estimatedCostMicros: 110,
      usage: { totalTokens: 800 },
    });
    // unknown 行的显式核销：审计事件 + 零结算；settled 行拒绝核销。
    await next.admission.reserve(reserveInput(fixture, "req-2"));
    await next.admission.markUnknown("req-2");
    await next.admission.writeOffUnknown(
      "req-2",
      fixture.program.id,
      "用户核对 provider 账单后核销",
    );
    const writtenOff = await next.repo.getUsageRecord("req-2");
    assert.equal(writtenOff?.state, "settled");
    assert.equal(writtenOff?.estimatedCostMicros, 0);
    await assert.rejects(
      next.admission.writeOffUnknown("req-2", fixture.program.id, "再次核销"),
      (error: unknown) => (error as { kind?: string }).kind === "not_unknown",
    );
    await assert.rejects(
      next.admission.writeOffUnknown("req-1", fixture.program.id, "settled 不能核销"),
      (error: unknown) => (error as { kind?: string }).kind === "not_unknown",
    );
    // 核销审计事件落库（裸连接核对数据库事实）。
    const facts = new DatabaseSync(fixture.path);
    try {
      const auditRow = facts
        .prepare(
          "SELECT payload_json FROM continuous_event WHERE event_key LIKE 'usage_write_off:%'",
        )
        .all() as { payload_json: string }[];
      assert.equal(auditRow.length, 1, "核销恰好一条审计事件");
      assert.equal(JSON.parse(auditRow[0]!.payload_json).requestKey, "req-2");
    } finally {
      facts.close();
    }
  } finally {
    next.repo.close();
    await fixture.dispose();
  }
});

test("E-34 大整数：不安全整数预留拒绝；大而安全的整数无损持久化", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      fixture.admission.reserve(
        reserveInput(fixture, "unsafe", {
          reservedTokens: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
      (error: unknown) =>
        error instanceof ContinuousBudgetDeniedError && error.limitKind === "unsafe_integer",
    );
    // 10 亿 token（规格默认单轮上限量级）经整数路径无损落库。
    const big = await makeFixture({
      perCycleCostUsdMicros: CONTINUOUS_DEFAULT_BUDGET.perCycleCostUsdMicros,
    });
    try {
      await big.admission.reserve(
        reserveInput(big, "big", { reservedTokens: 1_000_000_000, reservedCostMicros: 90_000_000 }),
      );
      const record = await big.repo.getUsageRecord("big");
      assert.equal(record?.reservedTokens, 1_000_000_000);
      assert.equal(record?.reservedCostMicros, 90_000_000);
    } finally {
      await big.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("E-08 前置：suspended Cycle 冻结新请求（在途票据不受影响）", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.admission.reserve(reserveInput(fixture, "req-1"));
    await fixture.repo.saveCycle({ ...fixture.cycle, status: "suspended" });
    await assert.rejects(
      fixture.admission.reserve(reserveInput(fixture, "req-2")),
      (error: unknown) => error instanceof ContinuousAdmissionClosedError,
    );
    // 已有 ticket 的晚到结算不受挂起影响（§6.1 在途操作到达安全边界）。
    await fixture.admission.settle({
      requestKey: "req-1",
      actualTokens: 800,
      estimatedCostMicros: 100,
      usage: { totalTokens: 800 },
    });
    const record = await fixture.repo.getUsageRecord("req-1");
    assert.equal(record?.state, "settled");
  } finally {
    await fixture.dispose();
  }
});
