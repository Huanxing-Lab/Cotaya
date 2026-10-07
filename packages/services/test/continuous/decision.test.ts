// CT-06 Decision Queue 集成测试（服务层）：分类双检查与局部阻塞纯规则（U-06）、
// fingerprint 去重合并来源（E-07）、versioned resolve/dismiss 幂等与防覆盖（E-06）、
// resolution→未来 Cycle 重新核对（U-06「旧决策重核对」）、以及核心标准
// 「10 pending + 3 independent + 2 dependent → 3 完成、2 推迟、Program 不暂停、
// 下一轮仍启动」（I-10）。用例定义见 docs/testing/continuous.md §5/§6/§8。
//
// 真实 SQLite（CT-01 migration 建库）+ 注入执行端口替身（同 cycle.test 惯例）；
// workspace 准备用替身（真实 Git 路径在 workspace.test.ts 覆盖）。
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
import { ContinuousDecisionService } from "../../src/continuous/application/decisionService.js";
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import {
  decisionBlocksCandidate,
  evaluateCandidateClassification,
  mergeDecisionOnRediscovery,
} from "../../src/continuous/domain/decisionPolicy.js";
import { selectCandidates } from "../../src/continuous/domain/candidatePolicy.js";
import type { Program } from "../../src/continuous/domain/types.js";
import type {
  ContinuousExecutionPort,
  ContinuousReportItem,
  ExecutionReference,
  ExecutionState,
  ManagedCycleInput,
  WorkspacePreparationPort,
} from "../../src/continuous/application/ports.js";

// ── fixture（同 cycle.test.ts 惯例）────────────────────────────

const TEMPLATE_TEXT = "phase('观察');\nconst a = agent('observer');\nreturn {};\n";
const TEMPLATE_HASH = createHash("sha256").update(TEMPLATE_TEXT, "utf8").digest("hex");
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct06-"));
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

/** 可编排执行端口替身（同 cycle.test；报告按 sequence 吐出，终态由测试翻转）。 */
class FakeExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  allItems: ContinuousReportItem[] = [];
  calls: string[] = [];
  state: ExecutionState = { runId: "", status: "running", resumable: false };
  private sequence = 0;

  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
    this.submitted.push(input);
    this.state = { ...this.state, runId: input.workflowRunId };
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

  inspectHealth() {
    this.calls.push("inspectHealth");
    return Promise.resolve({
      runId: this.state.runId,
      actorIds: [],
      ownerEpoch: 1,
      reachable: true,
    });
  }

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
  createCandidateCheckpoint: async () => {
    throw new Error("decision.test 不驱动检查点");
  },
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
    // CT-10：本文件固定 autonomous 平台（observe_only 拒绝语义在 platform suite 验证）。
    platformExecutionMode: "autonomous",
    pollIntervalMs: 1,
  };
}

function makeSupervisor(
  repository: SqliteContinuousRepository,
  execution: FakeExecutionPort,
): ContinuousSupervisor {
  return new ContinuousSupervisor(makeSupervisorDeps(repository, execution));
}

function makeDecisionService(repository: SqliteContinuousRepository): ContinuousDecisionService {
  let now = 50_000;
  return new ContinuousDecisionService({
    repository,
    clock: { now: () => (now += 1) },
  });
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
    blockingScope: { candidateKeys: [], paths: [] },
    ...overrides,
  };
}

function validationPayload(
  candidateKey: string,
  stage: "tests" | "browser" | "review",
): Record<string, unknown> {
  return {
    kind: "validation",
    itemKey: `${candidateKey}:${stage}`,
    candidateKey,
    stage,
    outcome: "passed",
    evidence: [{ kind: "command", detail: "argv=node --test exit=0" }],
  };
}

function doneResultPayload(candidateKey: string, commit: string): Record<string, unknown> {
  return {
    kind: "candidate_result",
    itemKey: `${candidateKey}:result`,
    candidateKey,
    status: "done",
    changedFiles: ["src/ui/Header.tsx"],
    commits: [commit],
    summary: "fixture 完成",
  };
}

function cycleResultPayload(
  outcome: "changes_verified" | "no_changes" | "partial",
): Record<string, unknown> {
  return {
    kind: "cycle_result",
    itemKey: "cycle-result",
    outcome,
    changedFiles: [],
    commits: [],
    evidence: [{ kind: "cycle", detail: "fixture" }],
    summary: "fixture 汇总",
  };
}

/** 一个全过三验证的 done 候选。 */
function emitVerifiedCandidate(
  execution: FakeExecutionPort,
  key: string,
  fingerprint: string,
  commit: string,
  overrides: Record<string, unknown> = {},
): void {
  execution.emit("candidate", key, candidatePayload({ itemKey: key, fingerprint, ...overrides }));
  execution.emit("validation", `${key}:tests`, validationPayload(key, "tests"));
  execution.emit("validation", `${key}:browser`, validationPayload(key, "browser"));
  execution.emit("validation", `${key}:review`, validationPayload(key, "review"));
  execution.emit("candidate_result", `${key}:result`, doneResultPayload(key, commit));
}

// ── U-06：分类双检查与局部阻塞（纯规则）──────────────────────

test("U-06 分类双检查：操作能力独立于模型标签；未知类别默认进决策不扩大 allowed", () => {
  const scope = { allowedPaths: ["src"], forbiddenPaths: ["secret"] };
  // 未知类别 → 决策（unknownToDecision 锁定；不因「模型没说不」放行）。
  assert.deepEqual(
    evaluateCandidateClassification({
      declared: "maybe_fine",
      targetPaths: ["src/ui/A.tsx"],
      scope,
    }),
    { action: "to_decision", reason: "unknown_classification" },
  );
  // 显式 needs_decision → 决策。
  assert.deepEqual(
    evaluateCandidateClassification({
      declared: "needs_decision",
      targetPaths: ["src/ui/A.tsx"],
      scope,
    }),
    { action: "to_decision", reason: "declared_needs_decision" },
  );
  // 双检查都过 → 可自主实施。
  assert.deepEqual(
    evaluateCandidateClassification({
      declared: "autonomous",
      targetPaths: ["src/ui/A.tsx"],
      scope,
    }),
    { action: "autonomous", reason: "dual_check_passed" },
  );
  // 模型分类不是授权：autonomous 标签撞 forbidden/allowed 外路径照样排除
  // （Scope 边界不能被任何决策回答授权）。
  assert.deepEqual(
    evaluateCandidateClassification({
      declared: "autonomous",
      targetPaths: ["secret/keys.ts"],
      scope,
    }),
    { action: "excluded", reason: "forbidden_path" },
  );
  assert.deepEqual(
    evaluateCandidateClassification({
      declared: "autonomous",
      targetPaths: ["docs/readme.md"],
      scope,
    }),
    { action: "excluded", reason: "outside_allowed_paths" },
  );
});

test("U-06 局部 blockingScope：capability 不单独阻塞、空 scope 阻塞零候选、路径段前缀局部命中", () => {
  const candidate = { id: "c1", targetPaths: ["src/settings/Nav.tsx"] };
  // capability-only 决策（声明影响面，不点名候选/路径）不阻塞任何候选。
  assert.equal(
    decisionBlocksCandidate(
      { id: "d-cap", blockingScope: { candidateIds: [], paths: [], capability: "design_system" } },
      candidate,
    ),
    false,
    "capability 级决策不得默认覆盖整个候选面",
  );
  // 空 scope 阻塞零候选（记录给人类，不挡自主工作）。
  assert.equal(
    decisionBlocksCandidate({ id: "d-empty", blockingScope: undefined }, candidate),
    false,
  );
  assert.equal(
    decisionBlocksCandidate(
      { id: "d-empty2", blockingScope: { candidateIds: [], paths: [] } },
      candidate,
    ),
    false,
  );
  // 路径局部命中（段前缀）；candidateIds 命中。
  assert.equal(
    decisionBlocksCandidate(
      { id: "d-path", blockingScope: { candidateIds: [], paths: ["src/settings"] } },
      candidate,
    ),
    true,
  );
  assert.equal(
    decisionBlocksCandidate(
      { id: "d-path-other", blockingScope: { candidateIds: [], paths: ["src/settings-other"] } },
      candidate,
    ),
    false,
    "段边界前缀：src/settings-other 不是 src/settings 的前缀",
  );
  assert.equal(
    decisionBlocksCandidate(
      { id: "d-id", blockingScope: { candidateIds: ["c1"], paths: [] } },
      candidate,
    ),
    true,
  );
  // 选择期过滤复用同一谓词：capability-only pending 决策不推迟任何候选。
  const selection = selectCandidates({
    candidates: [
      {
        id: "c1",
        fingerprint: "fp-1",
        targetPaths: ["src/ui/A.tsx"],
        impact: 5,
        confidence: 0.9,
        effort: 2,
      },
    ],
    scope: { allowedPaths: ["src"], forbiddenPaths: [] },
    pendingDecisions: [
      { id: "d-cap", blockingScope: { candidateIds: [], paths: [], capability: "design_system" } },
    ],
    maxImprovements: 3,
  });
  assert.equal(selection.selected.length, 1, "capability-only 决策不阻塞独立候选");
  assert.equal(selection.deferred.length, 0);
});

// ── U-06/E-07：fingerprint 去重合并来源 ───────────────────────

test("E-07 重复发现合并来源：跨轮同 fingerprint 单行、sources 追加、终态与 version 稳定", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);

  const fingerprint = "fp-settings-nav-stable";
  // 第一轮：经真实报告导入发现决策（首见来源 = 第一轮 Cycle）。
  const first = new FakeExecutionPort();
  first.emit(
    "decision",
    "dec-a",
    decisionPayload({
      fingerprint,
      context: "第一轮观察",
      blockingScope: { candidateKeys: [], paths: ["src/settings"] },
    }),
  );
  first.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  first.finish("completed");
  const firstRun = await makeSupervisor(repository, first).runNow({
    programId: program.id,
    requestId: "req-disc-1",
  });
  await firstRun.completion;

  // 第二轮：同 fingerprint 重复发现（不同 Cycle、措辞变化）。
  const execution = new FakeExecutionPort();
  execution.emit("decision", "dec-a", decisionPayload({ fingerprint, context: "第二轮又看到了" }));
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  execution.finish("completed");
  const second = await makeSupervisor(repository, execution).runNow({
    programId: program.id,
    requestId: "req-disc-2",
  });
  await second.completion;

  const pending = await repository.listPendingDecisions(program.id);
  assert.equal(pending.length, 1, "同 fingerprint 只有一行");
  const merged = pending[0]!;
  assert.equal(merged.version, 1, "重复发现不动 version");
  assert.equal(merged.status, "pending");
  assert.equal(merged.title, "Settings navigation 重构", "首见身份保持稳定");
  assert.equal(merged.sources?.length, 2, "来源按 Cycle 追加");
  assert.deepEqual(
    merged.sources?.map((source) => source.cycleId),
    [firstRun.cycle.id, second.cycle.id],
  );
  assert.deepEqual(
    merged.blockingScope?.paths,
    ["src/settings"],
    "并集保持局部（无新增路径时不变）",
  );
});

test("E-07 合并后终态不重开：dismiss 后重复发现保持 dismissed、关联候选保持 rejected", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const decisions = makeDecisionService(repository);

  // 首轮：决策（关联 cand-b）+ 两个候选（cand-a 独立、cand-b 关联）。
  const execution = new FakeExecutionPort();
  execution.emit(
    "decision",
    "dec-a",
    decisionPayload({
      fingerprint: "fp-nav-stable",
      blockingScope: { candidateKeys: ["cand-b"], paths: [] },
    }),
  );
  execution.emit(
    "candidate",
    "cand-a",
    candidatePayload({
      itemKey: "cand-a",
      fingerprint: "fp-a-stable",
      targetPaths: ["src/ui/A.tsx"],
    }),
  );
  execution.emit(
    "candidate",
    "cand-b",
    candidatePayload({
      itemKey: "cand-b",
      fingerprint: "fp-b-stable",
      targetPaths: ["src/settings/B.tsx"],
    }),
  );
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  execution.finish("completed");
  const first = await makeSupervisor(repository, execution).runNow({
    programId: program.id,
    requestId: "req-e07-1",
  });
  await first.completion;

  const pending = await repository.listPendingDecisions(program.id);
  assert.equal(pending.length, 1);
  const decision = pending[0]!;

  // Dismiss：不授权实施——关联的 cand-b 同事务 rejected；cand-a 不受影响。
  const dismissed = await decisions.dismissDecision({
    programId: program.id,
    decisionId: decision.id,
    version: decision.version,
  });
  assert.equal(dismissed.status, "applied");
  assert.deepEqual(dismissed.rejectedCandidateIds, [decision.blockingScope!.candidateIds[0]]);
  const queueAfterDismiss = await repository.listQueueableCandidates(program.id);
  assert.deepEqual(
    queueAfterDismiss.map((candidate) => candidate.fingerprint).sort(),
    ["fp-a-stable"],
    "被 Dismiss 决策关联的候选离开可执行队列；不相关候选保留",
  );

  // 下一轮重复发现（同 fingerprint 决策 + 同 fingerprint 候选再上报）。
  const rediscovery = new FakeExecutionPort();
  rediscovery.emit(
    "decision",
    "dec-a",
    decisionPayload({ fingerprint: "fp-nav-stable", context: "又发现了" }),
  );
  rediscovery.emit(
    "candidate",
    "cand-b",
    candidatePayload({
      itemKey: "cand-b",
      fingerprint: "fp-b-stable",
      targetPaths: ["src/settings/B.tsx"],
    }),
  );
  emitVerifiedCandidate(rediscovery, "cand-a", "fp-a-stable", "e07aa1e7a2");
  rediscovery.emit("cycle_result", "cycle-result", cycleResultPayload("changes_verified"));
  rediscovery.finish("completed");
  const second = await makeSupervisor(repository, rediscovery).runNow({
    programId: program.id,
    requestId: "req-e07-2",
  });
  const secondOutcome = await second.completion;

  const after = await decisions.getDecision(decision.id);
  assert.equal(after!.status, "dismissed", "重复发现不重开已 dismiss 的决策");
  assert.equal(after!.sources?.length, 2, "来源追加但状态稳定");
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 0, "cand-b 终态粘性：重复上报不重开 rejected；cand-a 已 done");
  assert.deepEqual(secondOutcome.result?.commits, ["e07aa1e7a2"], "不相关候选照常完成");
  // 纯函数面：mergeDecisionOnRediscovery 不改终态身份。
  const mergedPure = mergeDecisionOnRediscovery(
    { ...after!, status: "dismissed", version: 2 },
    { ...after!, status: "pending", version: 1 },
  );
  assert.equal(mergedPure.status, "dismissed");
  assert.equal(mergedPure.version, 2, "version 不被旧观察回退");
});

// ── U-06/E-06：versioned resolve/dismiss ─────────────────────

test("E-06 resolve：幂等重放、旧 version 拒绝、非法 option 拒绝；resolution 与事件同事务", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const decisions = makeDecisionService(repository);

  // 种子：执行中发现的决策（recordEscalationDecision——决策适配器 sink 的落点；
  // 复合 FK 要求真实 Cycle 行，这里开一轮并在运行中持久化，再正常收尾）。
  const execution = new FakeExecutionPort();
  const supervisor = makeSupervisor(repository, execution);
  const run = await supervisor.runNow({ programId: program.id, requestId: "req-resolve-seed" });
  const recorded = await decisions.recordEscalationDecision({
    programId: program.id,
    cycleId: run.cycle.id,
    fingerprint: "fp-resolve-stable",
    title: "是否拆分 Settings 导航？",
    context: "执行中发现需要用户选择",
    options: [
      { id: "keep", label: "保持", consequences: "无变化" },
      { id: "split", label: "拆分", consequences: "导航层级变化" },
    ],
    classification: "blocking",
    blockingScope: { candidateIds: [], paths: ["src/settings"] },
    evidence: [{ kind: "escalation", detail: "fixture" }],
  });
  assert.equal(recorded.merged, false);
  const decisionId = recorded.decision.id;
  execution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  execution.finish("completed");
  await run.completion;

  // 非法 option：不在选项表内 → invalid_option（不落库）。
  await assert.rejects(
    decisions.resolveDecision({
      programId: program.id,
      decisionId,
      version: 1,
      optionId: "nope",
    }),
    (error: unknown) => (error as { kind?: string }).kind === "invalid_option",
  );

  // 首次 resolve：version 1 → applied；行 resolved、version 2、事件恰一条。
  const applied = await decisions.resolveDecision({
    programId: program.id,
    decisionId,
    version: 1,
    optionId: "split",
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.decision.status, "resolved");
  assert.equal(applied.decision.version, 2);
  assert.equal(applied.decision.resolution?.optionId, "split");

  // 重复同请求（同 version 同答案）→ 幂等 no-op，不重复扩事件。
  const replay = await decisions.resolveDecision({
    programId: program.id,
    decisionId,
    version: 1,
    optionId: "split",
  });
  assert.equal(replay.status, "idempotent");

  // 旧 version 异答 → version_conflict（防止覆盖其他回答）。
  await assert.rejects(
    decisions.resolveDecision({
      programId: program.id,
      decisionId,
      version: 1,
      optionId: "keep",
    }),
    (error: unknown) => (error as { code?: string }).code === "version_conflict",
  );
  // 跨 Program 回答拒绝。
  await assert.rejects(
    decisions.resolveDecision({ programId: "program-other", decisionId, version: 2 }),
    (error: unknown) => (error as { kind?: string }).kind === "program_mismatch",
  );

  const stored = await decisions.getDecision(decisionId);
  assert.equal(stored!.status, "resolved");
  const events = await repository.listCycleEvents(program.id, run.cycle.id);
  const resolvedEvents = events.filter((event) => event.type === "decision.resolved");
  assert.equal(resolvedEvents.length, 1, "resolution 只保存一次（事件幂等）");
  // 无关联候选时不产生 requeued 事件（记录型决策）。
  assert.equal(events.filter((event) => event.type === "decision.candidates_requeued").length, 0);
});

test("E-06 resolution→未来 Cycle：resolve 解除路径阻塞，候选在下一轮重新核对并完成；Scope 收紧仍排除", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);
  const decisions = makeDecisionService(repository);

  // 第一轮：决策阻塞 src/settings；候选 cand-b 在 src/settings 内 → 留队列不实施。
  const first = new FakeExecutionPort();
  first.emit(
    "decision",
    "dec-a",
    decisionPayload({
      fingerprint: "fp-future-stable",
      blockingScope: { candidateKeys: [], paths: ["src/settings"] },
    }),
  );
  first.emit(
    "candidate",
    "cand-b",
    candidatePayload({
      itemKey: "cand-b",
      fingerprint: "fp-b-future",
      targetPaths: ["src/settings/B.tsx"],
    }),
  );
  first.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  first.finish("completed");
  const firstRun = await makeSupervisor(repository, first).runNow({
    programId: program.id,
    requestId: "req-future-1",
  });
  const firstOutcome = await firstRun.completion;
  assert.equal(firstOutcome.cycleStatus, "completed");
  assert.equal(
    (await repository.listQueueableCandidates(program.id)).length,
    1,
    "cand-b 被决策阻塞，留队列",
  );

  // 执行中 resolve（当前轮已结束——resolve 不改历史轮；也不得触碰其 Cycle 行）。
  const decision = (await repository.listPendingDecisions(program.id))[0]!;
  await decisions.resolveDecision({
    programId: program.id,
    decisionId: decision.id,
    version: decision.version,
    optionId: "keep",
  });
  const firstCycleAfterResolve = await repository.getCycle(firstRun.cycle.id);
  assert.equal(firstCycleAfterResolve!.status, "completed", "resolution 不改已结束轮的终态");
  assert.equal(
    (await repository.getProgram(program.id))!.status,
    "sleeping",
    "Program 不因决策暂停",
  );

  // 第二轮：cand-b 不再被阻塞 → 实施/验证/提交（未来轮重新核对的正向面）。
  const second = new FakeExecutionPort();
  emitVerifiedCandidate(second, "cand-b", "fp-b-future", "f00ba1e7a1", {
    targetPaths: ["src/settings/B.tsx"],
  });
  second.emit("cycle_result", "cycle-result", cycleResultPayload("changes_verified"));
  second.finish("completed");
  const secondRun = await makeSupervisor(repository, second).runNow({
    programId: program.id,
    requestId: "req-future-2",
  });
  const secondOutcome = await secondRun.completion;
  assert.equal(secondOutcome.cycleStatus, "completed");
  assert.deepEqual(
    secondOutcome.result?.commits,
    ["f00ba1e7a1"],
    "decision→candidate→cycle→commit 可追踪",
  );
  assert.equal((await repository.listQueueableCandidates(program.id)).length, 0);

  // 反向重核对：新的同类候选在 Scope 收紧（forbidden）后即使决策已 resolve 也不可选。
  const programRow = (await repository.getProgram(program.id))!;
  await repository.saveProgram({
    ...programRow,
    scope: { ...programRow.scope, forbiddenPaths: ["src/settings"] },
  });
  const third = new FakeExecutionPort();
  third.emit(
    "candidate",
    "cand-c",
    candidatePayload({
      itemKey: "cand-c",
      fingerprint: "fp-c-future",
      targetPaths: ["src/settings/C.tsx"],
    }),
  );
  third.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  third.finish("completed");
  const thirdRun = await makeSupervisor(repository, third).runNow({
    programId: program.id,
    requestId: "req-future-3",
  });
  await thirdRun.completion;
  const queue = await repository.listQueueableCandidates(program.id);
  assert.equal(queue.length, 1, "候选保留可观察，但当前 Scope 下不可实施");
  const events = await repository.listCycleEvents(program.id, thirdRun.cycle.id);
  const selection = events.find((event) => event.type === "cycle.selection");
  assert.match(JSON.stringify(selection?.payload), /forbidden_path/, "选择理由记录 Scope 排除");
});

// ── I-10：核心标准 10 pending + 3 independent + 2 dependent ───

test("I-10 10 pending + 3 independent + 2 dependent：3 完成、2 推迟、Program 不暂停、下一轮仍启动", async (t) => {
  const repository = await freshRepository();
  t.after(() => void repository.close());
  const program = makeProgram();
  await repository.insertProgram(program);

  // 上一轮：真实报告发现 10 个 pending Decisions（paths 阻塞 src/settings 与 src/nav）。
  const discovery = new FakeExecutionPort();
  for (let index = 1; index <= 10; index++) {
    discovery.emit(
      "decision",
      `dec-${index}`,
      decisionPayload({
        itemKey: `dec-${index}`,
        fingerprint: `fp-pending-${index}-stable`,
        blockingScope: { candidateKeys: [], paths: [index % 2 === 0 ? "src/settings" : "src/nav"] },
      }),
    );
  }
  discovery.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  discovery.finish("completed");
  const discoveryRun = await makeSupervisor(repository, discovery).runNow({
    programId: program.id,
    requestId: "req-i10-discover",
  });
  const discoveryOutcome = await discoveryRun.completion;
  assert.equal(discoveryOutcome.cycleStatus, "completed");
  assert.equal((await repository.listPendingDecisions(program.id)).length, 10);

  // 本轮：3 个无依赖候选（实施/验证/提交）+ 2 个依赖候选（被 pending 决策阻塞）。
  const execution = new FakeExecutionPort();
  emitVerifiedCandidate(execution, "cand-i1", "fp-i1-stable", "a10c1f0001");
  emitVerifiedCandidate(execution, "cand-i2", "fp-i2-stable", "b10c2f0002");
  emitVerifiedCandidate(execution, "cand-i3", "fp-i3-stable", "c10c3f0003");
  execution.emit(
    "candidate",
    "cand-d1",
    candidatePayload({
      itemKey: "cand-d1",
      fingerprint: "fp-d1-stable",
      targetPaths: ["src/settings/D1.tsx"],
    }),
  );
  execution.emit(
    "candidate",
    "cand-d2",
    candidatePayload({
      itemKey: "cand-d2",
      fingerprint: "fp-d2-stable",
      targetPaths: ["src/nav/D2.tsx"],
    }),
  );
  execution.emit(
    "cycle_result",
    "cycle-result",
    cycleResultPayload("partial", { commits: ["a10c1f0001", "b10c2f0002", "c10c3f0003"] }),
  );
  execution.finish("completed");
  const run = await makeSupervisor(repository, execution).runNow({
    programId: program.id,
    requestId: "req-i10-run",
  });
  const outcome = await run.completion;

  // 3 独立项完成（过 done 门）；2 依赖项推迟（留队列，不 done 不 rejected）。
  assert.equal(outcome.cycleStatus, "completed");
  assert.equal(
    outcome.programStatus,
    "sleeping",
    "pending Decision 不暂停 Program（D 类确认才暂停）",
  );
  assert.deepEqual(outcome.result?.commits, ["a10c1f0001", "b10c2f0002", "c10c3f0003"]);
  const queue = await repository.listQueueableCandidates(program.id);
  assert.deepEqual(
    queue.map((candidate) => candidate.fingerprint).sort(),
    ["fp-d1-stable", "fp-d2-stable"],
    "2 依赖候选推迟（可执行队列保留，等待 resolution 后的未来轮）",
  );
  // 10 项仍 pending（本轮无人回答）。
  assert.equal((await repository.listPendingDecisions(program.id)).length, 10);
  // 选择理由记录推迟原因。
  const events = await repository.listCycleEvents(program.id, run.cycle.id);
  const selection = events.find((event) => event.type === "cycle.selection");
  assert.match(JSON.stringify(selection?.payload), /blocked_by_pending_decision/);
  // 不存在等待人类的永久 ask：本轮完整结算（Run 终态 completed、无挂起确认）。
  assert.equal((await repository.getPendingContinuationRequest(run.cycle.id)) ?? null, null);

  // 推进到下一轮：Run now（新 requestId）仍能启动并完成——Program 未被决策阻塞。
  const nextExecution = new FakeExecutionPort();
  nextExecution.emit("cycle_result", "cycle-result", cycleResultPayload("no_changes"));
  nextExecution.finish("completed");
  const nextRun = await makeSupervisor(repository, nextExecution).runNow({
    programId: program.id,
    requestId: "req-i10-next",
  });
  const nextOutcome = await nextRun.completion;
  assert.equal(nextOutcome.cycleStatus, "completed");
  assert.equal(nextOutcome.programStatus, "sleeping");
  assert.notEqual(nextRun.cycle.id, run.cycle.id, "下一轮是新的 Cycle");
  assert.equal(
    (await repository.listPendingDecisions(program.id)).length,
    10,
    "决策仍 pending，等待用户",
  );
});
