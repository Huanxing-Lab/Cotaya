// CT-08 命令门面测试（服务层）：ContinuousCommandService 把 IContinuousService 命令面接到
// CT-01…07 服务栈——归属校验、错误映射（结构化 ContinuousError）、snapshot/programDetail
// 读面与继续确认回答链。用例对应 docs/testing/continuous.md 的 E-24（不支持/归属拒绝）、
// E-06/E-32（version 回答）、E-11（Pause 与立即停止分开）的服务面。
//
// 真实 SQLite + 执行端口替身（同 cycle.test.ts 惯例；深链路语义在 cycle/decision/recovery
// 套件覆盖，这里锁定「命令面 → 服务栈」的映射本身）。
// 运行入口：node scripts/test-continuous.mjs --suite integration。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
  type ContinuousCommandContext,
} from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import { ContinuousCommandService } from "../../src/continuous/application/continuousCommandService.js";
import { ContinuousCommandError } from "../../src/continuous/application/continuousCommandErrors.js";
import { ContinuousContinuationService } from "../../src/continuous/application/continuationService.js";
import type { Decision, Program } from "../../src/continuous/domain/types.js";
import type {
  ContinuousExecutionPort,
  ContinuousReportItem,
  ExecutionReference,
  ExecutionState,
  ManagedCycleInput,
  WorkspacePreparationPort,
} from "../../src/continuous/application/ports.js";

// ── fixture ──────────────────────────────────────────────────

const TEMPLATE_TEXT = "phase('观察');\nconst a = agent('observer');\nreturn {};\n";
const TEMPLATE_HASH = createHash("sha256").update(TEMPLATE_TEXT, "utf8").digest("hex");
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct08-"));
let dbCounter = 0;

async function freshRepository(): Promise<SqliteContinuousRepository> {
  dbCounter += 1;
  const path = join(tmpRoot, `tasks-index-${dbCounter}.sqlite`);
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

function contextOf(
  program: Pick<Program, "workspacePath" | "workspaceKey">,
): ContinuousCommandContext {
  return {
    workspacePath: program.workspacePath,
    workspaceKey: program.workspaceKey,
    traceId: `trace-${dbCounter}`,
  };
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: `program-${dbCounter}`,
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
    consecutiveFailures: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

class FakeExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  calls: string[] = [];
  state: ExecutionState = { runId: "", status: "running", resumable: false };

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

  resume(): Promise<void> {
    this.calls.push("resume");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push("stop");
    this.state = { ...this.state, status: "stopped", resumable: false };
    return Promise.resolve();
  }

  waitForQuiescence(): Promise<void> {
    this.calls.push("waitForQuiescence");
    return Promise.resolve();
  }

  readReports(
    _ref: ExecutionReference,
    afterSequence: number,
  ): Promise<{ items: ContinuousReportItem[]; nextCursor: number }> {
    void _ref;
    return Promise.resolve({ items: [], nextCursor: afterSequence });
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

  inspectHealth() {
    this.calls.push("inspectHealth");
    return Promise.resolve({
      runId: this.state.runId,
      actorIds: [],
      ownerEpoch: 1,
      reachable: true,
    });
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
    throw new Error("commands.test 不驱动候选检查点");
  },
  restoreCandidateFiles: async () => [],
};

const templateSource: ContinuousTemplateSource = {
  resolve: () => ({ scriptText: TEMPLATE_TEXT, scriptHash: TEMPLATE_HASH }),
  list: () => [{ templateId: "ui-ux-v1", templateVersion: "1", templateHash: TEMPLATE_HASH }],
};

interface Fixture {
  repository: SqliteContinuousRepository;
  execution: FakeExecutionPort;
  supervisor: ContinuousSupervisor;
  commands: ContinuousCommandService;
  continuations: ContinuousContinuationService;
}

async function freshFixture(): Promise<Fixture> {
  const repository = await freshRepository();
  const execution = new FakeExecutionPort();
  let now = 10_000;
  const clock = {
    now: () => (now += 1),
    timeZone: () => "Asia/Shanghai",
    schedule: (callback: () => void, delayMs: number) => {
      // unref：监督轮询的定时器不能阻止测试进程退出（同 supervisorWatch 默认实现的论证）。
      const timer = setTimeout(callback, Math.min(delayMs, 1));
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
    // CT-10：命令面测试固定 autonomous 平台（平台门拒绝语义在 platform suite 验证）。
    platformExecutionMode: "autonomous",
    pollIntervalMs: 1,
  });
  const commands = new ContinuousCommandService({
    repository,
    supervisor,
    templateSource,
    clock,
  });
  const continuations = new ContinuousContinuationService({ repository, clock });
  return { repository, execution, supervisor, commands, continuations };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ContinuousCommandError
    ? error.error.code
    : ((error as { code?: string } | null)?.code ?? undefined);
}

function makeDecision(programId: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id: `decision-${dbCounter}`,
    programId,
    sourceCycleId: "cycle-x",
    fingerprint: `fp-${programId}`,
    version: 1,
    title: "Settings navigation 重构",
    context: "涉及信息结构",
    options: [
      { id: "keep", label: "保持", consequences: "无变化" },
      { id: "split", label: "拆分", consequences: "导航层级变化" },
    ],
    recommendation: "keep",
    classification: "blocking",
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ── 用例 ─────────────────────────────────────────────────────

test("capability/snapshot/templates：装配即支持；snapshot 列出 workspace 的 Program 与计数", async (t) => {
  const { repository, commands } = await freshFixture();
  t.after(() => void repository.close());
  assert.equal((await commands.capability()).supported, true);
  assert.deepEqual(
    (await commands.listTemplates({ context: contextOf(makeProgram()) })).templates,
    [{ templateId: "ui-ux-v1", templateVersion: "1", templateHash: TEMPLATE_HASH }],
  );

  const program = makeProgram();
  await repository.insertProgram(program);
  const snapshot = await commands.snapshot({ context: contextOf(program) });
  assert.equal(snapshot.programs.length, 1);
  assert.equal(snapshot.programs[0]!.programId, program.id);
  assert.equal(snapshot.programs[0]!.pendingDecisionCount, 0);
  assert.equal(snapshot.programs[0]!.currentCycleId, null);
  // 跨 workspace 快照隔离：另一个 workspaceKey 看不到。
  const other = await commands.snapshot({
    context: contextOf(
      makeProgram({ workspaceKey: "/repos/other", workspacePath: "/repos/other" }),
    ),
  });
  assert.equal(other.programs.length, 0);
});

test("createProgram：默认预算随授权落库；远程 context 与模板不符结构化拒绝（E-24）", async (t) => {
  const { repository, commands } = await freshFixture();
  t.after(() => void repository.close());
  const context = contextOf(makeProgram());
  const created = await commands.createProgram({
    context,
    goal: "改进移动端布局",
    scope: { allowedPaths: ["packages/ui/src"], forbiddenPaths: [], forbiddenCapabilities: [] },
    budget: CONTINUOUS_DEFAULT_BUDGET,
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    template: { templateId: "ui-ux-v1", templateVersion: "1", templateHash: TEMPLATE_HASH },
  });
  assert.equal(created.budget.maxConcurrentActors, 10);
  assert.equal(created.budget.perCycleTokens, 1_000_000_000);
  assert.equal(created.budget.perCycleCostUsdMicros, 100_000_000);
  assert.equal(created.budget.dailyCostUsdMicros, 1_000_000_000);
  assert.equal(created.budget.activeExecutionLimitMs, 3_600_000);
  assert.equal(created.status, "active");
  // 初次执行：创建并授权后到期立即执行一次（§2）。
  assert.equal(typeof created.nextCycleAt, "number");

  await assert.rejects(
    commands.createProgram({
      context: { ...context, remoteSessionId: "remote-1" },
      goal: "远程",
      scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
      budget: CONTINUOUS_DEFAULT_BUDGET,
      cadence: CONTINUOUS_DEFAULT_CADENCE,
      decisionPolicy: { unknownToDecision: true },
      template: { templateId: "ui-ux-v1", templateVersion: "1", templateHash: TEMPLATE_HASH },
    }),
    (error: unknown) => errorCode(error) === "remote_execution_not_supported",
  );
  await assert.rejects(
    commands.createProgram({
      context,
      goal: "模板漂移",
      scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
      budget: CONTINUOUS_DEFAULT_BUDGET,
      cadence: CONTINUOUS_DEFAULT_CADENCE,
      decisionPolicy: { unknownToDecision: true },
      template: { templateId: "ui-ux-v1", templateVersion: "1", templateHash: "0".repeat(64) },
    }),
    (error: unknown) => errorCode(error) === "template_mismatch",
  );
});

test("runNow：requestId 幂等（一个 Cycle/Run）；归属不符拒绝", async (t) => {
  const { repository, commands, execution } = await freshFixture();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const context = contextOf(program);

  const cycle = await commands.runNow({ context, programId: program.id, requestId: "req-1" });
  const replay = await commands.runNow({ context, programId: program.id, requestId: "req-1" });
  assert.equal(replay.id, cycle.id);
  // 重放会再过一次 submitOnce（幂等由 CT-03 run service 持有），但身份四元组不变、只有一个 Cycle。
  assert.equal(new Set(execution.submitted.map((input) => input.workflowRunId)).size, 1);
  assert.equal(new Set(execution.submitted.map((input) => input.cycleId)).size, 1);
  const snapshot = await commands.snapshot({ context });
  assert.equal(snapshot.programs[0]!.currentCycleId, cycle.id);

  // 不存在的 program / 跨 workspace 命令均结构化拒绝（capability_missing 处置）。
  await assert.rejects(
    commands.runNow({ context, programId: "program-missing", requestId: "req-2" }),
    (error: unknown) => errorCode(error) === "capability_missing",
  );
  const foreign = makeProgram({
    id: "program-foreign",
    workspaceKey: "/repos/other",
    workspacePath: "/repos/other",
  });
  await repository.insertProgram(foreign);
  await assert.rejects(
    commands.runNow({ context, programId: foreign.id, requestId: "req-3" }),
    (error: unknown) => errorCode(error) === "capability_missing",
  );

  // 收尾：让本轮到终态，监督循环自然退出（不留悬挂轮询）。
  execution.finish("completed");
  await waitFor(async () => (await repository.getCycle(cycle.id))!.status === "completed");
});

test("programDetail：§12 读面字段齐全（当前轮/账本/占用/队列），费用为整数微美元口径", async (t) => {
  const { repository, commands, execution } = await freshFixture();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const context = contextOf(program);
  const cycle = await commands.runNow({ context, programId: program.id, requestId: "req-d" });

  const detail = await commands.programDetail({ context, programId: program.id });
  assert.equal(detail.program.programId, program.id);
  assert.equal(detail.program.branchName, `codex/continuous-${program.id}`);
  assert.ok(detail.program.executionPath?.includes("worktrees"));
  assert.equal(detail.currentCycle?.cycleId, cycle.id);
  assert.equal(detail.currentCycle?.triggerKind, "manual");
  assert.deepEqual(detail.dailyUsage, {
    settledCostMicros: 0,
    unsettledCostMicros: 0,
    settledTokens: 0,
    unsettledTokens: 0,
  });
  assert.ok(detail.lease && detail.lease.epoch >= 1);
  assert.equal(detail.platformConcurrency, program.budget.maxConcurrentActors);
  assert.deepEqual(detail.candidates, []);
  assert.deepEqual(detail.decisions, []);

  // 终态后 detail 的 recentCycles 携带本轮（Latest Cycles）。
  execution.finish("completed");
  await waitFor(async () => {
    const row = await repository.getCycle(cycle.id);
    return row !== null && row.status === "completed";
  });
  const settled = await commands.programDetail({ context, programId: program.id });
  assert.equal(settled.currentCycle, null);
  assert.equal(settled.recentCycles[0]!.cycleId, cycle.id);
  assert.equal(settled.recentCycles[0]!.outcome, "no_changes");
});

test("Pause 与立即停止分开：pause 不碰执行；stop 撤销→取消→等待停止且要求 epoch（E-11）", async (t) => {
  const { repository, commands, execution } = await freshFixture();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const context = contextOf(program);
  const cycle = await commands.runNow({ context, programId: program.id, requestId: "req-p" });

  // Pause：本轮结束后暂停——不取消正在执行的候选（stop 未被调用）。
  const paused = await commands.pauseProgram({ context, programId: program.id });
  assert.equal(paused.status, "paused");
  assert.equal(execution.calls.includes("stop"), false);
  const afterPause = await repository.getCycle(cycle.id);
  assert.equal(afterPause!.status, "running");

  // 旧 epoch 的停止请求被 lease_lost 拒绝（跨轮误停防护）。
  await assert.rejects(
    commands.stopCurrentCycle({
      context,
      programId: program.id,
      cycleId: cycle.id,
      epoch: 0,
      reason: "user_request",
    }),
    (error: unknown) => errorCode(error) === "lease_lost",
  );

  const detail = await commands.programDetail({ context, programId: program.id });
  const stopped = await commands.stopCurrentCycle({
    context,
    programId: program.id,
    cycleId: cycle.id,
    epoch: detail.lease!.epoch,
    reason: "user_request",
  });
  assert.equal(stopped.status, "cancelled");
  assert.ok(execution.calls.includes("stop"));
  assert.ok(execution.calls.includes("waitForQuiescence"));
  const programRow = await repository.getProgram(program.id);
  assert.equal(programRow!.status, "paused");
});

test("resolveDecision/dismiss：version 回答；旧 version 拒绝 version_conflict（E-06/E-32）", async (t) => {
  const { repository, commands } = await freshFixture();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const context = contextOf(program);
  // 决策行有复合 FK(program_id,source_cycle_id)→Cycle：先落一条终态来源轮。
  const sourceCycleId = `cycle-src-${dbCounter}`;
  await repository.insertCycle({
    id: sourceCycleId,
    programId: program.id,
    sequence: 1,
    triggerKey: `tk-${sourceCycleId}`,
    trigger: { kind: "manual" },
    status: "completed",
    configurationSnapshot: {},
    scriptText: TEMPLATE_TEXT,
    scriptHash: TEMPLATE_HASH,
    executionSessionId: `exec-${sourceCycleId}`,
    workflowRunId: `run-${sourceCycleId}`,
    traceId: `trace-${sourceCycleId}`,
    leaseEpoch: 0,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    startedAt: 1001,
    completedAt: 1002,
    createdAt: 1000,
    updatedAt: 1002,
  });
  const decision = makeDecision(program.id, { sourceCycleId });
  await repository.saveDecision(decision);

  await commands.resolveDecision({
    context,
    programId: program.id,
    decisionId: decision.id,
    version: 1,
    optionId: "split",
  });
  const resolved = await repository.getDecision(decision.id);
  assert.equal(resolved!.status, "resolved");
  assert.equal(resolved!.resolution?.optionId, "split");

  // 同 version 同答案重放幂等；旧 version（已回答前的 1）异答拒绝。
  await commands.resolveDecision({
    context,
    programId: program.id,
    decisionId: decision.id,
    version: 1,
    optionId: "split",
  });
  await assert.rejects(
    commands.resolveDecision({
      context,
      programId: program.id,
      decisionId: decision.id,
      version: 1,
      optionId: "keep",
    }),
    (error: unknown) => errorCode(error) === "version_conflict",
  );

  const second = makeDecision(program.id, {
    id: `decision-2-${dbCounter}`,
    fingerprint: "fp-second",
    sourceCycleId,
  });
  await repository.saveDecision(second);
  await commands.dismissDecision({
    context,
    programId: program.id,
    decisionId: second.id,
    version: 1,
  });
  assert.equal((await repository.getDecision(second.id))!.status, "dismissed");
});

test("resolveContinuation：grant 同 Cycle/Run 继续；stay_paused 保持；旧 version 拒绝（E-30/E-32）", async (t) => {
  const { repository, commands, execution } = await freshFixture();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const context = contextOf(program);

  execution.finish("errored", { failureCode: "budget_denied" });
  const cycle = await commands.runNow({ context, programId: program.id, requestId: "req-c" });
  await waitFor(async () => (await repository.getCycle(cycle.id))!.status === "suspended");
  const pending = await repository.getPendingContinuationRequest(cycle.id);
  assert.ok(pending, "预算挂起产生同轮唯一 pending 继续确认");

  // 旧 version 拒绝（重复扩额防护）。
  await assert.rejects(
    commands.resolveContinuation({
      context,
      programId: program.id,
      requestId: pending!.id,
      version: 99,
      answer: { kind: "continue_with_grant", grant: { costMicros: 100_000_000 } },
    }),
    (error: unknown) => errorCode(error) === "version_conflict",
  );

  // grant 后同 Cycle/Run 恢复（resumeSuspended，不铸第二个 Run）。
  execution.finish("completed");
  const result = await commands.resolveContinuation({
    context,
    programId: program.id,
    requestId: pending!.id,
    version: pending!.version,
    answer: { kind: "continue_with_grant", grant: { costMicros: 100_000_000 } },
  });
  assert.equal(result.resolutionKind, "continue_with_grant");
  assert.equal(result.resumedCycleId, cycle.id);
  assert.equal(
    execution.calls.includes("resumeSuspended"),
    false,
    "已完成的 Run 只收尾，不再恢复执行",
  );
  assert.equal(execution.submitted.length, 1);
  await waitFor(async () => (await repository.getCycle(cycle.id))!.status === "completed");

  // stay_paused：resolution 落库但 Cycle 保持 suspended（不自动恢复）。
  const {
    commands: commands2,
    repository: repository2,
    execution: execution2,
  } = await freshFixture();
  t.after(() => void repository2.close());
  const program2 = makeProgram({ id: `program-2-${dbCounter}` });
  await repository2.insertProgram(program2);
  const context2 = contextOf(program2);
  execution2.finish("errored", { failureCode: "budget_denied" });
  const cycle2 = await commands2.runNow({
    context: context2,
    programId: program2.id,
    requestId: "req-c2",
  });
  await waitFor(async () => (await repository2.getCycle(cycle2.id))!.status === "suspended");
  const pending2 = await repository2.getPendingContinuationRequest(cycle2.id);
  const stay = await commands2.resolveContinuation({
    context: context2,
    programId: program2.id,
    requestId: pending2!.id,
    version: pending2!.version,
    answer: { kind: "stay_paused" },
  });
  assert.equal(stay.resumedCycleId, null);
  assert.equal((await repository2.getCycle(cycle2.id))!.status, "suspended");
  assert.equal(execution2.calls.includes("resumeSuspended"), false);
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
