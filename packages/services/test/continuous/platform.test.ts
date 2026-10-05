// CT-10 平台实测（services 侧）：E-25（跨平台路径与取消）在当前真实机器上的存储/工作区
// 面 + §13 平台启动门（observe_only 拒绝自主实施、停止链不受影响）。
// 用例定义见 docs/testing/continuous.md §8；与 bootstrap 侧 platform-runtime.test.ts 分工：
// 这边覆盖 worktree（真实 Git）、SQL 约束（真实 SQLite，路径含空格/Unicode）、租约 epoch
// 跨重开单调与 supervisor 平台门。证据 JSON 写到 os.tmpdir 并打印路径（CT-10 记录引用）。
// 运行入口：node scripts/test-continuous.mjs --suite platform（tsx + node:test）。

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import { createWorkspacePreparation } from "../../src/continuous/adapters/workspacePreparation.js";
import { ContinuousSupervisor } from "../../src/continuous/application/supervisor.js";
import type { ContinuousTemplateSource } from "../../src/continuous/application/supervisor.js";
import { ContinuousSupervisorError } from "../../src/continuous/application/supervisorLifecycle.js";
import {
  acquireCycleLease,
  releaseCycleLease,
} from "../../src/continuous/application/workspaceLease.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
import type {
  ContinuousExecutionPort,
  ExecutionReference,
  ExecutionState,
  HealthSnapshot,
  ManagedCycleInput,
  WorkspacePreparationPort,
} from "../../src/continuous/application/ports.js";

const execFileAsync = promisify(execFile);
// 根目录路径本身含空格/Unicode/大小写混合——被测事实（E-25）。
const tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), "continuous-ct10 Storage 🚀-"));
const evidence: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  tmpRoot,
};

const TEMPLATE_TEXT = "phase('观察');\nreturn {};\n";
const TEMPLATE_HASH = createHash("sha256").update(TEMPLATE_TEXT, "utf8").digest("hex");
const templateSource: ContinuousTemplateSource = {
  resolve: () => ({ scriptText: TEMPLATE_TEXT, scriptHash: TEMPLATE_HASH }),
};
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;
const fixedNow = 1_750_000_000_000;
const clock = { now: () => fixedNow };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

after(() => {
  const file = join(tmpRoot, "evidence.json");
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[platform-storage] evidence: ${file}`);
});

/** 真实迁移建库；db 文件路径含空格/Unicode（真实 SQLite 文件事实，非内存替身）。 */
async function freshRepository(
  label: string,
): Promise<{ repository: SqliteContinuousRepository; dbPath: string }> {
  dbCounter += 1;
  const dbPath = join(tmpRoot, `数据 库-${label}-${dbCounter}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  const repository = new SqliteContinuousRepository(dbPath, 30_000);
  await repository.ensureReady();
  return { repository, dbPath };
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
    nextCycleAt: fixedNow,
    consecutiveFailures: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
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

async function initOriginRepo(name: string): Promise<string> {
  const repoDir = join(tmpRoot, name);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "app.tsx"), "export const a = 1;\n");
  await git(repoDir, "init", "--initial-branch=main");
  await git(repoDir, "config", "user.email", "continuous@example.test");
  await git(repoDir, "config", "user.name", "Continuous Test");
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-m", "init");
  return repoDir;
}

// ── E-25: worktree（真实 Git + 含空格/Unicode 路径）────────────────

test("E-25: worktree——仓库与 worktree 根都在含空格/Unicode 的真实路径上创建/复用", async () => {
  const repoDir = await initOriginRepo("Origin 仓库 PRJ");
  const worktreesRoot = join(tmpRoot, "worktrees 根目录");
  const adapter = createWorkspacePreparation({ worktreeRootDir: worktreesRoot, clock });
  const head = (await git(repoDir, "rev-parse", "HEAD")).trim();

  const first = await adapter.prepare({
    programId: "prog-ct10",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-ct10",
  });
  assert.ok(existsSync(join(first.executionPath, "src", "app.tsx")), "worktree 内容为 HEAD 版本");
  assert.equal(first.baseCommit, head);
  assert.ok(
    first.executionPath.startsWith(worktreesRoot),
    "executionPath 落在受管 worktree 根内（空格/Unicode 不影响归属判定）",
  );

  const second = await adapter.prepare({
    programId: "prog-ct10",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-ct10",
  });
  assert.equal(second.executionPath, first.executionPath, "幂等 prepare 复用同一 worktree");
  evidence.worktree = {
    repoDir,
    worktreesRoot,
    executionPath: first.executionPath,
    branch: first.branchName,
    baseCommit: first.baseCommit,
  };
});

// ── E-25: SQL（真实 SQLite 文件 + 约束在真实 FS 上成立）────────────

test("E-25: SQL——含空格/Unicode 的 db 路径上 FK/唯一约束/租约 epoch 真实成立且重开可读", async () => {
  const { repository, dbPath } = await freshRepository("constraints");
  const program = makeProgram({
    workspaceKey: "/repos/仓库 with spaces",
    workspacePath: "/repos/仓库 with spaces",
  });
  await repository.insertProgram(program);
  const cycle = makeCycle(program, "manual:req-1");
  await repository.insertCycle(cycle);
  assert.ok((await repository.getOpenCycle(program.id))?.id === cycle.id);

  // 跨 Program 复合 FK：另一 Program 的 candidate 引用本 Cycle 必须被数据库拒绝。
  const otherProgram = makeProgram();
  await repository.insertProgram(otherProgram);
  const fact = new DatabaseSync(dbPath);
  fact.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () =>
      fact
        .prepare(
          "INSERT INTO continuous_candidate (id, program_id, source_cycle_id, fingerprint, status, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          nextId("cand"),
          otherProgram.id,
          cycle.id,
          "fp-x",
          "candidate",
          "{}",
          fixedNow,
          fixedNow,
        ),
    (error: unknown) => ((error as { errcode?: number }).errcode! & 0xff) === 19,
    "复合 FK(program_id,cycle_id) 必须拒绝跨 Program 引用",
  );

  // 一个 Program 一条未结束 Cycle：同库第二连接并发插入撞部分唯一索引（不靠内存锁）。
  const secondConnection = new DatabaseSync(dbPath);
  secondConnection.exec("PRAGMA busy_timeout = 5000");
  assert.throws(
    () =>
      secondConnection
        .prepare(
          "INSERT INTO continuous_cycle (id, program_id, sequence, trigger_key, status, execution_session_id, workflow_run_id, trace_id, script_text, script_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          nextId("cycle"),
          program.id,
          2,
          "manual:req-2",
          "preparing",
          "s2",
          "r2",
          "t2",
          TEMPLATE_TEXT,
          TEMPLATE_HASH,
          fixedNow,
          fixedNow,
        ),
    (error: unknown) => ((error as { errcode?: number }).errcode! & 0xff) === 19,
    "部分唯一索引必须吸收同 Program 第二条未结束 Cycle",
  );

  // 租约 epoch：取得 → 正常释放（三者同空 epoch 保留）→ 重开新库连接再取得 epoch+1。
  const execution = new RecordingExecutionPort();
  const leaseDeps = { repository, execution, clock };
  const lease1 = await acquireCycleLease(leaseDeps, {
    workspaceKey: program.workspaceKey,
    cycleId: cycle.id,
    ownerId: "owner-a",
  });
  assert.equal(lease1.status, "acquired");
  await releaseCycleLease(leaseDeps, {
    workspaceKey: program.workspaceKey,
    ownerId: "owner-a",
    epoch: lease1.epoch,
  });
  const reopened = new SqliteContinuousRepository(dbPath, 30_000);
  await reopened.ensureReady();
  const lease2 = await acquireCycleLease(
    { repository: reopened, execution, clock },
    { workspaceKey: program.workspaceKey, cycleId: cycle.id, ownerId: "owner-b" },
  );
  assert.equal(lease2.status, "acquired");
  assert.ok(lease2.epoch > lease1.epoch, "重开后新取得租约 epoch 必须大于上次（单调）");
  const readBack = await reopened.getProgram(program.id);
  assert.equal(readBack?.workspaceKey, program.workspaceKey, "重开后 Program 可读且身份一致");
  fact.close();
  secondConnection.close();
  evidence.sql = {
    dbPath,
    crossProgramFkRejected: true,
    oneOpenCycleEnforced: true,
    leaseEpoch: { first: lease1.epoch, reopened: lease2.epoch },
  };
});

// ── §13/E-24: supervisor 启动门（observe_only）────────────────────

class RecordingExecutionPort implements ContinuousExecutionPort {
  submitted: ManagedCycleInput[] = [];
  calls: string[] = [];
  submitOnce(input: ManagedCycleInput): Promise<ExecutionReference> {
    this.submitted.push(input);
    this.calls.push("submitOnce");
    return Promise.resolve({
      cycleId: input.cycleId,
      executionSessionId: input.executionSessionId,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId,
    });
  }
  inspect(): Promise<ExecutionState> {
    return Promise.resolve({ runId: "", status: "running", resumable: false });
  }
  inspectHealth(): Promise<HealthSnapshot> {
    return Promise.resolve({ runId: "", actorIds: [], ownerEpoch: 0, reachable: true });
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
  readReports(): Promise<{ items: []; nextCursor: number }> {
    return Promise.resolve({ items: [], nextCursor: 0 });
  }
  suspendAtSafeBoundary(): Promise<void> {
    this.calls.push("suspendAtSafeBoundary");
    return Promise.resolve();
  }
  resumeSuspended(): Promise<void> {
    this.calls.push("resumeSuspended");
    return Promise.resolve();
  }
}

/** 记录型 workspace：observe_only 拒绝必须发生在任何文件操作之前（无副作用，E-24）。 */
class RecordingWorkspace implements WorkspacePreparationPort {
  calls: string[] = [];
  async prepare(): Promise<{ executionPath: string; branchName: string; baseCommit: string }> {
    this.calls.push("prepare");
    return { executionPath: "/wt/x", branchName: "codex/continuous-x", baseCommit: "a".repeat(40) };
  }
  async release(): Promise<void> {
    this.calls.push("release");
  }
  async createCandidateCheckpoint(): Promise<{ createdAt: number }> {
    this.calls.push("createCandidateCheckpoint");
    return { createdAt: 1 };
  }
  async restoreCandidateFiles(): Promise<{ path: string; action: string }[]> {
    this.calls.push("restoreCandidateFiles");
    return [];
  }
}

test("§13/E-24: observe_only 平台——runNow 结构化拒绝且零执行/文件副作用；停止链不受平台门影响", async () => {
  const { repository } = await freshRepository("platform-gate");
  const program = makeProgram();
  await repository.insertProgram(program);
  const execution = new RecordingExecutionPort();
  const workspace = new RecordingWorkspace();
  const supervisor = new ContinuousSupervisor({
    repository,
    execution,
    workspace,
    clock,
    templateSource,
    platformExecutionMode: "observe_only",
    pollIntervalMs: 1,
  });

  await assert.rejects(
    supervisor.runNow({ programId: program.id, requestId: "req-observe" }),
    (error: unknown) =>
      error instanceof ContinuousSupervisorError &&
      error.code === "platform_execution_not_supported",
    "observe_only 平台启动自主实施必须结构化拒绝",
  );
  assert.deepEqual(execution.calls, [], "拒绝必须先于任何提交（无 Run）");
  assert.deepEqual(workspace.calls, [], "拒绝必须先于任何 workspace 操作（无文件副作用）");
  assert.equal((await repository.getOpenCycle(program.id)) ?? null, null, "不创建 Cycle");

  // 停止链不设平台门：没有未结束 Cycle 时按既有业务语义拒绝（program_not_runnable），
  // 绝不是 platform_execution_not_supported——任何平台都必须能停止在飞执行（E-27 回滚依赖）。
  await assert.rejects(
    supervisor.stopCurrentCycle({ programId: program.id, epoch: 0 }),
    (error: unknown) =>
      error instanceof ContinuousSupervisorError && error.code === "program_not_runnable",
    "停止链不因 observe_only 被平台门封死",
  );
  evidence.platformGate = {
    runNowRejected: "platform_execution_not_supported",
    executionCalls: execution.calls,
    workspaceCalls: workspace.calls,
    stopNotPlatformGated: true,
  };
});
