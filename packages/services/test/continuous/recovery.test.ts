// CT-07 崩溃与重启恢复测试（服务层）：R-01…R-06、R-08…R-10（R-07 账本 unknown 由 CT-04
// budget.test 覆盖、R-11/R-12 由 CT-04 continuation/health 覆盖）与 E-11/E-17/E-19/E-20
// 的服务层语义。用例定义见 docs/testing/continuous.md §7/§8。
//
// kill 用「同库新实例」模拟（跨进程共享 SQLite 是唯一事实通道——与 CT-03 execution.test
// 同一纪律）；执行面为可编排替身（终态/可达性/submit 失败可注入；可达性=活 Run 的注册表
// 语义）。运行入口：node scripts/test-continuous.mjs --suite recovery（tsx + node.test）。

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
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import { ContinuousSupervisorError } from "../../src/continuous/application/supervisorLifecycle.js";
import { ContinuousRecoveryService } from "../../src/continuous/application/recovery.js";
import {
  changeProgramConfig,
  interruptCyclesForShutdown,
  pauseProgram,
  stopCurrentCycle,
} from "../../src/continuous/application/supervisorControl.js";
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
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct07-recovery-"));
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
    timeZone: "Asia/Shanghai",
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push", "merge"] },
    budget: CONTINUOUS_DEFAULT_BUDGET,
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    authorization: { revision: 1, templateHash: TEMPLATE_HASH, grantedAt: "2026-10-05T00:00:00Z" },
    templateId: "ui-ux-v1",
    templateVersion: "1",
    templateHash: TEMPLATE_HASH,
    status: "active",
    nextCycleAt: 9_000_000, // 默认未到期（到期/只补一次在 scheduler.test 覆盖）
    consecutiveFailures: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

class FakeExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  allItems: ContinuousReportItem[] = [];
  calls: string[] = [];
  reachable = true;
  failNextSubmit = false;
  failNextResume = false;
  state: ExecutionState = { runId: "", status: "running", resumable: false };
  private sequence = 0;

  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
    if (this.failNextSubmit) {
      this.failNextSubmit = false;
      return Promise.reject(new Error("simulated kill before submit"));
    }
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
    if (this.failNextResume) {
      this.failNextResume = false;
      return Promise.reject(new Error("not_resumable"));
    }
    // 与真实引擎同语义：resume 成功后 Run 回到 running（监督循环据此继续）。
    this.state = { ...this.state, status: "running", stopReason: undefined, resumable: false };
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

  interrupt(): Promise<void> {
    this.calls.push("interrupt");
    return Promise.resolve();
  }

  suspendAtSafeBoundary(): Promise<void> {
    this.calls.push("suspendAtSafeBoundary");
    return Promise.resolve();
  }

  resumeSuspended(): Promise<void> {
    this.calls.push("resumeSuspended");
    return Promise.resolve();
  }

  emit(item: ContinuousReportItem): ContinuousReportItem {
    this.sequence += 1;
    const withSequence = { ...item, journalSequence: this.sequence };
    this.allItems.push(withSequence);
    return withSequence;
  }

  finish(status: ExecutionState["status"], extra: Partial<ExecutionState> = {}): void {
    this.state = { ...this.state, status, ...extra };
  }
}

let prepareCalls = 0;
const fakeWorkspace: WorkspacePreparationPort = {
  prepare: async (request) => {
    prepareCalls += 1;
    return {
      executionPath: join(tmpRoot, "worktrees", request.programId),
      branchName: request.branchName,
      baseCommit: "f".repeat(40),
    };
  },
  release: async () => {},
  createCandidateCheckpoint: async () => {
    throw new Error("recovery.test 不驱动候选检查点");
  },
  restoreCandidateFiles: async () => [],
};

const templateSource: ContinuousTemplateSource = {
  resolve: () => ({ scriptText: TEMPLATE_TEXT, scriptHash: TEMPLATE_HASH }),
};

type SupervisorDeps = ConstructorParameters<typeof ContinuousSupervisor>[0];

function makeStack(
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
  options: { ownerId?: string; clock?: SupervisorDeps["clock"] } = {},
): { supervisor: ContinuousSupervisor; recovery: ContinuousRecoveryService } {
  const clock = options.clock ?? {
    now: () => 10_000,
    timeZone: () => "Asia/Shanghai",
    schedule: (callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, Math.min(delayMs, 1));
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
    // CT-10：恢复测试固定 autonomous 平台（observe_only 平台门在 platform suite 验证）。
    platformExecutionMode: "autonomous",
    pollIntervalMs: 1,
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
  };
  const supervisor = new ContinuousSupervisor(deps);
  const recovery = new ContinuousRecoveryService({
    repository,
    execution,
    supervisor,
    clock,
    workspace: fakeWorkspace,
  });
  return { supervisor, recovery };
}

function controlDeps(
  supervisor: ContinuousSupervisor,
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
): Parameters<typeof stopCurrentCycle>[0] {
  return {
    repository,
    execution,
    clock: { now: () => 10_000, timeZone: () => "Asia/Shanghai" },
    attachSupervision: (cycle: Cycle, program: Program) =>
      supervisor.attachSupervision(cycle, program),
  };
}

function makeCycle(program: Program, triggerKey: string, overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: nextId("cycle"),
    programId: program.id,
    sequence: 1,
    triggerKey,
    trigger: { kind: "manual" },
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

function candidateItem(fingerprint: string): ContinuousReportItem {
  return {
    kind: "candidate",
    itemKey: `cand-${fingerprint}`,
    journalSequence: 0,
    payload: {
      kind: "candidate",
      itemKey: `cand-${fingerprint}`,
      fingerprint,
      title: "Header spacing",
      rationale: "fixture",
      targetPaths: ["src/ui/Header.tsx"],
      impact: 5,
      confidence: 0.9,
      effort: 2,
      risk: "low",
      evidence: [],
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  attempts = 400,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error(`waitUntil 超时: ${label}`);
}

// ── R-01/R-02：提交前 kill 与 ACK 丢失——查原身份，不新生成 ───────────

test("R-01: Cycle 保存后提交前 kill——同 cycle/session/run 身份继续提交，无第二 Cycle", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);

  // kill 模拟：Cycle 行已落库（preparing），submitOnce 未被接受。
  execution.failNextSubmit = true;
  await assert.rejects(supervisor.runNow({ programId: program.id, requestId: "req-1" }));
  const persisted = await repository.getOpenCycle(program.id);
  assert.ok(persisted, "Cycle 已持久化（提交前）");
  assert.equal(persisted.status, "preparing");
  const identity = {
    executionSessionId: persisted.executionSessionId,
    workflowRunId: persisted.workflowRunId,
    traceId: persisted.traceId,
  };

  // 新进程（新实例）恢复：Run 不存在（pending）→ 按原身份 submitOnce（查原身份，不新生成）。
  execution.state = { runId: "", status: "pending", resumable: false };
  const { recovery } = makeStack(repository, execution, { ownerId: "host-new" });
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "resubmitted");
  assert.equal(execution.submitted.length, 1, "恢复提交恰好一次");
  assert.equal(execution.submitted[0]!.executionSessionId, identity.executionSessionId);
  assert.equal(execution.submitted[0]!.workflowRunId, identity.workflowRunId);
  assert.equal(execution.submitted[0]!.traceId, identity.traceId);
  const after = await repository.getOpenCycle(program.id);
  assert.ok(after);
  assert.equal(after.id, persisted.id, "无第二 Cycle（同一行继续）");
  assert.equal(after.status, "running");
});

test("R-02/E-16: ACK 丢失重发——查原身份，只有一个 Run 工作集合", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);

  const first = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  execution.finish("completed");
  await first.completion;
  // 同一请求 ID 重发（ACK 丢失/双击）：命中同一 Cycle/Run 身份，绝不生成新随机 ID。
  const replay = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  assert.equal(replay.cycle.id, first.cycle.id);
  assert.equal(replay.cycle.workflowRunId, first.cycle.workflowRunId);
  for (const submitted of execution.submitted) {
    assert.equal(submitted.workflowRunId, first.cycle.workflowRunId);
  }
  const programs = await repository.listPrograms(program.workspaceKey);
  assert.equal(programs.length, 1);
});

// ── R-03/R-04/R-05：写入后 kill、导入前 kill、completed 未结算 ───────────

test("R-03: 中断恢复重新核对 workspace（prepare 重解析 HEAD，不盲目重放）", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);
  const before = prepareCalls;

  const run = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const cycle = await repository.getCycle(run.cycle.id);
  assert.ok(cycle);
  // kill 模拟：actor 已有写入（journal 已有报告），节点完成记录前中断。
  execution.emit(candidateItem("fp-r03-recovery-0001"));
  await interruptCyclesForShutdown(
    controlDeps(supervisor, repository, execution),
    program.workspaceKey,
  );
  const interrupted = await repository.getCycle(cycle.id);
  assert.equal(interrupted?.status, "interrupted");

  // 新进程视角：旧执行不可达；stopped(interrupted) 可恢复 → 同 Run resume + 重新 prepare。
  execution.reachable = false;
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });
  const { recovery } = makeStack(repository, execution, { ownerId: "host-new" });
  await recovery.recoverWorkspace(program.workspaceKey);
  assert.ok(execution.calls.includes("resume"), "同 Run 有限条件恢复");
  assert.ok(prepareCalls > before + 1, "恢复路径重新 prepare workspace（外部改动重核对）");
});

test("R-04: report 已写、导入前 kill——cursor 重读不双计不丢失", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  // 直接构造 running Cycle（模拟监督从未运行就被 kill），journal 已有报告。
  const cycle = makeCycle(program, "manual:req-1");
  await repository.insertCycle(cycle);
  await repository.acquireLease({
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-old",
    epoch: 1,
    expiresAt: 9_000,
    updatedAt: 1_000,
  });
  execution.emit(candidateItem("fp-r04-recovery-0002"));
  execution.finish("completed");

  const { recovery } = makeStack(repository, execution);
  await recovery.recoverWorkspace(program.workspaceKey);
  const settled = await repository.getCycle(cycle.id);
  assert.equal(settled?.status, "completed");
  const candidates = await repository.listQueueableCandidates(program.id);
  assert.equal(candidates.length, 1, "报告导入恰好一次（候选不双计）");

  // 再次恢复（同库重开）：终态 Cycle 不再处理，事实保持。
  const again = makeStack(repository, execution).recovery;
  await again.recoverWorkspace(program.workspaceKey);
  assert.equal(
    (await repository.listQueueableCandidates(program.id)).length,
    1,
    "重开不重复导入（cursor 重读幂等）",
  );
});

test("R-05: Run completed 后 Cycle terminal 前 kill——继续 settling，不 resume 不新 Run", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "settling" });
  await repository.insertCycle(cycle);
  await repository.acquireLease({
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-old",
    epoch: 1,
    expiresAt: 9_000,
    updatedAt: 1_000,
  });
  execution.finish("completed");

  const { recovery } = makeStack(repository, execution);
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "settled");
  assert.ok(!execution.calls.includes("resume"), "completed 不 resume");
  assert.ok(!execution.calls.includes("resumeSuspended"));
  assert.equal(execution.submitted.length, 0, "不创建替代 Run");
  const settled = await repository.getCycle(cycle.id);
  assert.equal(settled?.status, "completed");
  const after = await repository.getProgram(program.id);
  assert.equal(after?.status, "sleeping");
  assert.ok(after?.nextCycleAt !== undefined, "nextCycleAt 与终态一起保存");
  const lease = await repository.getLease(program.workspaceKey);
  assert.equal(lease?.cycleId, undefined, "终态后释放占用（epoch 保留）");
});

// ── R-06/E-19：旧 lease 过期但旧 executor 仍活着 ───────────

test("R-06/E-19: 旧 owner 仍活着不启动第二写入者；确认停止后同 Run 接管恢复", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1");
  await repository.insertCycle(cycle);
  await repository.acquireLease({
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-old",
    epoch: 5,
    expiresAt: 9_000, // 已过期（clock.now=10_000）
    updatedAt: 1_000,
  });
  execution.state = { runId: cycle.workflowRunId, status: "running", resumable: false };
  execution.reachable = true;

  const first = makeStack(repository, execution, { ownerId: "host-new" }).recovery;
  const report = await first.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "kept_interrupted");
  assert.equal(execution.submitted.length, 0, "不创建替代 Run");
  const heldLease = await repository.getLease(program.workspaceKey);
  assert.equal(heldLease?.ownerId, "host-old", "未确认停止前不动旧占用");
  assert.equal(heldLease?.epoch, 5);

  // 旧执行者停止（不可达 + stopped(interrupted) 可恢复）：接管 epoch+1 后同 Run resume。
  execution.reachable = false;
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });
  const secondStack = makeStack(repository, execution, { ownerId: "host-new" });
  const secondReport = await secondStack.recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(secondReport.reconciled[0]?.action, "resumed");
  assert.ok(execution.calls.includes("stop"), "接管前撤销旧许可");
  assert.ok(execution.calls.includes("waitForQuiescence"), "接管前确认停止");
  assert.ok(execution.calls.includes("resume"), "同 Run 恢复");
  const takenLease = await repository.getLease(program.workspaceKey);
  assert.equal(takenLease?.ownerId, "host-new");
  assert.equal(takenLease?.epoch, 6, "epoch 单调接管");
  const resumed = await repository.getCycle(cycle.id);
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.resumeAttempts, 1);
  assert.equal(resumed?.leaseEpoch, 6);
});

// ── R-08：结算中断重放（事件幂等 + 终态/nextCycleAt 原子）───────────

test("R-08: settling 中断重放——审计事件幂等，失败结算完整落库", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "settling" });
  await repository.insertCycle(cycle);
  execution.finish("errored", { failureCode: "fixture_error" });

  const { recovery } = makeStack(repository, execution);
  await recovery.recoverWorkspace(program.workspaceKey);
  const failedCycle = await repository.getCycle(cycle.id);
  assert.equal(failedCycle?.status, "failed");
  const after = await repository.getProgram(program.id);
  assert.equal(after?.consecutiveFailures, 1);
  assert.ok(after?.nextCycleAt !== undefined, "失败也按 cadence 计划下一次（有限重试）");

  // 审计事件幂等：同 key 重放不新增行（模拟结算在事件落库后被 kill 再重放）。
  await repository.appendEvent({
    programId: program.id,
    cycleId: cycle.id,
    eventKey: `cycle-selection:${cycle.id}`,
    type: "cycle.selection",
    payload: {},
    createdAt: 10_000,
  });
  const events = await repository.listCycleEvents(program.id, cycle.id, "cycle.selection");
  assert.equal(events.length, 1, "事件按 event_key 幂等（重放不双计）");
});

// ── R-09/E-17：正常退出、重开先旧轮、只补一次 ───────────

test("R-09/E-17: 正常退出保存 interrupted；重开先恢复旧轮，不排队补跑", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  // 到期时刻在「停机期间」已过（睡眠跨多周期）——重开时同时存在旧轮与到期。
  const program = makeProgram({ nextCycleAt: 5_000 });
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);

  const run = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const supervised = await repository.getCycle(run.cycle.id);
  assert.ok(supervised);
  await repository.saveCycle({ ...supervised, activeDurationMs: 1_234_567 });

  // 正常退出：撤销许可（安全边界挂起）+ 保存 interrupted；lease 保留（持久化占用）。
  const interruptedIds = await interruptCyclesForShutdown(
    controlDeps(supervisor, repository, execution),
    program.workspaceKey,
  );
  assert.deepEqual(interruptedIds, [supervised.id]);
  assert.ok(execution.calls.includes("interrupt"));
  const exited = await repository.getCycle(supervised.id);
  assert.equal(exited?.status, "interrupted");
  assert.equal(exited?.activeDurationMs, 1_234_567, "离线前的有效时长保留（不重置限额）");
  const leaseAfterExit = await repository.getLease(program.workspaceKey);
  assert.equal(leaseAfterExit?.cycleId, supervised.id, "退出保留持久化占用");

  // 重开（新进程视角：旧执行不可达）——先核对未结束 Cycle：同 Run resume；
  // 不为到期 Program 排队补跑新轮（先旧后到期）。
  execution.reachable = false;
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });
  const { recovery } = makeStack(repository, execution, { ownerId: "host-restart" });
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "resumed");
  assert.deepEqual(report.startedCycleIds, [], "旧轮未结束时不启动到期轮");
  assert.equal(execution.submitted.length, 1, "无第二个 Run");
  const resumed = await repository.getCycle(supervised.id);
  assert.equal(resumed?.status, "running");
});

// ── R-10/E-11：恢复超限询问、用户取消不恢复、不可恢复保存证据 ───────────

test("R-10: resume 次数超限——暂停询问，不自动结束任务", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  // 单轮 resume 默认上限 2：已用尽。
  const cycle = makeCycle(program, "manual:req-1", {
    status: "interrupted",
    resumeAttempts: 2,
  });
  await repository.insertCycle(cycle);
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });

  const { recovery } = makeStack(repository, execution);
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "suspend_ask");
  assert.ok(!execution.calls.includes("resume"), "超限不自动 resume");
  const after = await repository.getCycle(cycle.id);
  assert.equal(after?.status, "suspended");
  const pausedProgram = await repository.getProgram(program.id);
  assert.equal(pausedProgram?.status, "paused");
  const pending = await repository.getPendingContinuationRequest(cycle.id);
  assert.ok(pending, "存在 pending 继续确认（resume_limit）");
  assert.equal(pending?.reason, "resume_limit");
});

test("R-10/E-11: 用户取消的 Run 不自动恢复——崩溃窗口补落 cancelled", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram({ consecutiveFailures: 1 });
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "interrupted" });
  await repository.insertCycle(cycle);
  execution.finish("stopped", { stopReason: "user", resumable: true });

  const { recovery } = makeStack(repository, execution);
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "cancelled_finalized");
  assert.ok(!execution.calls.includes("resume"), "用户取消不自动恢复");
  const after = await repository.getCycle(cycle.id);
  assert.equal(after?.status, "cancelled");
  const programAfter = await repository.getProgram(program.id);
  assert.equal(programAfter?.status, "paused");
  assert.equal(programAfter?.consecutiveFailures, 1, "用户停止不是任务失败（计数不动）");
});

test("R-10: 不可恢复（resume 被拒）——保存失败与证据，不冒充可恢复", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "interrupted" });
  await repository.insertCycle(cycle);
  await repository.acquireLease({
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "host-old",
    epoch: 1,
    expiresAt: 9_000,
    updatedAt: 1_000,
  });
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });
  execution.failNextResume = true;

  const { recovery } = makeStack(repository, execution);
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "failed");
  const failed = await repository.getCycle(cycle.id);
  assert.equal(failed?.status, "failed");
  const events = await repository.listCycleEvents(program.id, cycle.id, "cycle.recovery_failed");
  assert.equal(events.length, 1, "保存失败证据事件");
  const after = await repository.getProgram(program.id);
  assert.equal(after?.consecutiveFailures, 1);
  assert.equal(after?.status, "sleeping", "未达连续 3 次失败按 cadence 计划下一次");
  const lease = await repository.getLease(program.workspaceKey);
  assert.equal(lease?.cycleId, undefined, "不可恢复终态后释放占用");
});

// ── E-11：Pause 与立即停止（服务层语义）───────────

test("E-11: Pause 本轮可结束且结束后保持 paused；立即停止撤销→取消→等待→释放", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);
  const clockStub = { now: () => 10_000, timeZone: () => "Asia/Shanghai" };

  // Pause：不取消正在执行的候选（Run 照常完成），结束后 Program 保持 paused。
  const first = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const paused = await pauseProgram({ repository, clock: clockStub }, { programId: program.id });
  assert.equal(paused.status, "paused");
  execution.finish("completed");
  const outcome = await first.completion;
  assert.equal(outcome.cycleStatus, "completed", "Pause 不误取消已在执行项");
  const afterFirst = await repository.getProgram(program.id);
  assert.equal(afterFirst?.status, "paused", "本轮结束后保持 paused（不翻 sleeping）");
  assert.ok(afterFirst?.nextCycleAt !== undefined);

  // 显式恢复后开第二轮，立即停止：撤销写入→cancel→等待停止；cancelled、paused、lease 释放。
  await repository.saveProgram({
    ...(await repository.getProgram(program.id))!,
    status: "active",
    statusReason: undefined,
    updatedAt: 10_000,
  });
  execution.finish("running"); // 第二轮正在执行（立即停止的语义针对进行中的轮次）
  const second = await supervisor.runNow({ programId: program.id, requestId: "req-2" });
  const cancelled = await stopCurrentCycle(controlDeps(supervisor, repository, execution), {
    programId: program.id,
    epoch: second.cycle.leaseEpoch,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(execution.calls.includes("stop"), "先撤销/取消");
  assert.ok(execution.calls.includes("waitForQuiescence"), "再等待停止（不只等 run-settled）");
  const afterStop = await repository.getProgram(program.id);
  assert.equal(afterStop?.status, "paused");
  const lease = await repository.getLease(program.workspaceKey);
  assert.equal(lease?.cycleId, undefined, "停止后释放占用（epoch 保留）");

  // 旧 Run 不能自动恢复：cancelled 是终态，恢复不再触碰；stopped(user) 分支亦不 resume。
  execution.finish("stopped", { stopReason: "user", resumable: true });
  const recovery = makeStack(repository, execution).recovery;
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.deepEqual(report.reconciled, [], "终态 Cycle 不进入恢复");
  assert.ok(!execution.calls.includes("resume"));
});

test("E-11: 旧 epoch 的停止请求被拒绝（lease_lost），不误停他人执行", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);
  const run = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  await assert.rejects(
    stopCurrentCycle(controlDeps(supervisor, repository, execution), {
      programId: program.id,
      epoch: run.cycle.leaseEpoch + 5,
    }),
    (error: unknown) =>
      (error instanceof ContinuousSupervisorError || error instanceof Error) &&
      (error as { code?: string }).code === "lease_lost",
  );
  const stillOpen = await repository.getOpenCycle(program.id);
  assert.equal(stillOpen?.status, "running", "epoch 不匹配的停止不生效");
});

// ── E-19/R-11：suspended 与 pending 继续确认跨重启保持 ───────────

test("E-19/R-11: suspended 保留占用与 pending 确认——跨重启不自动恢复、不新开另一轮", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const programA = makeProgram();
  const programB = makeProgram({ nextCycleAt: 5_000 });
  await repository.insertProgram(programA);
  await repository.insertProgram(programB);
  const { supervisor } = makeStack(repository, execution);

  // programA 因资源上限挂起（suspended + pending 继续确认），占用不释放。
  const run = await supervisor.runNow({ programId: programA.id, requestId: "req-1" });
  const continuationId = nextId("cont");
  await repository.insertContinuationRequest({
    id: continuationId,
    programId: programA.id,
    cycleId: run.cycle.id,
    reason: "cost_limit",
    limitKind: "cost",
    reasons: ["cost_limit"],
    observedUsage: {},
    currentLimit: {},
    recommendedExtension: {},
    version: 1,
    status: "pending",
    createdAt: 10_000,
  });
  await repository.saveCycle({
    ...(await repository.getCycle(run.cycle.id))!,
    status: "suspended",
    pendingContinuationRequestId: continuationId,
    updatedAt: 10_000,
  });

  // 重启：suspended 保持（pending 确认保留）；同 workspace 的到期 programB 不得新开。
  const { recovery } = makeStack(repository, execution, { ownerId: "host-new" });
  const report = await recovery.recoverWorkspace(programA.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "kept_suspended");
  assert.ok(!execution.calls.includes("resumeSuspended"), "用户同意前不恢复");
  assert.ok(!execution.calls.includes("resume"));
  assert.deepEqual(report.startedCycleIds, [], "suspended 占用阻止另一轮绕过上限");
  const pending = await repository.getPendingContinuationRequest(run.cycle.id);
  assert.ok(pending, "pending 继续确认跨重启保留");
  const lease = await repository.getLease(programA.workspaceKey);
  assert.equal(lease?.cycleId, run.cycle.id, "suspended 保留执行占用");
});

// ── E-20：配置变更的授权处理（服务层核心）───────────

test("E-20: Goal 变更 revision+1、结算当前轮并 paused；cadence 只影响未来轮", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const { supervisor } = makeStack(repository, execution);
  const run = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  assert.ok(run.cycle.leaseEpoch >= 1);

  // Goal（需重新授权类）变更：当前轮停止结算 cancelled，Program paused，revision+1。
  const changed = await changeProgramConfig(controlDeps(supervisor, repository, execution), {
    programId: program.id,
    patch: { goal: "新的目标" },
  });
  assert.equal(changed.revision, program.revision + 1);
  assert.equal(changed.authorization.revision, program.authorization.revision + 1);
  assert.equal(changed.status, "paused");
  const stoppedCycle = await repository.getCycle(run.cycle.id);
  assert.equal(stoppedCycle?.status, "cancelled", "旧写入许可撤销：当前轮停止并结算");
  const lease = await repository.getLease(program.workspaceKey);
  assert.equal(lease?.cycleId, undefined, "结算后释放占用");

  // cadence 修改（不需重新授权）：revision 不变；无未结束 Cycle 时才重排未来计划。
  const cadenceChanged = await changeProgramConfig(controlDeps(supervisor, repository, execution), {
    programId: program.id,
    patch: { cadence: { kind: "interval", hoursAfterCycleEnd: 1 } },
  });
  assert.equal(cadenceChanged.revision, changed.revision, "cadence 不递增授权 revision");
  assert.ok(cadenceChanged.nextCycleAt !== undefined);
});

// ── 退避：临时失败 30s/120s 重试、超限暂停询问 ───────────

test("R-10/退避: 执行面暂不可用——30s/120s 自动重试后恢复成功", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "interrupted" });
  await repository.insertCycle(cycle);

  const delays: number[] = [];
  const clock = {
    now: () => 10_000,
    timeZone: () => "Asia/Shanghai",
    schedule: (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      // 测试不等待真实 30s/120s：定时器立即触发（监督循环的 1ms 轮询也经此，unref 不阻塞退出）。
      const timer = setTimeout(callback, 0);
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const supervisor = new ContinuousSupervisor({
    repository,
    execution,
    workspace: fakeWorkspace,
    clock,
    templateSource,
    // CT-10：恢复测试固定 autonomous 平台（observe_only 平台门在 platform suite 验证）。
    platformExecutionMode: "autonomous",
    pollIntervalMs: 1,
  });
  const recovery = new ContinuousRecoveryService({
    repository,
    execution,
    supervisor,
    clock,
    workspace: fakeWorkspace,
  });

  let failuresLeft = 2;
  const originalInspect = execution.inspect.bind(execution);
  execution.inspect = () => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return Promise.reject(new Error("transient (fixture)"));
    }
    return originalInspect();
  };
  execution.finish("stopped", { stopReason: "interrupted", resumable: true });

  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "backoff_scheduled");
  await waitUntil(
    async () => (await repository.getCycle(cycle.id))?.status === "running",
    "重试后恢复",
  );
  assert.deepEqual(
    delays.filter((delay) => delay >= 30_000),
    [30_000, 120_000],
    "退避曲线 30s/120s（监督轮询的 1ms 项不计）",
  );
  const recovered = await repository.getCycle(cycle.id);
  assert.equal(recovered?.status, "running");
});

test("R-10/退避: 连续临时失败超限——暂停询问，不无限自动重试", async () => {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  const program = makeProgram();
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1", { status: "interrupted" });
  await repository.insertCycle(cycle);

  const delays: number[] = [];
  const clock = {
    now: () => 10_000,
    timeZone: () => "Asia/Shanghai",
    schedule: (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      const timer = setTimeout(callback, 0);
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const supervisor = new ContinuousSupervisor({
    repository,
    execution,
    workspace: fakeWorkspace,
    clock,
    templateSource,
    // CT-10：恢复测试固定 autonomous 平台（observe_only 平台门在 platform suite 验证）。
    platformExecutionMode: "autonomous",
    pollIntervalMs: 1,
  });
  const recovery = new ContinuousRecoveryService({
    repository,
    execution,
    supervisor,
    clock,
    workspace: fakeWorkspace,
  });

  // 执行面持续不可用：3 次失败（30s、120s、超限）。
  execution.inspect = () => Promise.reject(new Error("ledger unreachable (fixture)"));
  const report = await recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.reconciled[0]?.action, "backoff_scheduled");
  await waitUntil(async () => {
    const current = await repository.getCycle(cycle.id);
    return current?.status === "suspended";
  }, "超限后 suspended");
  const suspended = await repository.getCycle(cycle.id);
  assert.equal(suspended?.status, "suspended");
  const pending = await repository.getPendingContinuationRequest(cycle.id);
  assert.ok(pending, "超限转为暂停询问（resume_limit 继续确认）");
  assert.equal(pending?.reason, "resume_limit");
  const pausedProgram = await repository.getProgram(program.id);
  assert.equal(pausedProgram?.status, "paused");
  assert.deepEqual(delays, [30_000, 120_000], "只安排两次自动重试");
});
