// CT-01 存储集成测试：I-01（migration/旧数据/FK/约束）、I-02（双连接并发 Cycle）、
// I-03（报告导入事务/终态结算原子性/跨 Program FK）。
// 用例定义见 docs/testing/continuous.md §6；全部使用真实 SQLite 文件（node:sqlite），
// 不用内存 Map 替代 migration/FK/事务语义。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import { ContinuousService } from "../../src/continuous/application/continuousService.js";
import type {
  Candidate,
  Cycle,
  Decision,
  Program,
  ReportImportInput,
} from "../../src/continuous/domain/types.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct01-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

const CONTINUOUS_TABLES = [
  "continuous_program",
  "continuous_cycle",
  "continuous_candidate",
  "continuous_decision",
  "continuous_candidate_decision",
  "continuous_usage",
  "continuous_event",
  "continuous_workspace_lease",
  "continuous_continuation_request",
] as const;

const CONTINUOUS_INDEXES = [
  "continuous_one_open_cycle",
  "continuous_due_program",
  "continuous_candidate_queue",
  "continuous_decision_queue",
  "continuous_usage_period",
  "continuous_event_history",
  "continuous_one_pending_continuation",
] as const;

type FactConnection = InstanceType<typeof DatabaseSync>;

function newDbPath(): string {
  dbCounter += 1;
  return join(tmpRoot, `tasks-index-${dbCounter}.sqlite`);
}

/** 真实迁移路径建库（同 Host storage worker 的入口），随后交给 repo/裸连接使用。 */
function migrateFreshDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
}

/** 断言用裸连接：FK 强制开启，验证的是数据库事实而非 repo 行为。 */
function openFactConnection(path: string): FactConnection {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function isConstraintError(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return typeof code === "number" && (code & 0xff) === 19;
}

function errorCodeMatches(error: unknown): boolean {
  return isConstraintError({ errcode: (error as { errcode?: number }).errcode });
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
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
    budget: CONTINUOUS_DEFAULT_BUDGET,
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
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeCycle(
  programId: string,
  sequence: number,
  triggerKey: string,
  overrides: Partial<Cycle> = {},
): Cycle {
  return {
    id: nextId("cycle"),
    programId,
    sequence,
    triggerKey,
    trigger: { kind: "manual" },
    status: "preparing",
    configurationSnapshot: { goal: "快照" },
    scriptText: "export default async () => {};",
    scriptHash: "b".repeat(64),
    executionSessionId: nextId("session"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    leaseEpoch: 0,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeCandidate(
  programId: string,
  sourceCycleId: string,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    id: nextId("candidate"),
    programId,
    sourceCycleId,
    fingerprint: nextId("fp"),
    title: "Header spacing",
    rationale: "视觉不一致",
    targetPaths: ["packages/ui/src/App.tsx"],
    impact: 3,
    confidence: 0.8,
    effort: 2,
    risk: "low",
    status: "candidate",
    evidence: [{ kind: "screenshot" }],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeDecision(
  programId: string,
  sourceCycleId: string,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id: nextId("decision"),
    programId,
    sourceCycleId,
    fingerprint: nextId("dfp"),
    version: 1,
    title: "Settings navigation 重构",
    context: "涉及信息结构",
    options: [
      { id: "keep", label: "保持", consequences: "无变化" },
      { id: "split", label: "拆分", consequences: "导航层级变化" },
    ],
    classification: "blocking",
    blockingScope: { candidateIds: [], paths: ["packages/ui/src/settings"] },
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function preparedRepository(path: string): Promise<SqliteContinuousRepository> {
  migrateFreshDatabase(path);
  const repo = new SqliteContinuousRepository(path);
  await repo.ensureReady();
  return repo;
}

function tableNames(db: FactConnection): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function indexNames(db: FactConnection): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function ledgerRows(db: FactConnection): Array<{ id: string; checksum: string }> {
  return db.prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id").all() as Array<{
    id: string;
    checksum: string;
  }>;
}

function insertLegacyRows(db: FactConnection): void {
  db.prepare(
    "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("ws-legacy", "/repos/legacy", "task-1", "旧任务", 111, 222);
  db.prepare(
    "INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("auto-1", "0 9 * * *", "旧自动化", "ws-legacy", "/repos/legacy", 111, 222);
}

// ── I-01：旧 DB 升级、重开、重复 migration ──

test("I-01 migration 建全 continuous 表与索引；重复执行、重开连接安全；旧 task/automation 行逐字段保持", async () => {
  const path = newDbPath();
  const db = new DatabaseSync(path);
  runTasksDatabaseMigrations(db);
  for (const table of CONTINUOUS_TABLES)
    assert.ok(tableNames(db).includes(table), `缺少表 ${table}`);
  for (const index of CONTINUOUS_INDEXES)
    assert.ok(indexNames(db).includes(index), `缺少索引 ${index}`);

  insertLegacyRows(db);
  const legacyLedger = ledgerRows(db);
  const legacyTasks = db.prepare("SELECT * FROM tasks").all();
  const legacyAutomations = db.prepare("SELECT * FROM automations").all();
  assert.equal(legacyLedger.length, 4);

  // 同一连接重复 migration：checksum 与旧数据不变。
  runTasksDatabaseMigrations(db);
  assert.deepEqual(ledgerRows(db), legacyLedger);
  assert.deepEqual(db.prepare("SELECT * FROM tasks").all(), legacyTasks);
  assert.deepEqual(db.prepare("SELECT * FROM automations").all(), legacyAutomations);
  db.close();

  // 重开连接后再跑 migration：仍安全，事实保持，新表可读写。
  const reopened = openFactConnection(path);
  runTasksDatabaseMigrations(reopened);
  assert.deepEqual(ledgerRows(reopened), legacyLedger);
  assert.deepEqual(reopened.prepare("SELECT * FROM tasks").all(), legacyTasks);
  assert.deepEqual(reopened.prepare("SELECT * FROM automations").all(), legacyAutomations);
  reopened.close();

  const repo = new SqliteContinuousRepository(path);
  await repo.ensureReady();
  const program = makeProgram();
  await repo.insertProgram(program);
  assert.equal((await repo.getProgram(program.id))?.goal, program.goal);
  repo.close({ throwOnError: true });
});

test("I-01 缺 0004 账本行的旧库升级：continuous 表按真实 migration 重建，checksum 与首跑一致，旧数据不动", () => {
  const path = newDbPath();
  migrateFreshDatabase(path);
  const facts = openFactConnection(path);
  const firstChecksum = ledgerRows(facts).find(
    (row) => row.id === "0004_continuous_long_term_state",
  )?.checksum;
  assert.ok(firstChecksum, "首次 migration 应记录 0004 checksum");
  insertLegacyRows(facts);
  const legacyTasks = facts.prepare("SELECT * FROM tasks").all();
  facts.close();

  // 构造「旧版本数据库」：只有 0001-0003 的账本与旧表，无任何 continuous 对象。
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec("BEGIN IMMEDIATE");
  for (const table of [...CONTINUOUS_TABLES].reverse())
    legacy.exec(`DROP TABLE IF EXISTS ${table}`);
  legacy
    .prepare("DELETE FROM tasks_schema_migration WHERE id = ?")
    .run("0004_continuous_long_term_state");
  legacy.exec("COMMIT");
  legacy.close();

  // 用当前代码升级：走同一条 runTasksDatabaseMigrations 入口。
  const upgraded = new DatabaseSync(path);
  runTasksDatabaseMigrations(upgraded);
  const names = tableNames(upgraded);
  for (const table of CONTINUOUS_TABLES) assert.ok(names.includes(table), `升级后缺少 ${table}`);
  assert.equal(
    ledgerRows(upgraded).find((row) => row.id === "0004_continuous_long_term_state")?.checksum,
    firstChecksum,
    "重复应用的 0004 checksum 必须与首跑一致",
  );
  assert.deepEqual(upgraded.prepare("SELECT * FROM tasks").all(), legacyTasks);
  upgraded.close();
});

test("I-01 一个 Program 一条未结束 Cycle：部分唯一索引拒绝第二个，跨 Program 互不影响，终态释放名额", async () => {
  const repo = await preparedRepository(newDbPath());
  const programA = makeProgram();
  const programB = makeProgram();
  await repo.insertProgram(programA);
  await repo.insertProgram(programB);

  const cycleA1 = makeCycle(programA.id, 1, "manual-req-1");
  await repo.insertCycle(cycleA1);
  assert.equal((await repo.getOpenCycle(programA.id))?.id, cycleA1.id);

  await assert.rejects(
    () => repo.insertCycle(makeCycle(programA.id, 2, "interval-2")),
    (error: unknown) => {
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      // 部分唯一索引只含 program_id 一列，SQLite 报「UNIQUE constraint failed: 表.列」。
      assert.match((error as Error).message, /continuous_cycle\.program_id$/);
      return true;
    },
    "第二个未结束 Cycle 必须被部分唯一索引拒绝",
  );

  // 不同 Program 各自允许一条。
  const cycleB1 = makeCycle(programB.id, 1, "manual-req-b1");
  await repo.insertCycle(cycleB1);
  assert.equal((await repo.getOpenCycle(programB.id))?.id, cycleB1.id);

  // 终态释放名额后可再开新轮。
  await repo.saveCycle({ ...cycleA1, status: "completed", completedAt: 1500 });
  assert.equal(await repo.getOpenCycle(programA.id), null);
  const cycleA2 = makeCycle(programA.id, 2, "interval-2");
  await repo.insertCycle(cycleA2);
  assert.equal((await repo.getOpenCycle(programA.id))?.id, cycleA2.id);

  // CT-16：按执行会话反查 Cycle（重启后 wire 发送路由的持久化事实源）——同会话优先
  // 未结束行；未知会话返回 null（不猜测归属，防同路径串任务）。
  assert.equal((await repo.getCycleByExecutionSession(cycleA2.executionSessionId))?.id, cycleA2.id);
  assert.equal(await repo.getCycleByExecutionSession("ctexec-unknown"), null);
  repo.close({ throwOnError: true });
});

test("I-01 trigger_key / sequence / workflow_run_id 唯一：重复创建被数据库拒绝", async () => {
  const repo = await preparedRepository(newDbPath());
  const program = makeProgram();
  await repo.insertProgram(program);
  const cycle1 = makeCycle(program.id, 1, "manual-req-1");
  await repo.insertCycle(cycle1);
  // 先结束第一轮，避免部分唯一索引（program_id）先于目标约束触发。
  await repo.saveCycle({ ...cycle1, status: "completed", completedAt: 1500 });

  await assert.rejects(
    () => repo.insertCycle(makeCycle(program.id, 2, "manual-req-1")),
    (error: unknown) => isConstraintError(error) && /trigger_key/.test((error as Error).message),
    "同 trigger_key 必须被 UNIQUE 拒绝",
  );
  await assert.rejects(
    () => repo.insertCycle(makeCycle(program.id, 1, "manual-req-2")),
    (error: unknown) => isConstraintError(error) && /sequence/.test((error as Error).message),
    "同 sequence 必须被 UNIQUE 拒绝",
  );
  await assert.rejects(
    () =>
      repo.insertCycle(
        makeCycle(program.id, 2, "manual-req-2", { workflowRunId: cycle1.workflowRunId }),
      ),
    (error: unknown) =>
      isConstraintError(error) && /workflow_run_id/.test((error as Error).message),
    "重复 workflow_run_id 必须被 UNIQUE 拒绝",
  );
  repo.close({ throwOnError: true });
});

test("I-01 跨 Program 复合 FK：candidate/decision/link/usage/event 引用归属错误一律拒绝", async () => {
  const repo = await preparedRepository(newDbPath());
  const programA = makeProgram();
  const programB = makeProgram();
  await repo.insertProgram(programA);
  await repo.insertProgram(programB);
  const cycleA = makeCycle(programA.id, 1, "manual-a");
  const cycleB = makeCycle(programB.id, 1, "manual-b");
  await repo.insertCycle(cycleA);
  await repo.insertCycle(cycleB);

  // candidate 声明属于 A 却引用 B 的 Cycle：复合 FK 拒绝。
  await assert.rejects(
    () => repo.saveCandidate(makeCandidate(programA.id, cycleB.id)),
    (error: unknown) => {
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      assert.match((error as Error).message, /FOREIGN KEY/);
      return true;
    },
    "candidate 跨 Program 引用必须拒绝",
  );
  await assert.rejects(
    () => repo.saveDecision(makeDecision(programA.id, cycleB.id)),
    (error: unknown) => isConstraintError(error),
    "decision 跨 Program 引用必须拒绝",
  );
  const candidateA = makeCandidate(programA.id, cycleA.id);
  const decisionB = makeDecision(programB.id, cycleB.id);
  await repo.saveCandidate(candidateA);
  await repo.saveDecision(decisionB);
  await assert.rejects(
    () =>
      repo.applyReportImport({
        programId: programA.id,
        cycleId: cycleA.id,
        nextCursor: 1,
        items: [
          {
            candidateDecisionLink: {
              programId: programA.id,
              candidateId: candidateA.id,
              decisionId: decisionB.id,
            },
          },
        ],
      }),
    (error: unknown) => isConstraintError(error),
    "link 表复合 FK 必须保证同一 Program",
  );
  // usage 的 cycle FK 与 event 的 program FK。
  await assert.rejects(
    () =>
      repo.insertUsageRecord({
        id: nextId("usage"),
        cycleId: "missing-cycle",
        requestKey: nextId("req"),
        state: "reserved",
        provider: "fixture",
        model: "m1",
        pricingVersion: "v1",
        reservedCostMicros: 100,
        reservedTokens: 10,
        occurredAt: 1,
        updatedAt: 1,
      }),
    (error: unknown) => isConstraintError(error),
    "usage 引用不存在的 Cycle 必须拒绝",
  );
  await assert.rejects(
    () =>
      repo.appendEvent({
        programId: "missing-program",
        eventKey: nextId("event"),
        type: "cycle_started",
        payload: {},
        createdAt: 1,
      }),
    (error: unknown) => isConstraintError(error),
    "event 引用不存在的 Program 必须拒绝",
  );
  repo.close({ throwOnError: true });
});

test("I-01 同 Cycle 只允许一条 pending 继续确认（部分唯一索引）", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const program = makeProgram();
  await repo.insertProgram(program);
  const cycle = makeCycle(program.id, 1, "manual-1");
  await repo.insertCycle(cycle);

  const facts = openFactConnection(path);
  const insertRequest = (id: string, status: string) =>
    facts
      .prepare(
        `INSERT INTO continuous_continuation_request
         (id, program_id, cycle_id, version, reason, status, request_json, created_at)
         VALUES (?, ?, ?, 1, 'cost_limit', ?, '{}', 1)`,
      )
      .run(id, program.id, cycle.id, status);
  insertRequest("cr-1", "pending");
  assert.throws(
    () => insertRequest("cr-2", "pending"),
    (error: unknown) => {
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      // 部分唯一索引只在 cycle_id 上，SQLite 以「表.列」形式报告冲突来源。
      assert.match((error as Error).message, /continuous_continuation_request\.cycle_id$/);
      return true;
    },
    "同 Cycle 第二条 pending 必须被部分唯一索引拒绝",
  );
  // resolved 后允许新的 pending（下一次资源暂停再问一次）。
  facts
    .prepare(
      "UPDATE continuous_continuation_request SET status='resolved', resolved_at=2 WHERE id='cr-1'",
    )
    .run();
  insertRequest("cr-3", "pending");
  facts.close();
  repo.close({ throwOnError: true });
});

test("I-01 workspace lease：CHECK 要求 cycle/owner/expiry 同有同空；epoch 单调且释放不重置", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const program = makeProgram();
  await repo.insertProgram(program);
  const cycle = makeCycle(program.id, 1, "manual-1");
  await repo.insertCycle(cycle);
  const key = program.workspaceKey;

  const facts = openFactConnection(path);
  assert.throws(
    () =>
      facts
        .prepare(
          `INSERT INTO continuous_workspace_lease (workspace_key, cycle_id, owner_id, epoch, expires_at, updated_at)
           VALUES (?, ?, NULL, 1, 1, 1)`,
        )
        .run(key, cycle.id),
    (error: unknown) => {
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      assert.match((error as Error).message, /CHECK/);
      return true;
    },
    "cycle 有值而 owner 为空必须被 CHECK 拒绝",
  );
  facts.close();

  await repo.acquireLease({
    workspaceKey: key,
    cycleId: cycle.id,
    ownerId: "host-1",
    epoch: 1,
    expiresAt: 90,
    updatedAt: 1,
  });
  assert.equal((await repo.getLease(key))?.epoch, 1);
  await assert.rejects(
    () =>
      repo.acquireLease({
        workspaceKey: key,
        cycleId: cycle.id,
        ownerId: "host-1",
        epoch: 1,
        expiresAt: 120,
        updatedAt: 2,
      }),
    (error: unknown) => (error as { kind?: string }).kind === "epoch_conflict",
    "相同 epoch 重复获取必须拒绝",
  );
  await assert.rejects(
    () =>
      repo.acquireLease({
        workspaceKey: key,
        cycleId: cycle.id,
        ownerId: "host-1",
        epoch: 0,
        expiresAt: 120,
        updatedAt: 2,
      }),
    (error: unknown) => (error as { kind?: string }).kind === "epoch_conflict",
    "epoch 回退必须拒绝",
  );
  // 正常释放：cycle/owner/expiry 同时置空，epoch 保留。
  await repo.releaseLease(key, 3);
  const released = await repo.getLease(key);
  assert.equal(released?.cycleId, undefined);
  assert.equal(released?.ownerId, undefined);
  assert.equal(released?.expiresAt, undefined);
  assert.equal(released?.epoch, 1, "释放后 epoch 必须保留");
  // 再接管必须携带更大 epoch。
  await repo.acquireLease({
    workspaceKey: key,
    cycleId: cycle.id,
    ownerId: "host-2",
    epoch: 2,
    expiresAt: 90,
    updatedAt: 4,
  });
  assert.equal((await repo.getLease(key))?.epoch, 2);
  await assert.rejects(
    () => repo.releaseLease("missing-workspace", 5),
    (error: unknown) => (error as { kind?: string }).kind === "lease_not_found",
  );
  repo.close({ throwOnError: true });
});

// ── I-02：两连接同时创建 Cycle ──

test("I-02 多连接并发创建 Cycle：数据库只接受一个（worker 竞争，不靠内存 mutex）", async () => {
  const path = newDbPath();
  migrateFreshDatabase(path);
  const setup = new SqliteContinuousRepository(path);
  const program = makeProgram();
  await setup.insertProgram(program);
  setup.close({ throwOnError: true });

  const workerCount = 4;
  const barrier = new SharedArrayBuffer(8);
  const workerSource = `
    Promise.all([import("node:worker_threads"), import("node:sqlite")]).then(
      ([{ parentPort, workerData }, { DatabaseSync }]) => {
        const state = new Int32Array(workerData.barrier);
        let db;
        try {
          db = new DatabaseSync(workerData.path);
          db.exec("PRAGMA busy_timeout = 10000");
          db.exec("PRAGMA foreign_keys = ON");
          Atomics.add(state, 0, 1);
          const wake = Atomics.wait(state, 1, 0, 15000);
          if (wake !== "ok") throw new Error("barrier timeout");
          db.prepare(
            "INSERT INTO continuous_cycle (id, program_id, sequence, trigger_key, trigger_json, status, config_snapshot_json, script_text, script_hash, execution_session_id, workflow_run_id, trace_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'preparing', '{}', 'script', 'hash', ?, ?, ?, 1, 1)"
          ).run(workerData.cycleId, workerData.programId, workerData.triggerKey, workerData.triggerJson, workerData.sessionId, workerData.runId, workerData.traceId);
          db.close();
          parentPort.postMessage({ ok: true });
        } catch (error) {
          try { db?.close(); } catch {}
          parentPort.postMessage({
            ok: false,
            errcode: error && error.errcode !== undefined ? error.errcode : null,
            message: String(error && error.message ? error.message : error),
          });
        }
      }
    );
  `;
  const workers = Array.from({ length: workerCount }, (_, index) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        path,
        barrier,
        programId: program.id,
        cycleId: nextId("cycle"),
        triggerKey: `race-${index}`,
        triggerJson: '{"kind":"manual"}',
        sessionId: nextId("session"),
        runId: nextId("run"),
        traceId: nextId("trace"),
      },
    });
    const done = new Promise<{ ok: boolean; errcode: number | null; message: string }>(
      (resolve, reject) => {
        worker.on("message", (message) => resolve(message));
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`worker 退出码 ${code}`));
        });
      },
    );
    return { worker, done };
  });

  // 等全部 worker 就位后统一放行，制造真实并发窗口。
  const state = new Int32Array(barrier);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(state, 0) < workerCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Atomics.load(state, 0), workerCount, "所有 worker 必须到达 barrier");
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);

  const results = [];
  for (const { worker, done } of workers) {
    results.push(await done);
    await worker.terminate();
  }
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, `并发创建只允许一个成功: ${JSON.stringify(results)}`);
  for (const loser of losers) {
    assert.ok(
      errorCodeMatches({ errcode: loser.errcode }),
      `失败者必须是数据库约束拒绝（含 BUSY 后重试撞唯一索引）: ${loser.message}`,
    );
  }

  const facts = openFactConnection(path);
  const cycles = facts.prepare("SELECT id FROM continuous_cycle").all() as Array<{ id: string }>;
  assert.equal(cycles.length, 1, "数据库中只能有一条 Cycle");
  facts.close();
});

test("I-02 双 repo 双连接顺序竞争：先落库者胜，后到者被 UNIQUE 拒绝", async () => {
  const path = newDbPath();
  migrateFreshDatabase(path);
  const repoA = new SqliteContinuousRepository(path);
  const repoB = new SqliteContinuousRepository(path);
  await repoA.ensureReady();
  await repoB.ensureReady();
  const program = makeProgram();
  await repoA.insertProgram(program);

  const first = makeCycle(program.id, 1, "manual-req-1");
  await repoA.insertCycle(first);
  await assert.rejects(
    () => repoB.insertCycle(makeCycle(program.id, 2, "manual-req-1")),
    (error: unknown) =>
      // 同轮未结束 + 重复 trigger_key 同时成立：任一 UNIQUE 拒绝都证明数据库级幂等。
      isConstraintError(error) && /program_id|trigger_key/.test((error as Error).message),
    "另一连接重复 trigger_key 必须被数据库拒绝",
  );
  await assert.rejects(
    () => repoB.insertCycle(makeCycle(program.id, 2, "manual-req-2")),
    (error: unknown) =>
      isConstraintError(error) && (error as Error).message.endsWith("continuous_cycle.program_id"),
    "另一连接的第二个未结束 Cycle 必须被部分唯一索引拒绝",
  );
  assert.equal((await repoB.getOpenCycle(program.id))?.id, first.id);
  repoA.close({ throwOnError: true });
  repoB.close({ throwOnError: true });
});

// ── I-03：报告导入事务、终态结算原子性 ──

test("I-03 导入中途异常整体回滚：无半条队列、事件与 cursor 同步保持", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const programA = makeProgram();
  const programB = makeProgram();
  await repo.insertProgram(programA);
  await repo.insertProgram(programB);
  const cycleA = makeCycle(programA.id, 1, "manual-a");
  const cycleB = makeCycle(programB.id, 1, "manual-b");
  await repo.insertCycle(cycleA);
  await repo.insertCycle(cycleB);

  const goodCandidate = makeCandidate(programA.id, cycleA.id);
  const goodDecision = makeDecision(programA.id, cycleA.id);
  const badCandidate = makeCandidate(programA.id, cycleB.id, { fingerprint: "cross-fp" });
  const failingImport: ReportImportInput = {
    programId: programA.id,
    cycleId: cycleA.id,
    nextCursor: 7,
    items: [
      { candidate: goodCandidate },
      { decision: goodDecision },
      {
        event: {
          programId: programA.id,
          cycleId: cycleA.id,
          eventKey: "evt-1",
          type: "candidate_discovered",
          payload: { fingerprint: goodCandidate.fingerprint },
          createdAt: 1,
        },
      },
      // 最后一条跨 Program：复合 FK 在事务中途失败。
      { candidate: badCandidate },
    ],
  };
  await assert.rejects(
    () => repo.applyReportImport(failingImport),
    (error: unknown) => {
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      return true;
    },
    "跨 Program 候选必须让整个导入事务失败",
  );

  assert.equal((await repo.listQueueableCandidates(programA.id)).length, 0, "不能留下半条候选队列");
  assert.equal((await repo.listPendingDecisions(programA.id)).length, 0, "不能留下半条决策队列");
  assert.equal((await repo.getOpenCycle(programA.id))?.reportCursor, 0, "cursor 不得推进");
  const facts = openFactConnection(path);
  const eventCount = facts.prepare("SELECT count(*) AS n FROM continuous_event").get() as {
    n: number;
  };
  assert.equal(eventCount.n, 0, "事件同样不落半条");
  facts.close();
  repo.close({ throwOnError: true });
});

test("I-03 导入重放幂等：重复批次不新增行、不重复事件，cursor 按事务推进", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const program = makeProgram();
  await repo.insertProgram(program);
  const cycle = makeCycle(program.id, 1, "manual-1");
  await repo.insertCycle(cycle);

  const candidate = makeCandidate(program.id, cycle.id);
  const decision = makeDecision(program.id, cycle.id);
  const batch: ReportImportInput = {
    programId: program.id,
    cycleId: cycle.id,
    nextCursor: 5,
    items: [
      { candidate },
      { decision },
      {
        candidateDecisionLink: {
          programId: program.id,
          candidateId: candidate.id,
          decisionId: decision.id,
        },
      },
      {
        event: {
          programId: program.id,
          cycleId: cycle.id,
          eventKey: "evt-batch-1",
          type: "candidate_discovered",
          payload: { n: 1 },
          createdAt: 1,
        },
      },
    ],
  };
  await repo.applyReportImport(batch);
  assert.equal((await repo.listQueueableCandidates(program.id)).length, 1);
  assert.equal((await repo.listPendingDecisions(program.id)).length, 1);
  assert.equal((await repo.getOpenCycle(program.id))?.reportCursor, 5);

  // 完全相同的批次重放：行数、事件数不变（重复不新增），cursor 值一致。
  await repo.applyReportImport(batch);
  assert.equal((await repo.listQueueableCandidates(program.id)).length, 1, "重放不得新增候选");
  assert.equal((await repo.listPendingDecisions(program.id)).length, 1, "重放不得新增决策");
  assert.equal((await repo.getOpenCycle(program.id))?.reportCursor, 5);

  // 新批次推进 cursor 并追加不同内容。
  const candidate2 = makeCandidate(program.id, cycle.id, { fingerprint: "fp-2" });
  await repo.applyReportImport({
    programId: program.id,
    cycleId: cycle.id,
    nextCursor: 9,
    items: [
      { candidate: candidate2 },
      {
        event: {
          programId: program.id,
          cycleId: cycle.id,
          eventKey: "evt-batch-2",
          type: "candidate_discovered",
          payload: { n: 2 },
          createdAt: 2,
        },
      },
    ],
  });
  assert.equal((await repo.listQueueableCandidates(program.id)).length, 2);
  assert.equal((await repo.getOpenCycle(program.id))?.reportCursor, 9);

  const facts = openFactConnection(path);
  const events = facts
    .prepare("SELECT id, event_key FROM continuous_event ORDER BY id")
    .all() as Array<{ id: number; event_key: string }>;
  assert.deepEqual(
    events.map((event) => event.event_key),
    ["evt-batch-1", "evt-batch-2"],
    "事件按 event_key 去重且 id 递增",
  );
  assert.ok(events[1].id > events[0].id, "事件 id 必须递增");
  const links = facts.prepare("SELECT count(*) AS n FROM continuous_candidate_decision").get() as {
    n: number;
  };
  assert.equal(links.n, 1, "关联重放不重复插入");
  facts.close();
  repo.close({ throwOnError: true });
});

test("I-03 终态 Cycle 与 nextCycleAt 同事务：一起提交；program 缺失时 Cycle 保持原状", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const program = makeProgram();
  await repo.insertProgram(program);
  const cycle = makeCycle(program.id, 1, "manual-1", { status: "running" });
  await repo.insertCycle(cycle);

  const completed: Cycle = {
    ...cycle,
    status: "completed",
    completedAt: 1500,
    result: {
      outcome: "no_changes",
      changedFiles: [],
      commits: [],
      evidence: [],
      summary: "无候选",
    },
    updatedAt: 1500,
  };
  await repo.completeCycle(completed, {
    status: "sleeping",
    nextCycleAt: 2000,
    lastCycleAt: 1500,
    consecutiveFailures: 0,
    updatedAt: 1500,
  });
  assert.equal((await repo.getCycle(cycle.id))?.status, "completed");
  const programAfter = await repo.getProgram(program.id);
  assert.equal(programAfter?.status, "sleeping");
  assert.equal(programAfter?.nextCycleAt, 2000);
  assert.equal(programAfter?.lastCycleAt, 1500);
  assert.equal(await repo.getOpenCycle(program.id), null, "终态后开放名额释放");

  // 事务中断注入：FK 关闭后删除 program；cycle 行再写入时 FK 复检在事务内失败并回滚。
  const breaker = new DatabaseSync(path);
  breaker.exec("PRAGMA foreign_keys = OFF");
  breaker.prepare("DELETE FROM continuous_program WHERE id = ?").run(program.id);
  breaker.close();
  const before = await repo.getCycle(cycle.id);
  assert.ok(before);
  const failedSettlement: Cycle = { ...before, reportCursor: 42, updatedAt: 999 };
  await assert.rejects(
    () => repo.completeCycle(failedSettlement, { updatedAt: 999 }),
    (error: unknown) => {
      // SQLite 在子行 UPDATE 时复检 FK（program 已被外部删除），事务整体回滚。
      assert.ok(isConstraintError(error), `应是约束错误: ${String(error)}`);
      return true;
    },
    "program 缺失时结算必须失败且不留半次结算",
  );
  const after = await repo.getCycle(cycle.id);
  assert.ok(after);
  assert.equal(after.reportCursor, before.reportCursor, "回滚后 cursor 不得变化");
  assert.equal(after.updatedAt, before.updatedAt, "回滚后 cycle 保持原状（无半次结算）");
  repo.close({ throwOnError: true });
});

// ── JSON 运行时校验与 service 组装 ──

test("I-01 JSON 字段经运行时 schema 校验：非法配置写入与坏行读取均拒绝", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const invalidScope = makeProgram({
    scope: {
      allowedPaths: [],
      forbiddenPaths: [],
      forbiddenCapabilities: ["bogus_capability"],
    } as unknown as Program["scope"],
  });
  await assert.rejects(
    () => repo.insertProgram(invalidScope),
    (error: unknown) => (error as { kind?: string }).kind === "continuous_codec_invalid",
    "非法 scope 必须在写入前被 schema 拒绝",
  );
  const program = makeProgram();
  await repo.insertProgram(program);
  const corrupt = new DatabaseSync(path);
  corrupt
    .prepare("UPDATE continuous_program SET config_json = ? WHERE id = ?")
    .run('{"goal":"缺少策略字段"}', program.id);
  corrupt.close();
  await assert.rejects(
    () => repo.getProgram(program.id),
    (error: unknown) => (error as { kind?: string }).kind === "continuous_codec_invalid",
    "读取损坏行必须失败，不得静默返回任意输入",
  );
  repo.close({ throwOnError: true });
});

test("service CRUD：身份规则、trigger 幂等、open cycle 检查、revision 乐观锁与 usage 账本", async () => {
  const path = newDbPath();
  const repo = await preparedRepository(path);
  const now = 17000;
  const service = new ContinuousService({
    repository: repo,
    clock: { now: () => now, timeZone: () => "Asia/Shanghai" },
  });
  const templateProgram = makeProgram();

  const program = await service.createProgram({
    workspacePath: "/repos/app",
    workspaceIdentity: "  remote-id-1  ",
    goal: "持续改进桌面 UI",
    scope: templateProgram.scope,
    budget: CONTINUOUS_DEFAULT_BUDGET,
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    templateId: "ui-ux-v1",
    templateVersion: "1",
    templateHash: "a".repeat(64),
    authorization: {
      revision: 1,
      templateHash: "a".repeat(64),
      grantedAt: "2026-10-05T00:00:00Z",
    },
  });
  assert.equal(program.workspaceKey, "remote-id-1", "身份 key 必须 trim 后优先 identity");
  assert.equal(program.status, "active");

  const cycleInput = {
    programId: program.id,
    triggerKey: "manual-req-1",
    trigger: { kind: "manual" as const },
    scriptText: "script",
    scriptHash: "b".repeat(64),
    executionSessionId: "sess-1",
    workflowRunId: "run-1",
    traceId: "trace-1",
    configurationSnapshot: { revision: 1 },
  };
  const cycle = await service.createCycle(cycleInput);
  assert.equal(cycle.sequence, 1);
  assert.equal(cycle.status, "preparing");

  await assert.rejects(
    () => service.createCycle(cycleInput),
    (error: unknown) => (error as { kind?: string }).kind === "open_cycle_exists",
    "service 前置检查拦截重复创建（同轮未结束），不会落到第二Cycle",
  );
  await assert.rejects(
    () => service.createCycle({ ...cycleInput, triggerKey: "manual-req-2" }),
    (error: unknown) => (error as { kind?: string }).kind === "open_cycle_exists",
    "已有未结束 Cycle 时 service 必须拒绝再开一轮",
  );

  // revision 乐观：回退 revision 拒绝，前进允许。
  await service.saveProgram({ ...program, goal: "v2", revision: 2, updatedAt: now + 1 });
  await assert.rejects(
    () => service.saveProgram({ ...program, goal: "stale", revision: 1, updatedAt: now + 2 }),
    (error: unknown) => (error as { kind?: string }).kind === "revision_conflict",
  );
  assert.equal((await service.getProgram(program.id))?.goal, "v2");

  // usage 账本：reservation 落库、按 requestKey 结算。
  const requestKey = "req-1";
  await service.recordUsage({
    id: "usage-1",
    cycleId: cycle.id,
    requestKey,
    state: "reserved",
    provider: "fixture",
    model: "m1",
    pricingVersion: "v1",
    reservedCostMicros: 1_000,
    reservedTokens: 500,
    occurredAt: now,
    updatedAt: now,
  });
  await service.settleUsage({
    requestKey,
    actualTokens: 420,
    estimatedCostMicros: 840,
    usage: { input: 400, output: 20 },
    updatedAt: now + 5,
  });
  const facts = openFactConnection(path);
  const usageRow = facts
    .prepare(
      "SELECT state, actual_tokens, estimated_cost_micros, usage_json FROM continuous_usage WHERE request_key = ?",
    )
    .get(requestKey) as {
    state: string;
    actual_tokens: number;
    estimated_cost_micros: number;
    usage_json: string;
  };
  assert.equal(usageRow.state, "settled");
  assert.equal(usageRow.actual_tokens, 420);
  assert.equal(usageRow.estimated_cost_micros, 840);
  assert.deepEqual(JSON.parse(usageRow.usage_json), { input: 400, output: 20 });
  facts.close();
  repo.close({ throwOnError: true });
});
