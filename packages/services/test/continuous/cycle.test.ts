// CT-05 手动完整 Cycle 集成测试（服务层）：supervisor 全链路（E-01/E-03/E-12/E-15）、
// reportIngestion 的增量导入与非法输出（I-08）、Run 失败也导入已保存报告与失败计数、
// 幂等 Run now、预算挂起→继续（E-08 服务侧链路）与 candidatePolicy 纯规则。
// 用例定义见 docs/testing/continuous.md §5/§6/§8。
//
// 真实 SQLite（CT-01 migration 建库）+ 注入的执行端口替身（报告页/终态可编排）；
// workspace 准备用替身（真实 Git 路径已在 workspace.test.ts 覆盖）。
// 模板来源用与 bootstrap ui-ux-v1 同构的固定文本（services 不 import CLI 实现——
// bootstrap 侧模板经真实 run service 的整轮执行见 template.test.ts）。
//
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
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import { selectCandidates } from "../../src/continuous/domain/candidatePolicy.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
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
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct05-"));
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
    consecutiveFailures: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** 可编排执行端口替身：报告按 sequence 分页吐出，终态由测试翻转。 */
class FakeExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  allItems: ContinuousReportItem[] = [];
  calls: string[] = [];
  pageSize = 1024;
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
    const pending = this.allItems
      .filter((item) => item.journalSequence > afterSequence)
      .sort((left, right) => left.journalSequence - right.journalSequence);
    if (pending.length === 0) return Promise.resolve({ items: [], nextCursor: afterSequence });
    const page = pending.slice(0, this.pageSize);
    return Promise.resolve({
      items: page,
      nextCursor: page[page.length - 1]!.journalSequence,
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

  inspectHealth(): Promise<never> {
    throw new Error("cycle.test 不驱动探活（health.test 覆盖）");
  }

  /** 追加一条报告（sequence 单调递增）。 */
  emit(kind: string, itemKey: string, payload: unknown): ContinuousReportItem {
    this.sequence += 1;
    const item = {
      kind: kind as ContinuousReportItem["kind"],
      itemKey,
      journalSequence: this.sequence,
      payload,
    };
    this.allItems.push(item);
    return item;
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
  createCandidateCheckpoint: async (request) => ({
    programId: request.programId,
    candidateId: request.candidateId,
    executionPath: request.executionPath,
    baseCommit: "f".repeat(40),
    ownedPaths: request.ownedPaths,
    createdAt: 1,
  }),
  restoreCandidateFiles: async () => [],
};

const templateSource: ContinuousTemplateSource = {
  resolve: () => ({ scriptText: TEMPLATE_TEXT, scriptHash: TEMPLATE_HASH }),
};

type SupervisorDeps = ConstructorParameters<typeof ContinuousSupervisor>[0];

function makeSupervisorDeps(
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
): SupervisorDeps {
  let now = 10_000;
  return {
    repository,
    execution,
    workspace: fakeWorkspace,
    clock: {
      now: () => (now += 1),
      timeZone: () => "Asia/Shanghai",
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, Math.min(delayMs, 1));
        return () => clearTimeout(timer);
      },
    },
    templateSource,
    pollIntervalMs: 1,
  };
}

function makeSupervisor(
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
): ContinuousSupervisor {
  return new ContinuousSupervisor(makeSupervisorDeps(repository, execution));
}

// ── V1 报告载荷助手 ──────────────────────────────────────────

function candidatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "candidate",
    itemKey: "cand-a",
    fingerprint: `fp-${nextId("cand")}-stable`,
    title: "Header spacing",
    rationale: "视觉不一致",
    targetPaths: ["src/ui/Header.tsx"],
    impact: 5,
    confidence: 0.9,
    effort: 2,
    risk: "low",
    evidence: [{ kind: "observation", detail: "fixture" }],
    ...overrides,
  };
}

function decisionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "decision",
    itemKey: "dec-a",
    fingerprint: `fp-${nextId("dec")}-stable`,
    title: "Settings navigation 重构",
    context: "涉及信息结构",
    options: [
      { id: "keep", label: "保持", consequences: "无变化" },
      { id: "split", label: "拆分", consequences: "导航层级变化" },
    ],
    recommendation: "keep",
    classification: "blocking",
    blockingScope: { candidateKeys: ["cand-a"], paths: [] },
    ...overrides,
  };
}

function validationPayload(
  candidateKey: string,
  stage: "tests" | "browser" | "review",
  outcome: "passed" | "failed" | "unverified",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "validation",
    itemKey: `${candidateKey}:${stage}`,
    candidateKey,
    stage,
    outcome,
    evidence: [{ kind: "command", detail: "argv=node --test exit=0" }],
    ...(outcome === "passed" ? {} : { reason: "fixture 原因" }),
    ...overrides,
  };
}

function candidateResultPayload(
  candidateKey: string,
  status: "done" | "rejected" | "unverified",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "candidate_result",
    itemKey: `${candidateKey}:result`,
    candidateKey,
    status,
    changedFiles: status === "done" ? ["src/ui/Header.tsx"] : [],
    commits: status === "done" ? ["a1b2c3d4e5"] : [],
    summary: "fixture 结果",
    ...(status === "done" ? {} : { reason: "fixture 原因" }),
    ...overrides,
  };
}

function cycleResultPayload(
  outcome: "changes_verified" | "no_changes" | "partial",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "cycle_result",
    itemKey: "cycle-result",
    outcome,
    changedFiles: [],
    commits: [],
    evidence: [{ kind: "cycle", detail: "fixture" }],
    summary: "fixture 汇总",
    ...overrides,
  };
}

/** 一个全过三验证的 done 候选 + cycle_result。 */
function emitVerifiedCandidate(
  execution: FakeExecutionPort,
  key: string,
  fingerprint: string,
): void {
  execution.emit("candidate", key, candidatePayload({ itemKey: key, fingerprint }));
  execution.emit("validation", `${key}:tests`, validationPayload(key, "tests", "passed"));
  execution.emit("validation", `${key}:browser`, validationPayload(key, "browser", "passed"));
  execution.emit("validation", `${key}:review`, validationPayload(key, "review", "passed"));
  execution.emit("candidate_result", `${key}:result`, candidateResultPayload(key, "done"));
}

// ── E-01/E-03：手动完整 Cycle 全链路 ─────────────────────────

test("E-01/E-03: Run now 全链路——快照/身份提交前持久化、报告导入、done 落队列、sleeping", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  emitVerifiedCandidate(execution, "cand-a", "fp-a-stable-0001");
  emitVerifiedCandidate(execution, "cand-b", "fp-b-stable-0002");
  emitVerifiedCandidate(execution, "cand-c", "fp-c-stable-0003");
  execution.emit("decision", "dec-a", decisionPayload());
  execution.emit(
    "cycle_result",
    "cycle-result",
    cycleResultPayload("changes_verified", { commits: ["a1b2c3d4e5"] }),
  );
  execution.finish("completed");

  const { cycle, completion } = await supervisor.runNow({
    programId: program.id,
    requestId: "req-1",
  });
  const outcome = await completion;

  // Cycle 快照：脚本 bytes/hash + 配置快照 + 执行身份在提交前持久化（submitOnce 拿到同一身份）。
  assert.equal(cycle.scriptText, TEMPLATE_TEXT);
  assert.equal(cycle.scriptHash, TEMPLATE_HASH);
  assert.ok(typeof cycle.configurationSnapshot === "object");
  const submitted = execution.submitted[0]!;
  assert.equal(submitted.cycleId, cycle.id);
  assert.equal(submitted.scriptHash, cycle.scriptHash);
  assert.equal(submitted.executionPath, join(tmpRoot, "worktrees", program.id));

  // 结算：completed + changes_verified；done 候选与提交可追踪；决策 pending。
  assert.equal(outcome.cycleStatus, "completed");
  assert.equal(outcome.programStatus, "sleeping");
  assert.equal(outcome.result?.outcome, "changes_verified");
  assert.deepEqual(outcome.result?.commits, ["a1b2c3d4e5"]);
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 0, "done 候选离开可执行队列");
  const decisions = await repository.listPendingDecisions(program.id);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.blockingScope!.candidateIds.length, 1);

  const storedCycle = await repository.getCycle(cycle.id);
  assert.equal(storedCycle!.status, "completed");
  assert.equal(storedCycle!.result!.outcome, "changes_verified");
  const storedProgram = await repository.getProgram(program.id);
  assert.equal(storedProgram!.status, "sleeping");
  assert.equal(storedProgram!.consecutiveFailures, 0);
  // nextCycleAt：默认 interval 6 小时（相对结算时刻）。
  assert.ok(storedProgram!.nextCycleAt! > storedCycle!.completedAt! + 5 * 3_600_000);
  // 选择理由已保存（审计事件）。
  const events = await repository.listCycleEvents(program.id, cycle.id);
  assert.ok(events.some((event) => event.type === "cycle.selection"));
});

test("E-03: 候选数超上限只选 3 项；未实施候选保持可执行（下一轮参与）", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  for (const key of ["cand-a", "cand-b", "cand-c", "cand-d"]) {
    execution.emit(
      "candidate",
      key,
      candidatePayload({ itemKey: key, fingerprint: `fp-${key}-stable` }),
    );
  }
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  execution.finish("completed");

  const { completion } = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const outcome = await completion;
  // 模板之外的候选未实施（无 candidate_result）→ no_changes；全部留在队列。
  assert.equal(outcome.result?.outcome, "no_changes");
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 4);
  const events = await repository.listCycleEvents(program.id, outcome.cycleId);
  const selection = events.find((event) => event.type === "cycle.selection");
  assert.ok(selection);
  assert.match(JSON.stringify(selection!.payload), /上限 3/);
});

// ── I-08：typed report 增量/非法输出 ─────────────────────────

test("I-08: 分批导入 + done 未过三阶段验证门被拒（不 done、不提交）；非法条目记拒绝事件", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  execution.pageSize = 2; // 强制多批：validation 与 candidate_result 不同批
  const supervisor = makeSupervisor(repository, execution);

  execution.emit("decision", "dec-a", decisionPayload());
  execution.emit("candidate", "cand-a", candidatePayload());
  // 只有 tests/browser 两阶段通过：review 缺失。
  execution.emit("validation", "cand-a:tests", validationPayload("cand-a", "tests", "passed"));
  execution.emit("validation", "cand-a:browser", validationPayload("cand-a", "browser", "passed"));
  // 非法条目：载荷缺必填字段（schema 拒绝）+ 读侧 unknown 类别。
  execution.emit("candidate", "cand-bad", { itemKey: "cand-bad" });
  execution.emit("unknown", "junk-1", "plain-string-item");
  // done 声称已提交（无 review 证据 → 门拒绝）。
  execution.emit(
    "candidate_result",
    "cand-a:result",
    candidateResultPayload("cand-a", "done", { commits: ["deadbeef99"] }),
  );
  execution.emit(
    "cycle_result",
    "cycle-result",
    cycleResultPayload("changes_verified", { commits: ["deadbeef99"] }),
  );
  execution.finish("completed");

  const { cycle, completion } = await supervisor.runNow({
    programId: program.id,
    requestId: "req-1",
  });
  const outcome = await completion;

  // done 未被采信：候选不 done、无提交；cycle_result 的 changes_verified 被压回 partial。
  assert.equal(outcome.result?.outcome, "partial");
  assert.deepEqual(outcome.result?.commits, []);
  assert.ok(outcome.reportRejections >= 2, "malformed 与未过门的条目都计拒绝");
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 1, "候选保留在队列（未 done）");

  // 拒绝事件：malformed 与 done_without_full_validation 各有记录；有效 Decision 不丢。
  const events = await repository.listCycleEvents(program.id, cycle.id);
  const rejected = events.filter((event) => event.type === "report.rejected");
  assert.ok(rejected.length >= 2);
  assert.ok(
    rejected.some((event) =>
      JSON.stringify(event.payload).includes("done_without_full_validation"),
    ),
  );
  const decisions = await repository.listPendingDecisions(program.id);
  assert.equal(decisions.length, 1, "非法输出不丢已有有效 Decision");
});

test("I-08: 运行中 Decision 已保存（终态前导入）；cursor 增量推进不重放", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  execution.emit("decision", "dec-a", decisionPayload());
  const { completion } = await supervisor.runNow({ programId: program.id, requestId: "req-1" });

  // Run 仍在 running：监督轮询已把 Decision 导入（运行中持久化，不是结算才写）。
  const deadline = Date.now() + 10_000;
  while ((await repository.listPendingDecisions(program.id)).length === 0) {
    if (Date.now() > deadline) assert.fail("运行中 Decision 未被导入");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  execution.finish("completed");
  const outcome = await completion;
  assert.equal(outcome.cycleStatus, "completed");
  // 决策事件恰一条（cursor 推进后不再重放）。
  const events = await repository.listCycleEvents(program.id, outcome.cycleId);
  assert.equal(events.filter((event) => event.type === "report.decision").length, 1);
});

// ── E-12：验证不可用 unverified 不提交 ───────────────────────

test("E-12: unverified 候选不 done；done 门要求 tests/browser/review 全 passed", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  execution.emit(
    "candidate",
    "cand-a",
    candidatePayload({ itemKey: "cand-a", fingerprint: "fp-a-unverified" }),
  );
  execution.emit("validation", "cand-a:tests", validationPayload("cand-a", "tests", "passed"));
  execution.emit(
    "validation",
    "cand-a:browser",
    validationPayload("cand-a", "browser", "unverified", { reason: "浏览器不可用" }),
  );
  execution.emit("validation", "cand-a:review", validationPayload("cand-a", "review", "passed"));
  execution.emit(
    "candidate_result",
    "cand-a:result",
    candidateResultPayload("cand-a", "unverified"),
  );
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("partial"));
  execution.finish("completed");

  const { completion } = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const outcome = await completion;
  assert.equal(outcome.result?.outcome, "partial");
  assert.deepEqual(outcome.result?.commits, []);
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 1, "unverified 候选不 done，保持可再观察");
});

// ── E-15：no_changes 与非法报告 ──────────────────────────────

test("E-15: 空候选 completed/no_changes 后休眠；非法 cycle_result 不产生 done/commit", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  execution.emit("cycle_result", "cycle-result", {
    kind: "cycle_result",
    outcome: "changes_verified",
  });
  execution.finish("completed");

  const { completion } = await supervisor.runNow({ programId: program.id, requestId: "req-1" });
  const outcome = await completion;
  // 非法 cycle_result 整条拒绝：无有效 done、无提交；空候选按 no_changes 收尾。
  assert.equal(outcome.result?.outcome, "no_changes");
  assert.deepEqual(outcome.result?.commits, []);
  assert.ok(outcome.reportRejections >= 1, "非法 cycle_result 记拒绝事件");
  const storedProgram = await repository.getProgram(program.id);
  assert.equal(storedProgram!.status, "sleeping");
  assert.ok(storedProgram!.nextCycleAt !== undefined, "no_changes 后休眠并计划下一轮");
});

// ── Run 失败：导入已保存报告 + 连续失败计数 ───────────────────

test("Run 失败也导入已保存报告；连续 3 轮 failed 后 Program failed 需显式恢复", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);

  for (let round = 1; round <= 3; round++) {
    const execution = new FakeExecutionPort();
    const supervisor = makeSupervisor(repository, execution);
    // Run 失败前已保存的报告必须导入（§11：不能只依赖模型最后一段总结）。
    execution.emit(
      "candidate",
      `cand-fail-${round}`,
      candidatePayload({ itemKey: `cand-fail-${round}` }),
    );
    execution.finish("errored", { failureCode: "ProviderError" });
    const outcome = await (
      await supervisor.runNow({ programId: program.id, requestId: `req-fail-${round}` })
    ).completion;
    assert.equal(outcome.cycleStatus, "failed");
    const storedProgram = await repository.getProgram(program.id);
    assert.equal(storedProgram!.consecutiveFailures, round);
    assert.equal(storedProgram!.status, round < 3 ? "sleeping" : "failed");
    const queue = await repository.listQueueableCandidates(program.id);
    assert.equal(queue.length, round, `第 ${round} 轮的已保存候选仍导入`);
  }

  // failed Program：Run now 明确拒绝（需显式恢复）。
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);
  await assert.rejects(
    supervisor.runNow({ programId: program.id, requestId: "req-after-fail" }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "program_not_runnable",
  );
});

// ── 幂等 Run now（E-16 服务侧前置）──────────────────────────

test("重复 Run now 同 requestId 命中同一 Cycle；不同 requestId 在开放 Cycle 期拒绝", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  const first = await supervisor.runNow({ programId: program.id, requestId: "req-same" });
  const replay = await supervisor.runNow({ programId: program.id, requestId: "req-same" });
  assert.equal(replay.cycle.id, first.cycle.id);
  assert.equal(execution.submitted.length, 2);
  assert.equal(new Set(execution.submitted.map((input) => input.workflowRunId)).size, 1);
  const cycles: Cycle[] = [];
  for (const submitted of execution.submitted)
    cycles.push((await repository.getCycle(submitted.cycleId))!);
  assert.equal(new Set(cycles.map((cycle) => cycle.id)).size, 1, "只有一个 Cycle");

  await assert.rejects(
    supervisor.runNow({ programId: program.id, requestId: "req-other" }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "open_cycle_exists",
  );
  execution.finish("completed");
  await first.completion;
});

// ── 预算挂起 → 用户授权 → 同 Cycle 同 Run 继续（E-08/E-30 服务侧）──

test("预算类失败挂起（suspended+paused+pending 确认）；grant 后同 Cycle/Run 继续完成", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);

  execution.emit("candidate", "cand-a", candidatePayload({ itemKey: "cand-a" }));
  execution.finish("errored", { failureCode: "budget_denied" });
  const { cycle, completion } = await supervisor.runNow({
    programId: program.id,
    requestId: "req-budget",
  });
  const outcome = await completion;

  assert.equal(outcome.cycleStatus, "suspended");
  assert.equal(outcome.programStatus, "paused");
  const pending = await repository.getPendingContinuationRequest(cycle.id);
  assert.ok(pending, "同轮唯一 pending 继续确认");
  assert.equal(pending!.reason, "cost_limit");
  const suspendedCycle = await repository.getCycle(cycle.id);
  assert.equal(suspendedCycle!.pendingContinuationRequestId, pending!.id);

  // 未回答时不能继续；回答带 grant 后同 Cycle/Run 恢复并完成。
  await assert.rejects(
    supervisor.continueSuspendedCycle(cycle.id),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "program_not_runnable",
  );
  await repository.saveContinuationRequest({
    ...pending!,
    status: "resolved",
    resolvedAt: pending!.createdAt + 1,
    resolution: {
      kind: "continue_with_grant",
      resolvedAt: pending!.createdAt + 1,
      grant: { costMicros: 100_000_000 },
    },
  });
  execution.finish("completed");
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  const resumed = await supervisor.continueSuspendedCycle(cycle.id);
  assert.equal(resumed.cycle.id, cycle.id);
  const resumedOutcome = await resumed.completion;
  assert.equal(resumedOutcome.cycleStatus, "completed");
  assert.equal(resumedOutcome.programStatus, "sleeping");
  // 同 Run：submitOnce 只发生过一次（resume 走 resumeSuspended，不铸第二个 Run）。
  assert.equal(execution.submitted.length, 1);
  assert.ok(execution.calls.includes("resumeSuspended"));
});

// ── 授权/模板边界 ────────────────────────────────────────────

test("模板 hash 与授权不符/远程 Program/暂停 Program 均结构化拒绝", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const drifted: ContinuousTemplateSource = {
    resolve: () => ({ scriptText: "const x = 1;\n" }),
  };
  const execution = new FakeExecutionPort();
  const base = makeSupervisor(repository, execution);
  const supervisor = new ContinuousSupervisor({
    ...makeSupervisorDeps(repository, execution),
    templateSource: drifted,
  });
  const program = makeProgram();
  await repository.insertProgram(program);
  await assert.rejects(
    supervisor.runNow({ programId: program.id, requestId: "req-1" }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "template_mismatch",
  );

  // 远程 Program：remote_execution_not_supported（D4）。
  const remote = makeProgram({ id: nextId("program-remote"), remoteSessionId: "rs-1" });
  await repository.insertProgram(remote);
  await assert.rejects(
    base.runNow({ programId: remote.id, requestId: "req-1" }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "remote_execution_not_supported",
  );

  // 暂停 Program：需显式恢复。
  const paused = makeProgram({
    id: nextId("program-paused"),
    status: "paused",
    statusReason: "用户暂停",
  });
  await repository.insertProgram(paused);
  await assert.rejects(
    base.runNow({ programId: paused.id, requestId: "req-1" }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "program_not_runnable",
  );
});

// ── candidatePolicy 纯规则（U 面）────────────────────────────

test("candidatePolicy: forbidden/Scope 外排除、pending Decision 局部推迟、上限与排序理由", () => {
  const candidate = (id: string, fingerprint: string, paths: string[], impact: number) => ({
    id,
    fingerprint,
    targetPaths: paths,
    impact,
    confidence: 0.9,
    effort: 2,
  });
  const selection = selectCandidates({
    candidates: [
      candidate("c1", "fp-1", ["src/ui/A.tsx"], 5),
      candidate("c2", "fp-2", ["secret/keys.ts"], 9), // forbidden
      candidate("c3", "fp-3", ["docs/readme.md"], 9), // Scope 外
      candidate("c4", "fp-4", ["src/settings/Nav.tsx"], 9), // 被 pending Decision 的 paths 阻塞
      candidate("c5", "fp-5", ["src/ui/B.tsx"], 4),
      candidate("c6", "fp-6", ["src/ui/C.tsx"], 3),
    ],
    scope: { allowedPaths: ["src"], forbiddenPaths: ["secret"] },
    pendingDecisions: [{ id: "d1", blockingScope: { candidateIds: [], paths: ["src/settings"] } }],
    maxImprovements: 2,
  });
  assert.deepEqual(
    selection.selected.map((entry) => entry.candidate.id),
    ["c1", "c5"],
    "按 impact×confidence/effort 降序取前 2（c6 名额外）",
  );
  const deferred = new Map(selection.deferred.map((entry) => [entry.candidate.id, entry.reason]));
  assert.equal(deferred.get("c2"), "forbidden_path");
  assert.equal(deferred.get("c3"), "outside_allowed_paths");
  assert.equal(deferred.get("c4"), "blocked_by_pending_decision");
  assert.match(selection.rationale, /已选 2\/6/);
  assert.match(selection.rationale, /推迟 3/);
});
