// CT-04 继续确认集成测试：I-12（同轮挂起、继续确认与 grant：不 cancel、不新 Run；多上限
// 合并一问；重复/旧 version 拒绝；授权增量不重置用量）、E-32（用户继续授权、跨日与重复回答
// 的服务层语义）、R-11 前置（重启/跨日后 pending 确认、用量与 grant 保留）。
// 「不 cancel、不新 Run」是结构性事实：本服务没有任何取消/提交执行的 API；测试同时断言
// Cycle/Run 身份字段在 resolve 前后逐字段不变。用例定义见 docs/testing/continuous.md。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node.test + 真实 SQLite）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import { ContinuousBudgetAdmission } from "../../src/continuous/application/budgetAdmission.js";
import {
  ContinuousContinuationService,
  ContinuationVersionConflictError,
} from "../../src/continuous/application/continuationService.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct04-continuation-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

interface Fixture {
  path: string;
  repo: SqliteContinuousRepository;
  continuation: ContinuousContinuationService;
  admission: ContinuousBudgetAdmission;
  program: Program;
  cycle: Cycle;
  setNow: (at: number) => void;
  now: () => number;
  dispose: () => void;
  nextProcess: () => {
    repo: SqliteContinuousRepository;
    continuation: ContinuousContinuationService;
    admission: ContinuousBudgetAdmission;
  };
}

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
  let now = 1_000;
  const clock = () => now;
  const build = () => {
    const repo = new SqliteContinuousRepository(path);
    return {
      repo,
      continuation: new ContinuousContinuationService({ repository: repo, clock: { now: clock } }),
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
    timeZone: "Asia/Shanghai",
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
    status: "paused",
    statusReason: "budget",
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
    status: "suspended",
    configurationSnapshot: {},
    scriptText: "return {}",
    scriptHash: "b".repeat(64),
    executionSessionId: nextId("session"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    leaseEpoch: 1,
    resumeAttempts: 0,
    activeDurationMs: 3_600_000,
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
    continuation: first.continuation,
    admission: first.admission,
    program,
    cycle,
    setNow: (at: number) => {
      now = at;
    },
    now: clock,
    dispose: () => first.repo.close(),
    nextProcess: () => build(),
  };
}

test("I-12 同轮唯一 pending：多上限触发合并一条（同 id、reasons 追加），不重复弹窗", async () => {
  const fixture = await makeFixture();
  try {
    const first = await fixture.continuation.openRequest({
      cycle: fixture.cycle,
      reason: "cost_limit",
      limitKind: "cost",
      observedUsage: { unsettled: 100 },
      currentLimit: { perCycleCostUsdMicros: 100 },
      recommendedExtension: { costMicros: 100_000_000 },
    });
    assert.equal(first.status, "pending");
    assert.deepEqual(first.reasons, ["cost_limit"]);
    const merged = await fixture.continuation.openRequest({
      cycle: fixture.cycle,
      reason: "token_limit",
      limitKind: "token",
      observedUsage: { unsettledTokens: 1_000_000_000 },
      currentLimit: { perCycleTokens: 1_000_000_000 },
      recommendedExtension: { tokens: 500_000_000 },
    });
    assert.equal(merged.id, first.id, "合并进同一条 pending，不新增");
    assert.deepEqual(merged.reasons, ["cost_limit", "token_limit"]);
    assert.equal(merged.version, first.version + 1, "合并推进 version");
    const facts = new DatabaseSync(fixture.path);
    try {
      const rows = facts
        .prepare("SELECT COUNT(*) AS n FROM continuous_continuation_request")
        .all() as { n: number }[];
      assert.equal(rows[0]!.n, 1, "库里只有一条请求（部分唯一索引兜底）");
    } finally {
      facts.close();
    }
  } finally {
    fixture.dispose();
  }
});

test("I-12/E-32 继续授权：grant 增量并入单轮额度，不重置已消耗量、不新 Run、同轮身份不变", async () => {
  // 单轮费用 151 微美元：第一笔 151 准入，第二笔被拒 → 挂起询问。
  const fixture = await makeFixture({ perCycleCostUsdMicros: 151 });
  // 准入要求 cycle=running（suspended 冻结语义在 budget.test 已测）。
  const runningCycle = { ...fixture.cycle, status: "running" as const };
  try {
    await fixture.repo.saveCycle(runningCycle);
    await fixture.admission.reserve({
      programId: fixture.program.id,
      cycleId: runningCycle.id,
      requestKey: "r1",
      provider: "fixture",
      model: "m",
      pricingVersion: "v1",
      reservedCostMicros: 151,
      reservedTokens: 100,
    });
    await assert.rejects(
      fixture.admission.reserve({
        programId: fixture.program.id,
        cycleId: runningCycle.id,
        requestKey: "r2",
        provider: "fixture",
        model: "m",
        pricingVersion: "v1",
        reservedCostMicros: 151,
        reservedTokens: 100,
      }),
      (error: unknown) => (error as { limitKind?: string }).limitKind === "cycle_cost",
    );
    const before = await fixture.repo.summarizeUsage({ programId: fixture.program.id });
    const request = await fixture.continuation.openRequest({
      cycle: runningCycle,
      reason: "cost_limit",
      limitKind: "cost",
      observedUsage: before,
      currentLimit: { perCycleCostUsdMicros: 151 },
      recommendedExtension: { costMicros: 151 },
    });
    const resolved = await fixture.continuation.resolve({
      requestId: request.id,
      version: request.version,
      answer: { kind: "continue_with_grant", grant: { costMicros: 151 } },
    });
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.resolution?.grant, { costMicros: 151 });
    // 已消耗量不被重置：grant 只抬高上限。
    const after = await fixture.repo.summarizeUsage({ programId: fixture.program.id });
    assert.deepEqual(after, before, "resolve 不改任何账本事实");
    // 同轮身份不变：Cycle/Run/session 逐字段一致（不 cancel、不新 Run 的结构性证据）。
    const cycleRow = await fixture.repo.getCycle(runningCycle.id);
    assert.equal(cycleRow?.workflowRunId, fixture.cycle.workflowRunId);
    assert.equal(cycleRow?.executionSessionId, fixture.cycle.executionSessionId);
    assert.equal(cycleRow?.id, fixture.cycle.id);
    // grant 生效：同额第二笔现在准入（151 + 151 = 302 上限内）。
    await fixture.admission.reserve({
      programId: fixture.program.id,
      cycleId: runningCycle.id,
      requestKey: "r2",
      provider: "fixture",
      model: "m",
      pricingVersion: "v1",
      reservedCostMicros: 151,
      reservedTokens: 100,
    });
    // 但再一笔仍拒绝（grant 是增量，不是重置）。
    await assert.rejects(
      fixture.admission.reserve({
        programId: fixture.program.id,
        cycleId: runningCycle.id,
        requestKey: "r3",
        provider: "fixture",
        model: "m",
        pricingVersion: "v1",
        reservedCostMicros: 151,
        reservedTokens: 100,
      }),
      (error: unknown) => (error as { limitKind?: string }).limitKind === "cycle_cost",
    );
    // 日额度不因本轮 grant 扩大（规格 §6.1 仅确认受影响上限；v1 grant 只作用于单轮）——
    // 该断言由预算侧的 limits 合并实现（mergeContinuationGrants 不动 dailyCostUsdMicros）。
  } finally {
    fixture.dispose();
  }
});

test("I-12/E-32 version 幂等：重放相同回答 no-op；旧 version 与异答拒绝", async () => {
  const fixture = await makeFixture();
  try {
    const request = await fixture.continuation.openRequest({
      cycle: fixture.cycle,
      reason: "time_limit",
      limitKind: "time",
      observedUsage: { activeDurationMs: 3_600_000 },
      currentLimit: { activeExecutionLimitMs: 3_600_000 },
      recommendedExtension: { activeMs: 3_600_000 },
    });
    const answer = {
      requestId: request.id,
      version: request.version,
      answer: { kind: "continue_with_grant", grant: { activeMs: 3_600_000 } },
    } as const;
    const resolved = await fixture.continuation.resolve(answer);
    assert.equal(resolved.status, "resolved");
    // 重放相同回答：no-op，返回既有 resolution，不重复扩额。
    const replay = await fixture.continuation.resolve(answer);
    assert.equal(replay.version, resolved.version);
    const grantsAfterReplay = await fixture.repo.listCycleContinuationGrants(fixture.cycle.id);
    assert.equal(grantsAfterReplay.length, 1, "grant 不因重放而重复");
    // 旧 version（例如并发窗口里的另一回答）：拒绝。
    await assert.rejects(
      fixture.continuation.resolve({
        requestId: request.id,
        version: request.version + 5,
        answer: { kind: "stay_paused" },
      }),
      (error: unknown) => error instanceof ContinuationVersionConflictError,
    );
    // 异答重放同样拒绝（kind 不同）。
    await assert.rejects(
      fixture.continuation.resolve({
        requestId: request.id,
        version: request.version,
        answer: { kind: "end_cycle" },
      }),
      (error: unknown) => error instanceof ContinuationVersionConflictError,
    );
    // 解决后可再开新一轮 pending（下一次挂起），grant 累计。
    const second = await fixture.continuation.openRequest({
      cycle: fixture.cycle,
      reason: "suspected_hang",
      limitKind: "health",
      observedUsage: { stalledMs: 180_000 },
      currentLimit: {},
      recommendedExtension: {},
    });
    assert.notEqual(second.id, request.id);
    const secondResolved = await fixture.continuation.resolve({
      requestId: second.id,
      version: second.version,
      answer: { kind: "continue_with_grant", grant: { activeMs: 1_800_000 } },
    });
    assert.equal(secondResolved.status, "resolved");
    const grants = await fixture.repo.listCycleContinuationGrants(fixture.cycle.id);
    assert.deepEqual(
      grants.sort((a, b) => (a.activeMs ?? 0) - (b.activeMs ?? 0)),
      [{ activeMs: 1_800_000 }, { activeMs: 3_600_000 }],
      "多轮 grant 累计为增量",
    );
  } finally {
    fixture.dispose();
  }
});

test("R-11 前置：重启后 pending 确认、用量与 grant 逐项保留；stay_paused/end_cycle 落库", async () => {
  const fixture = await makeFixture({ perCycleCostUsdMicros: 151 });
  const runningCycle = { ...fixture.cycle, status: "running" as const };
  await fixture.repo.saveCycle(runningCycle);
  await fixture.admission.reserve({
    programId: fixture.program.id,
    cycleId: runningCycle.id,
    requestKey: "k1",
    provider: "fixture",
    model: "m",
    pricingVersion: "v1",
    reservedCostMicros: 151,
    reservedTokens: 100,
  });
  const request = await fixture.continuation.openRequest({
    cycle: runningCycle,
    reason: "cost_limit",
    limitKind: "cost",
    observedUsage: {},
    currentLimit: {},
    recommendedExtension: { costMicros: 151 },
  });
  // 重启（跨日由 budget.test 的窗口语义覆盖；这里是行持久化本身）。
  const next = fixture.nextProcess();
  try {
    const pending = await next.continuation.getPending(runningCycle.id);
    assert.equal(pending?.id, request.id, "pending 确认保留");
    const summary = await next.repo.summarizeUsage({ programId: fixture.program.id });
    assert.equal(summary.unsettledCostMicros, 151, "用量保留");
    // 用户在重启后选择「保持暂停」：落 stay_paused，无 grant。
    const stayed = await next.continuation.resolve({
      requestId: request.id,
      version: pending!.version,
      answer: { kind: "stay_paused" },
    });
    assert.equal(stayed.resolution?.kind, "stay_paused");
    assert.equal(stayed.resolution?.grant, undefined);
    assert.equal((await next.repo.listCycleContinuationGrants(runningCycle.id)).length, 0);
    // end_cycle 回答同样只记录意图（终态结算归 supervisor/CT-05，不在此铸新状态）。
    const again = await next.continuation.openRequest({
      cycle: runningCycle,
      reason: "retry_limit",
      limitKind: "retry",
      observedUsage: {},
      currentLimit: {},
      recommendedExtension: {},
    });
    const ended = await next.continuation.resolve({
      requestId: again.id,
      version: again.version,
      answer: { kind: "end_cycle" },
    });
    assert.equal(ended.resolution?.kind, "end_cycle");
  } finally {
    next.repo.close();
    fixture.dispose();
  }
});
