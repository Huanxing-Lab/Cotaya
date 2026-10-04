// CT-07 周期与执行权集成测试（服务层）：U-07 cadence/trigger 纯规则、I-11 workspace lease
// （两 Host/旧 owner/过期接管/旧 epoch 副作用拒绝）、E-16 重复 wake 幂等、E-18 错过多轮
// 只唤醒一次。用例定义见 docs/testing/continuous.md §5/§6/§8。
//
// 真实 SQLite（CT-01 migration 建库）+ 注入的执行端口替身（可达性/终态可编排）；
// workspace 准备用替身（真实 Git 路径在 workspace.test.ts 覆盖）。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node.test）。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import {
  CONTINUOUS_LEASE_TERM_MS,
  ContinuousLeaseLostError,
  acquireCycleLease,
  renewCycleLease,
  releaseCycleLease,
  requireLeaseEpoch,
} from "../../src/continuous/application/workspaceLease.js";
import {
  CONTINUOUS_RECOVERY_BACKOFF_MS,
  isProgramDue,
  manualTriggerKey,
  nextCycleAtFor,
  recoveryBackoffMs,
  scheduledTriggerKey,
} from "../../src/continuous/domain/cadencePolicy.js";
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import { ContinuousRecoveryService } from "../../src/continuous/application/recovery.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
import type {
  ContinuousExecutionPort,
  ContinuousReportItem,
  ExecutionReference,
  ExecutionState,
  HealthSnapshot,
  ManagedCycleInput,
  WorkspacePreparationPort,
} from "../../src/continuous/application/ports.js";

// ── fixture ──────────────────────────────────────────

const TEMPLATE_TEXT = "phase('观察');\nreturn {};\n";
const TEMPLATE_HASH = createHash("sha256").update(TEMPLATE_TEXT, "utf8").digest("hex");
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct07-sched-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

function newDatabasePath(): string {
  dbCounter += 1;
  return join(tmpRoot, `tasks-index-${dbCounter}.sqlite`);
}

async function freshRepository(): Promise<SqliteContinuousRepository> {
  const path = newDatabasePath();
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  const repo = new SqliteContinuousRepository(path, 30_000);
  await repo.ensureReady();
  return repo;
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: nextId("program"),
    workspaceKey: "/repos/app",
    workspacePath: "/repos/app",
    revision: 1,
    goal: "持续改进桌面 UI",
    timeZone: "America/New_York",
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push", "merge"] },
    budget: CONTINUOUS_DEFAULT_BUDGET,
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    authorization: { revision: 1, templateHash: TEMPLATE_HASH, grantedAt: "2026-10-05T00:00:00Z" },
    templateId: "ui-ux-v1",
    templateVersion: "1",
    templateHash: TEMPLATE_HASH,
    status: "active",
    nextCycleAt: 1_000,
    consecutiveFailures: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** 可编排执行端口替身：可达性/终态由测试翻转（I-11 的旧 owner 核对需要 inspectHealth）。 */
class FakeExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  allItems: ContinuousReportItem[] = [];
  calls: string[] = [];
  reachable = true;
  state: ExecutionState = { runId: "", status: "running", resumable: false };
  private sequence = 0;

  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
    this.submitted.push(input);
    this.state = { ...this.state, runId: input.workflowRunId };
    this.calls.push("submitOnce");
    return Promise.resolve({
      cycleId: input.cycleId,
      executionSessionId: input.executionSessionId,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId,
    });
  }

  inspect(): Promise<ExecutionState> {
    return Promise.resolve({ ...this.state });
  }

  inspectHealth(ref: ExecutionReference): Promise<HealthSnapshot> {
    // 与真实适配器同语义：可达性=注册表活条目（isLiveRun）——未接受/终态的 Run 不可达。
    return Promise.resolve({
      runId: ref.workflowRunId,
      actorIds: [],
      ownerEpoch: 0,
      reachable: this.reachable && this.state.status === "running",
    });
  }

  resume(): Promise<void> {
    this.calls.push("resume");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push("stop");
    return Promise.resolve();
  }

  waitForQuiescence(): Promise<void> {
    this.calls.push("waitForQuiescence");
    return Promise.resolve();
  }

  readReports(
    ref: ExecutionReference,
    afterSequence: number,
  ): Promise<{ items: ContinuousReportItem[]; nextCursor: number }> {
    void ref;
    const pending = this.allItems
      .filter((item) => item.journalSequence > afterSequence)
      .sort((left, right) => left.journalSequence - right.journalSequence);
    if (pending.length === 0) return Promise.resolve({ items: [], nextCursor: afterSequence });
    return Promise.resolve({
      items: pending,
      nextCursor: pending[pending.length - 1]!.journalSequence,
    });
  }

  suspendAtSafeBoundary(): Promise<void> {
    this.calls.push("suspendAtSafeBoundary");
    return Promise.resolve();
  }

  resumeSuspended(): Promise<void> {
    this.calls.push("resumeSuspended");
    return Promise.resolve();
  }

  finish(status: ExecutionState["status"], extra: Partial<ExecutionState> = {}): void {
    this.state = { ...this.state, status, ...extra };
  }
}

const fakeWorkspace: WorkspacePreparationPort = {
  prepare: async (request) => ({
    executionPath: join(tmpRoot, "worktrees", request.programId),
    branchName: request.branchName,
    baseCommit: "f".repeat(40),
  }),
  release: async () => {},
  createCandidateCheckpoint: async () => {
    throw new Error("scheduler.test 不驱动候选检查点");
  },
  restoreCandidateFiles: async () => [],
};

const templateSource: ContinuousTemplateSource = {
  resolve: () => ({ scriptText: TEMPLATE_TEXT, scriptHash: TEMPLATE_HASH }),
};

type SupervisorDeps = ConstructorParameters<typeof ContinuousSupervisor>[0];

function makeRecovery(
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
  options: { now?: () => number } = {},
): { recovery: ContinuousRecoveryService; supervisor: ContinuousSupervisor } {
  const clock = {
    now: options.now ?? (() => 10_000),
    timeZone: () => "America/New_York",
    schedule: (callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, Math.min(delayMs, 1));
      // unref：监督循环的轮询定时器不阻止测试进程退出（未终结的监督随进程消亡即可）。
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const deps: SupervisorDeps = {
    repository,
    execution,
    workspace: fakeWorkspace,
    clock,
    templateSource,
    pollIntervalMs: 1,
  };
  const supervisor = new ContinuousSupervisor(deps);
  const recovery = new ContinuousRecoveryService({ repository, execution, supervisor, clock });
  return { recovery, supervisor };
}

function makeCycle(program: Program, triggerKey: string, overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: nextId("cycle"),
    programId: program.id,
    sequence: 1,
    triggerKey,
    trigger: { kind: "interval" },
    status: "running",
    configurationSnapshot: {},
    scriptText: TEMPLATE_TEXT,
    scriptHash: TEMPLATE_HASH,
    executionSessionId: nextId("sess"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    leaseEpoch: 1,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

// ── U-07：cadence / trigger 纯规则 ─────────────────────────────

test("U-07: interval 于上轮结束后计算；daily 按持久化时区（含 DST）", () => {
  const interval = makeProgram();
  // interval：以结算时刻为基准 +N 小时（「上一轮结束后 6 小时」，不是从到期时刻顺延）。
  const settledAt = 2_000_000;
  assert.equal(nextCycleAtFor(interval, settledAt), settledAt + 6 * 3_600_000);

  const daily = makeProgram({
    cadence: { kind: "daily", localTime: "02:30", timeZone: "America/New_York" },
  });
  // 冬季（EST, UTC-5）：目标本地 02:30 = 当日 07:30Z。
  const winterEvening = Date.UTC(2026, 0, 15, 22, 0);
  assert.equal(nextCycleAtFor(daily, winterEvening), Date.UTC(2026, 0, 16, 7, 30));
  // 夏季（EDT, UTC-4）：目标本地 02:30 = 当日 06:30Z——持久化时区决定偏移，不随系统漂移。
  const summerEvening = Date.UTC(2026, 5, 15, 22, 0);
  assert.equal(nextCycleAtFor(daily, summerEvening), Date.UTC(2026, 5, 16, 6, 30));
  // 春令时边界（2026-03-08 02:00 跳到 03:00，本地 02:30 不存在）：产出仍是合法的未来时点
  // （落在跳变后的 03:30 本地），不抛错、不回退到过去。
  const beforeJump = Date.UTC(2026, 2, 7, 12, 0);
  const afterSpringForward = nextCycleAtFor(daily, beforeJump);
  assert.ok(afterSpringForward > beforeJump);
  assert.ok(afterSpringForward <= Date.UTC(2026, 2, 8, 12, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(afterSpringForward));
  const local = `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`;
  assert.ok(local === "03:30" || local === "02:30", `DST 日的本地时刻应为合法时点，得到 ${local}`);
});

test("U-07: manual 用请求 ID、scheduled 用稳定 key、错过多轮合并为一次", () => {
  // manual：同一请求 ID 的重发（含 ACK 丢失）命中同一 key——不靠新随机 ID 补偿。
  assert.equal(manualTriggerKey("req-1"), "manual:req-1");
  const program = makeProgram({ id: "prog-7", revision: 3 });
  // scheduled：Program/revision/到期时间三元组；同一到期窗口的重复 wake 稳定命中同一 key。
  const key = scheduledTriggerKey(program, 123_456);
  assert.equal(key, "scheduled:prog-7:3:123456");
  assert.equal(scheduledTriggerKey(program, 123_456), key);
  // 到期时刻变化（下一窗口）或 revision 变化（重新授权）都是新的 key——旧窗口不复活。
  assert.notEqual(scheduledTriggerKey(program, 123_457), key);
  assert.notEqual(scheduledTriggerKey({ ...program, revision: 4 }, 123_456), key);
  // 错过多轮只唤醒一次：nextCycleAtFor 从「现在」取下一个未来时点——不生成补跑队列。
  const missed = makeProgram({ nextCycleAt: 1_000 });
  const next = nextCycleAtFor(missed, 1_000_000);
  assert.ok(next > 1_000_000, "错过多轮后的下一次计划必须是未来时点（单值，非队列）");
});

test("U-07: 到期判定排除 paused/failed/completed/归档/未到期", () => {
  const now = 5_000;
  assert.ok(isProgramDue(makeProgram({ status: "active", nextCycleAt: now }), now));
  assert.ok(isProgramDue(makeProgram({ status: "sleeping", nextCycleAt: now - 1 }), now));
  assert.ok(!isProgramDue(makeProgram({ status: "paused", nextCycleAt: now - 1 }), now));
  assert.ok(!isProgramDue(makeProgram({ status: "failed", nextCycleAt: now - 1 }), now));
  assert.ok(!isProgramDue(makeProgram({ status: "completed", nextCycleAt: now - 1 }), now));
  assert.ok(!isProgramDue(makeProgram({ status: "active", nextCycleAt: now + 1 }), now));
  assert.ok(
    !isProgramDue(makeProgram({ status: "active", nextCycleAt: now, archivedAt: now }), now),
  );
  assert.ok(!isProgramDue(makeProgram({ status: "active", nextCycleAt: undefined }), now));
});

test("U-07/R-10: 临时恢复退避曲线 30s/120s，超限不再自动重试", () => {
  assert.deepEqual([...CONTINUOUS_RECOVERY_BACKOFF_MS], [30_000, 120_000]);
  assert.equal(recoveryBackoffMs(0), 0);
  assert.equal(recoveryBackoffMs(1), 30_000);
  assert.equal(recoveryBackoffMs(2), 120_000);
  assert.equal(recoveryBackoffMs(3), null, "第三次失败后超限：暂停询问，不无限自动重试");
  assert.equal(recoveryBackoffMs(9), null);
});

// ── I-11：workspace lease（两 Host / 旧 owner / 过期接管 / 旧 epoch 副作用）──────────

test("I-11: 一个执行权——同 workspace 第二个 Cycle 的获取被拒绝；正常释放保留 epoch", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  // 同一 workspace 的两个 Program（一个 Program 只允许一条未结束 Cycle）。
  const programA = makeProgram();
  const programB = makeProgram();
  await repository.insertProgram(programA);
  await repository.insertProgram(programB);
  const cycleA = makeCycle(programA, "manual:req-a");
  const cycleB = makeCycle(programB, "manual:req-b");
  await repository.insertCycle(cycleA);
  await repository.insertCycle(cycleB);
  const program = programA;
  const deps = { repository, execution, clock: { now: () => 10_000 } };

  const first = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycleA.id,
    ownerId: "host-A",
  });
  assert.equal(first.status, "acquired");
  assert.equal(first.epoch, 1);

  // 未过期时第二执行者（不同 Cycle）被拒：一个 workspaceKey 最多一个主动执行者。
  const second = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycleB.id,
    ownerId: "host-B",
  });
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "held");

  // 同 Cycle 同 owner 重入 = 幂等续租，不抬 epoch（重复 Run now/恢复不重复占用）。
  const reentrant = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycleA.id,
    ownerId: "host-A",
  });
  assert.equal(reentrant.status, "renewed");
  assert.equal(reentrant.epoch, 1);

  // 正常释放：cycle/owner/expiry 同空、epoch 保留；下一次获取 epoch+1。
  await releaseCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    ownerId: "host-A",
    epoch: 1,
  });
  const released = await repository.getLease(program.workspaceKey);
  assert.ok(released);
  assert.equal(released.cycleId, undefined);
  assert.equal(released.ownerId, undefined);
  assert.equal(released.expiresAt, undefined);
  assert.equal(released.epoch, 1, "释放保留单调 epoch");
  const reacquired = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycleB.id,
    ownerId: "host-B",
  });
  assert.equal(reacquired.status, "acquired");
  assert.equal(reacquired.epoch, 2);
});

test("I-11/R-06/E-19: 过期不直接接管——旧 owner 仍活着拒绝；确认停止后 epoch+1 接管", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-a");
  await repository.insertCycle(cycle);
  let now = 10_000;
  const deps = { repository, execution, clock: { now: () => now } };

  await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-A",
  });

  // 续租校验：错误 owner/epoch 拒绝（失去续租立刻停止新操作）。
  await assert.rejects(
    renewCycleLease(deps, { workspaceKey: program.workspaceKey, ownerId: "host-A", epoch: 99 }),
    ContinuousLeaseLostError,
  );
  await assert.rejects(
    renewCycleLease(deps, { workspaceKey: program.workspaceKey, ownerId: "host-B", epoch: 1 }),
    ContinuousLeaseLostError,
  );
  await renewCycleLease(deps, { workspaceKey: program.workspaceKey, ownerId: "host-A", epoch: 1 });

  // 过期但旧 executor 仍活着（reachable + running）：不启动第二写入者。
  now += CONTINUOUS_LEASE_TERM_MS + 1_000;
  execution.state = { runId: cycle.workflowRunId, status: "running", resumable: false };
  execution.reachable = true;
  const refused = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-B",
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "old_owner_alive");
  const unchanged = await repository.getLease(program.workspaceKey);
  assert.equal(unchanged?.epoch, 1, "拒绝接管时不动 epoch/owner");
  assert.equal(unchanged?.ownerId, "host-A");

  // 旧 executor 确认停止（不可达）：撤销旧许可（stop）+ 等待静默后接管，epoch+1。
  execution.reachable = false;
  execution.state = {
    runId: cycle.workflowRunId,
    status: "stopped",
    stopReason: "interrupted",
    resumable: true,
  };
  const takeover = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-B",
  });
  assert.equal(takeover.status, "acquired");
  assert.equal(takeover.epoch, 2);
  assert.ok(execution.calls.includes("stop"), "接管前先撤销旧执行（stop）");
  assert.ok(execution.calls.includes("waitForQuiescence"), "接管前确认旧执行停止（quiescence）");

  // 旧 epoch 的副作用拒绝（lease_lost）。
  await assert.rejects(
    requireLeaseEpoch(
      { repository },
      { workspaceKey: program.workspaceKey, epoch: 1, ownerId: "host-A", purpose: "report" },
    ),
    ContinuousLeaseLostError,
  );
  // 旧执行者的晚到 usage 允许幂等收尾：结算不带 epoch 检查（E-19「usage 幂等收尾」）。
  const requestKey = `rk-${nextId("usage")}`;
  await repository.insertUsageRecord({
    id: nextId("usage"),
    cycleId: cycle.id,
    requestKey,
    state: "reserved",
    provider: "fixture",
    model: "fixture",
    pricingVersion: "test-1",
    reservedCostMicros: 1_000,
    reservedTokens: 10,
    occurredAt: now,
    updatedAt: now,
  });
  await repository.settleUsageRecord({
    requestKey,
    actualTokens: 5,
    estimatedCostMicros: 500,
    usage: { tokens: 5 },
    updatedAt: now,
  });
  const summary = await repository.summarizeUsage({ programId: program.id });
  assert.equal(summary.settledCostMicros, 500, "晚到 usage 归账（不因旧 epoch 拒绝）");
});

test("I-11/E-19: suspended Cycle 保留占用——过期也不被其它 Cycle 接管", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  // 同一 workspace 的两个 Program（一个 Program 只允许一条未结束 Cycle）。
  const program = makeProgram({ id: nextId("program") });
  const otherProgram = makeProgram({ id: nextId("program") });
  await repository.insertProgram(program);
  await repository.insertProgram(otherProgram);
  const suspendedCycle = makeCycle(program, "manual:req-a", { status: "suspended" });
  const nextCycle = makeCycle(otherProgram, "manual:req-b");
  await repository.insertCycle(suspendedCycle);
  await repository.insertCycle(nextCycle);
  let now = 10_000;
  const deps = { repository, execution, clock: { now: () => now } };

  await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: suspendedCycle.id,
    ownerId: "host-A",
  });
  // 资源暂停后不释放 workspace 执行占用：即使租期远过、旧执行者已不可达，另一轮也不能接管。
  now += CONTINUOUS_LEASE_TERM_MS * 10;
  execution.reachable = false;
  const refused = await acquireCycleLease(deps, {
    workspaceKey: program.workspaceKey,
    cycleId: nextCycle.id,
    ownerId: "host-B",
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "held", "suspended 占用者仍是未结束 Cycle，另一轮不得绕过上限");
});

// ── E-16 / E-18：重复 wake 幂等、错过多轮只唤醒一次（服务层链路）──────────

test("E-16: 重复 wake（两 scheduler 视角）只创建一个 Cycle/Run，执行身份稳定", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram({ status: "sleeping", nextCycleAt: 900 });
  await repository.insertProgram(program);
  const { recovery } = makeRecovery(repository, execution);

  await recovery.handleWake(program.id);
  const cycleAfterFirst = await repository.getOpenCycle(program.id);
  assert.ok(cycleAfterFirst, "第一次 wake 创建到期 Cycle");
  assert.equal(cycleAfterFirst.trigger.kind, "interval");
  assert.ok(cycleAfterFirst.triggerKey.startsWith("scheduled:"), "scheduled 触发使用稳定 key");
  const runId = cycleAfterFirst.workflowRunId;
  assert.equal(execution.submitted.length, 1);

  // 第二个 scheduler 的重复 wake：命中同一开放 Cycle（先核对未结束，不创建第二轮、不再提交）。
  await recovery.handleWake(program.id);
  await recovery.handleWake(program.id);
  const open = await repository.getOpenCycle(program.id);
  assert.ok(open);
  assert.equal(open.id, cycleAfterFirst.id, "重复 wake 不产生第二个 Cycle");
  assert.equal(open.workflowRunId, runId, "执行身份稳定（同 session/run）");
  assert.equal(execution.submitted.length, 1, "submitOnce 恰好一次");
});

test("E-18: 睡眠错过多周期只补一次——单 Cycle、下一计划为未来单值", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  // 到期时刻已错过 3 个 interval 窗口（nextCycleAt 远在过去）。
  const program = makeProgram({ status: "sleeping", nextCycleAt: 1_000 });
  await repository.insertProgram(program);
  const first = makeRecovery(repository, execution, { now: () => 5_000_000 });

  const report = await first.recovery.recoverWorkspace(program.workspaceKey);
  assert.deepEqual(report.startedCycleIds.length, 1, "错过多轮后唤醒也只创建一个 Cycle");
  const open = await repository.getOpenCycle(program.id);
  assert.ok(open);

  // 结算后 nextCycleAt = 下一个未来时点（不排队补三轮；单一计划值）。
  execution.finish("completed");
  const second = makeRecovery(repository, execution, { now: () => 5_000_001 });
  await second.recovery.recoverWorkspace(program.workspaceKey);
  const after = await repository.getProgram(program.id);
  assert.ok(after);
  assert.equal(after.status, "sleeping");
  assert.ok(
    after.nextCycleAt !== undefined && after.nextCycleAt > 5_000_001,
    "下一计划为未来单值（无补跑队列）",
  );
  const completed = await repository.getCycle(open.id);
  assert.ok(completed);
  assert.equal(completed.status, "completed");
});
