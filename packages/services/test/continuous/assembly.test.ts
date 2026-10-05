// CT-12 Host 装配测试：assembleContinuousHost + wire 执行端口 + CLI→Host 请求处理的真实
// 接合（真实 SQLite tasks-index；transport/CLI 对端用进程内替身，但登记/执行/账本/挂起/
// 恢复全部走真实 schema 与真实服务栈）。用例对应 ticket CT-12 验收：
//   - 启动顺序（登记先于 submitOnce；leaseEpoch/并发上限/价格快照随载荷校验）；
//   - 重发同触发键不新建 Cycle/Run；
//   - 旧 CLI（capabilityUnsupported）/能力协商缺 interrupt → 不给自主实施；
//   - CLI→Host 预算预留拒绝 + 拒绝通知（suspended + pending 确认）+ 继续授权后
//     resumeSuspended（先重建登记）；
//   - 退出 interrupt 与重启同轮恢复（登记从持久化快照重建）；
//   - 旧 epoch 副作用拒绝（lease_lost）。
// 运行入口：node scripts/test-continuous.mjs --suite integration。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  supportsContinuousCliManagedOperations,
  type ContinuousRegisterManagedRunCommand,
} from "@zcode/shared/continuous-protocol";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
} from "@zcode/shared/continuous-protocol";
import { uiUxV1Template } from "@zcode/shared/continuous-templates";
import { assembleContinuousHost } from "../../src/continuous/adapters/hostAssembly.js";
import type { ContinuousAgentTransport } from "../../src/continuous/application/agentTransport.js";
import type { WorkspacePreparationPort } from "../../src/continuous/application/ports.js";
import type { Program } from "../../src/continuous/domain/types.js";

const TEMPLATE = uiUxV1Template();
const PRICING = {
  pricingVersion: "test-prices-v1",
  prices: [
    {
      providerId: "fixture",
      modelId: "fixture-model",
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 2,
    },
  ],
};
const CAPS = { inputTokenCap: 1_000, outputTokenCap: 1_000 };

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct12-assembly-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

function newDatabasePath(): string {
  dbCounter += 1;
  return join(tmpRoot, `tasks-index-${dbCounter}.sqlite`);
}

/** 真实迁移后的 tasks-index（旧库行为一致：既有表 + additive continuous 表）。 */
function migratedDatabasePath(): string {
  const path = newDatabasePath();
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  return path;
}

const fakeWorkspace: WorkspacePreparationPort = {
  prepare: async (request) => ({
    executionPath: join(tmpRoot, "worktrees", request.programId),
    branchName: request.branchName,
    baseCommit: "f".repeat(40),
  }),
  release: async () => {},
  createCandidateCheckpoint: async () => {
    throw new Error("assembly.test 不驱动候选检查点");
  },
  restoreCandidateFiles: async () => [],
};

/** 进程内 CLI 对端替身：记录命令序列并按脚本应答。 */
interface ScriptedPeer {
  commands: Array<{ type: string; payload: unknown }>;
  sessions: string[];
  /** 旧 CLI：登记命令回能力不支持。 */
  oldCli: boolean;
  /** 能力协商回音裁剪（缺 interrupt 等）。 */
  echoOperations: string[] | null;
  /** 指定 op 的拒绝（reasonCode）。 */
  rejectOps: Map<string, string>;
  /** run 状态（inspect 应答）。 */
  runStatus: "running" | "stopped" | "errored" | "completed";
}

function makeTransport(peer: ScriptedPeer): ContinuousAgentTransport {
  const fullOps = [
    "register",
    "submitOnce",
    "inspect",
    "resume",
    "stop",
    "interrupt",
    "waitForQuiescence",
    "readReports",
    "suspendAtSafeBoundary",
    "resumeSuspended",
    "inspectHealth",
  ];
  return {
    ensureExecutionSession: async (input) => {
      if (!peer.sessions.includes(input.executionSessionId)) {
        peer.sessions.push(input.executionSessionId);
      }
    },
    sendCommand: async ({ type, payload }) => {
      peer.commands.push({ type, payload });
      if (type === "continuousRegisterManagedRun") {
        if (peer.oldCli) {
          return { status: "rejected", reasonCode: "fault.command.capabilityUnsupported" };
        }
        const registration = payload as ContinuousRegisterManagedRunCommand;
        return {
          status: "accepted",
          result: {
            type: "continuousRegisterManagedRun",
            operations: peer.echoOperations ?? fullOps,
            workflowRunId: registration.workflowRunId,
          },
        };
      }
      if (type === "continuousManagedCycle") {
        const command = payload as { op: string };
        const reject = peer.rejectOps.get(command.op);
        if (reject) {
          return {
            status: "rejected",
            reasonCode: `fault.command.continuousManagedCycleRejected.${reject}`,
          };
        }
        if (command.op === "submitOnce") {
          const input = (
            payload as {
              input: {
                cycleId: string;
                executionSessionId: string;
                workflowRunId: string;
                traceId: string;
              };
            }
          ).input;
          return {
            status: "accepted",
            result: {
              type: "continuousManagedCycle",
              op: "submitOnce",
              reference: {
                cycleId: input.cycleId,
                executionSessionId: input.executionSessionId,
                workflowRunId: input.workflowRunId,
                traceId: input.traceId,
              },
            },
          };
        }
        if (command.op === "inspect") {
          return {
            status: "accepted",
            result: {
              type: "continuousManagedCycle",
              op: "inspect",
              state: {
                runId: "run",
                status: peer.runStatus,
                resumable: peer.runStatus === "stopped",
              },
            },
          };
        }
        if (command.op === "readReports") {
          return {
            status: "accepted",
            result: {
              type: "continuousManagedCycle",
              op: "readReports",
              batch: { items: [], nextCursor: 0 },
            },
          };
        }
        return { status: "accepted", result: { type: "continuousManagedCycle", op: command.op } };
      }
      return { status: "rejected", reasonCode: "unknown command" };
    },
  };
}

function makePeer(overrides: Partial<ScriptedPeer> = {}): ScriptedPeer {
  return {
    commands: [],
    sessions: [],
    oldCli: false,
    echoOperations: null,
    rejectOps: new Map(),
    runStatus: "running",
    ...overrides,
  };
}

async function assembleFixture(overrides: { peer?: ScriptedPeer; databasePath?: string } = {}) {
  const peer = overrides.peer ?? makePeer();
  const databasePath = overrides.databasePath ?? migratedDatabasePath();
  let now = 1_000_000;
  const host = await assembleContinuousHost({
    databasePath,
    clock: { now: () => now, timeZone: () => "Asia/Shanghai" },
    transport: makeTransport(peer),
    pricing: () => PRICING,
    requestCaps: () => CAPS,
    workspace: fakeWorkspace,
    pollIntervalMs: 5,
  });
  return {
    host,
    peer,
    /** 让监督循环观察到终态并收尾（dispose 前调用，避免悬挂轮询拍已关闭的连接）。 */
    settle: async () => {
      peer.runStatus = "completed";
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
    advance: (ms: number) => {
      now += ms;
    },
    makeProgram: (programOverrides: Partial<Program> = {}): Program => ({
      id: nextId("program"),
      workspaceKey: "/repos/app",
      workspacePath: "/repos/app",
      revision: 1,
      goal: "持续改进桌面 UI",
      timeZone: "Asia/Shanghai",
      scope: {
        allowedPaths: ["src"],
        forbiddenPaths: [],
        forbiddenCapabilities: ["push", "merge"],
      },
      budget: { ...CONTINUOUS_DEFAULT_BUDGET },
      cadence: CONTINUOUS_DEFAULT_CADENCE,
      decisionPolicy: { unknownToDecision: true },
      authorization: {
        revision: 1,
        templateHash: TEMPLATE.scriptHash,
        grantedAt: "2026-10-05T00:00:00Z",
      },
      templateId: TEMPLATE.templateId,
      templateVersion: TEMPLATE.templateVersion,
      templateHash: TEMPLATE.scriptHash,
      status: "active",
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
      ...programOverrides,
    }),
  };
}

test("CT-12：runNow 先登记再 submitOnce；冻结配置/价格/上限/执行权随载荷下发；同触发键不新建", async () => {
  const fixture = await assembleFixture();
  const program = fixture.makeProgram();
  await fixture.host.repository.insertProgram(program);
  const cycle = await fixture.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t-1",
    },
    programId: program.id,
    requestId: "req-1",
  });
  const types = fixture.peer.commands.map((command) => command.type);
  const firstRegister = types.indexOf("continuousRegisterManagedRun");
  const firstSubmit = fixture.peer.commands.findIndex(
    (command) =>
      command.type === "continuousManagedCycle" &&
      (command.payload as { op?: string }).op === "submitOnce",
  );
  assert.ok(
    firstRegister >= 0 && firstSubmit > firstRegister,
    "登记必须先于 submitOnce（启动顺序：保存执行身份→执行权→登记→submitOnce）",
  );
  const registration = fixture.peer.commands[firstRegister]!
    .payload as ContinuousRegisterManagedRunCommand;
  assert.equal(registration.workflowRunId, cycle.workflowRunId);
  assert.ok(registration.leaseEpoch >= 1, "执行权版本（leaseEpoch）随登记下发");
  assert.equal(
    registration.maxConcurrentActors,
    program.budget.maxConcurrentActors,
    "并发上限来自冻结配置（10），不退回 CPU 默认",
  );
  assert.equal(registration.pricing.pricingVersion, PRICING.pricingVersion);
  assert.equal(registration.requestCaps.inputTokenCap, CAPS.inputTokenCap);
  assert.equal(registration.executionPath, join(tmpRoot, "worktrees", program.id));
  assert.equal(registration.scope.allowedPaths[0], "src");
  // 重发同触发键：同 Cycle/Run，不新建。
  const replay = await fixture.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t-2",
    },
    programId: program.id,
    requestId: "req-1",
  });
  assert.equal(replay.id, cycle.id);
  assert.equal(replay.workflowRunId, cycle.workflowRunId);
  const cycles = await fixture.host.repository.listRecentCycles(program.id, 10);
  assert.equal(cycles.length, 1, "同触发键只落一条 Cycle");
  assert.equal(fixture.peer.sessions.length, 1, "只有一个执行会话");
  await fixture.settle();
  fixture.host.dispose();
});

test("CT-12：旧 CLI（capabilityUnsupported）与能力协商缺 interrupt 均不给自主实施", async () => {
  const oldCliFixture = await assembleFixture({ peer: makePeer({ oldCli: true }) });
  const program = oldCliFixture.makeProgram();
  await oldCliFixture.host.repository.insertProgram(program);
  await assert.rejects(
    oldCliFixture.host.commandService.runNow({
      context: {
        workspacePath: program.workspacePath,
        workspaceKey: program.workspaceKey,
        traceId: "t",
      },
      programId: program.id,
      requestId: "req-old",
    }),
    (error: unknown) => {
      const code =
        (error as { code?: string }).code ?? (error as { error?: { code?: string } }).error?.code;
      assert.equal(code, "capability_missing", "旧 CLI 结构化拒绝，不退回普通执行");
      return true;
    },
  );
  // 旧 CLI 拒绝后 Cycle 留在 preparing——恢复流程按原身份重试（R-01 语义），无第二 Cycle。
  const open = await oldCliFixture.host.repository.getOpenCycle(program.id);
  assert.ok(open);
  await oldCliFixture.settle();
  oldCliFixture.host.dispose();

  const staleFixture = await assembleFixture({
    peer: makePeer({ echoOperations: ["register", "submitOnce"] }),
  });
  const program2 = staleFixture.makeProgram();
  await staleFixture.host.repository.insertProgram(program2);
  await assert.rejects(
    staleFixture.host.commandService.runNow({
      context: {
        workspacePath: program2.workspacePath,
        workspaceKey: program2.workspaceKey,
        traceId: "t",
      },
      programId: program2.id,
      requestId: "req-stale",
    }),
    (error: unknown) => {
      const code3 =
        (error as { code?: string }).code ?? (error as { error?: { code?: string } }).error?.code;
      assert.equal(code3, "capability_missing", "缺 interrupt 的能力协商不给自主实施");
      return true;
    },
  );
  await staleFixture.settle();
  staleFixture.host.dispose();
});

test("CT-12：预算预留拒绝→拒绝通知保存同轮暂停与继续确认→授权后先重建登记再 resumeSuspended", async () => {
  const fixture = await assembleFixture();
  const program = fixture.makeProgram({
    budget: { ...CONTINUOUS_DEFAULT_BUDGET, perCycleCostUsdMicros: 100 },
  });
  await fixture.host.repository.insertProgram(program);
  const cycle = await fixture.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t",
    },
    programId: program.id,
    requestId: "req-budget",
  });
  // CLI→Host 预留：超额 → 结构化拒绝（limitKind + 观测）。
  const denied = await fixture.host.handleAgentRequest(
    CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
    {
      programId: program.id,
      cycleId: cycle.id,
      workflowRunId: cycle.workflowRunId,
      requestKey: "rk-1",
      provider: "fixture",
      model: "fixture-model",
      pricingVersion: PRICING.pricingVersion,
      reservedCostMicros: 10_000_000,
      reservedTokens: 2_000,
    },
  );
  assert.ok(denied.handled);
  const denialResult = (
    denied as { result?: { ok: boolean; code?: string; denial?: { limitKind: string } } }
  ).result;
  assert.ok(denialResult && denialResult.ok === false);
  assert.equal(denialResult.code, "budget_denied");
  assert.equal(denialResult.denial?.limitKind, "cycle_cost");
  // CLI→Host 拒绝通知：Host 先 suspendAtSafeBoundary（wire 命令）再落库 suspended+确认。
  fixture.peer.commands.length = 0;
  const suspension = await fixture.host.handleAgentRequest(
    CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
    {
      programId: program.id,
      cycleId: cycle.id,
      workflowRunId: cycle.workflowRunId,
      code: "budget_denied",
      message: "cycle cost limit reached",
    },
  );
  assert.ok(suspension.handled);
  const suspendCommands = fixture.peer.commands.map(
    (c) => `${c.type}:${(c.payload as { op?: string }).op ?? ""}`,
  );
  assert.ok(
    suspendCommands.includes("continuousManagedCycle:suspendAtSafeBoundary"),
    "拒绝通知先冻结执行侧准许（wire suspendAtSafeBoundary）",
  );
  const suspended = await fixture.host.repository.getCycle(cycle.id);
  assert.equal(suspended?.status, "suspended");
  const continuation = await fixture.host.repository.getPendingContinuationRequest(cycle.id);
  assert.ok(continuation, "同轮唯一 pending 继续确认已保存");
  const pausedProgram = await fixture.host.repository.getProgram(program.id);
  assert.equal(pausedProgram?.status, "paused");
  // 用户授权继续：resumeSuspended 前先重建登记（恢复链）。
  fixture.peer.commands.length = 0;
  await fixture.host.commandService.resolveContinuation({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t",
    },
    programId: program.id,
    requestId: continuation!.id,
    version: continuation!.version,
    answer: { kind: "continue_with_grant", grant: { costMicros: 100 } },
  });
  const flow = fixture.peer.commands.map(
    (c) => `${c.type}:${(c.payload as { op?: string }).op ?? ""}`,
  );
  const registerIndex = flow.indexOf("continuousRegisterManagedRun:");
  const resumeIndex = flow.indexOf("continuousManagedCycle:resumeSuspended");
  assert.ok(registerIndex >= 0 && resumeIndex > registerIndex, "继续授权后先重建登记再解冻");
  await fixture.settle();
  fixture.host.dispose();
});

test("CT-12：退出 interrupt 保存 interrupted；重启后从持久化快照重建登记并同轮恢复", async () => {
  const databasePath = migratedDatabasePath();
  const first = await assembleFixture({ databasePath });
  const program = first.makeProgram();
  await first.host.repository.insertProgram(program);
  const cycle = await first.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t",
    },
    programId: program.id,
    requestId: "req-exit",
  });
  first.peer.commands.length = 0;
  // 停止新 wake：stopped 后 handleWake 如实抛错（main 回执失败，scheduler 重发）。
  first.host.stop();
  await assert.rejects(() => first.host.handleWake(program.id));
  const interrupted = await first.host.interruptForShutdown(program.workspaceKey);
  assert.deepEqual(interrupted, [cycle.id]);
  const savedCycle = await first.host.repository.getCycle(cycle.id);
  assert.equal(savedCycle?.status, "interrupted");
  const exitFlow = first.peer.commands.map(
    (c) => `${c.type}:${(c.payload as { op?: string }).op ?? ""}`,
  );
  assert.ok(
    exitFlow.includes("continuousManagedCycle:interrupt"),
    "退出经 interrupt（取消原因 interrupted）",
  );
  first.host.dispose();
  // 重启：同库新装配（同 Run 恢复）；恢复前从持久化快照重建登记。
  const second = await assembleFixture({ databasePath });
  second.peer.runStatus = "stopped";
  const report = await second.host.recovery.recoverWorkspace(program.workspaceKey);
  assert.equal(report.workspaceKey, program.workspaceKey);
  const registerCommands = second.peer.commands.filter(
    (c) => c.type === "continuousRegisterManagedRun",
  );
  assert.ok(registerCommands.length >= 1, "恢复前重建登记（快照来源：Cycle/Program 持久化行）");
  const rebuilt = registerCommands[0]!.payload as ContinuousRegisterManagedRunCommand;
  assert.equal(rebuilt.workflowRunId, cycle.workflowRunId, "同 Run 恢复，不铸第二个执行");
  assert.equal(rebuilt.cycleId, cycle.id, "同 Cycle 恢复（执行身份来自持久化行）");
  assert.equal(
    rebuilt.executionPath,
    join(tmpRoot, "worktrees", program.id),
    "真实工作目录从快照重建",
  );
  await second.settle();
  second.host.dispose();
});

test("CT-12：旧 epoch 副作用拒绝（lease_lost 上送）", async () => {
  const fixture = await assembleFixture({
    peer: makePeer({ rejectOps: new Map([["resumeSuspended", "lease_lost"]]) }),
  });
  const program = fixture.makeProgram();
  await fixture.host.repository.insertProgram(program);
  const cycle = await fixture.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t",
    },
    programId: program.id,
    requestId: "req-epoch",
  });
  // 直接对 wire 执行端口演练旧 epoch 拒绝的上送路径（supervisor 错码透传）。
  // 前置：挂起状态（继续链只对 suspended 轮生效）。
  await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension, {
    programId: program.id,
    cycleId: cycle.id,
    workflowRunId: cycle.workflowRunId,
    code: "budget_denied",
    message: "seed suspension for epoch test",
  });
  const seeded = await fixture.host.repository.getPendingContinuationRequest(cycle.id);
  assert.ok(seeded, "挂起种子已创建同轮 pending 确认");
  await assert.rejects(
    fixture.host.commandService.resolveContinuation({
      context: {
        workspacePath: program.workspacePath,
        workspaceKey: program.workspaceKey,
        traceId: "t",
      },
      programId: program.id,
      requestId: seeded!.id,
      version: seeded!.version,
      answer: { kind: "continue_with_grant", grant: { costMicros: 1 } },
    }),
    (error: unknown) => {
      const code =
        (error as { code?: string }).code ?? (error as { error?: { code?: string } }).error?.code;
      assert.equal(code, "lease_lost", "旧 epoch 的副作用被结构化拒绝");
      return true;
    },
  );
  await fixture.settle();
  fixture.host.dispose();
});

test("CT-12：能力词表核对（含 interrupt）是单一实现", () => {
  assert.ok(
    supportsContinuousCliManagedOperations([
      "register",
      "interrupt",
      "submitOnce",
      "inspect",
      "resume",
      "stop",
      "waitForQuiescence",
      "readReports",
      "suspendAtSafeBoundary",
      "resumeSuspended",
      "inspectHealth",
    ]),
  );
  assert.equal(
    supportsContinuousCliManagedOperations(["register", "submitOnce"]),
    false,
    "缺 interrupt 的词表不通过",
  );
});

test("CT-12：决策请求先持久化 Decision（归属校验拒绝跨 Program 串任务）", async () => {
  const fixture = await assembleFixture();
  const program = fixture.makeProgram();
  await fixture.host.repository.insertProgram(program);
  const cycle = await fixture.host.commandService.runNow({
    context: {
      workspacePath: program.workspacePath,
      workspaceKey: program.workspaceKey,
      traceId: "t",
    },
    programId: program.id,
    requestId: "req-decision",
  });
  const fingerprint = createHash("sha256").update("continuous-decision:q").digest("hex");
  const stored = await fixture.host.handleAgentRequest(
    CONTINUOUS_AGENT_REQUEST_METHODS.decisionEscalation,
    {
      programId: program.id,
      cycleId: cycle.id,
      workflowRunId: cycle.workflowRunId,
      fingerprint,
      title: "Settings navigation 需要决策",
      context: "导航架构变更",
      options: [{ id: "approve", label: "放行", consequences: "后续轮实施" }],
      classification: "blocking",
      blockingScope: { candidateIds: [], paths: [] },
    },
  );
  assert.ok(stored.handled);
  const decision = (stored as { result?: { decisionId: string; merged: boolean } }).result;
  assert.ok(decision?.decisionId);
  const pending = await fixture.host.repository.listPendingDecisions(program.id);
  assert.equal(pending.length, 1);
  // 归属校验：伪造的跨 Program 请求被拒。
  const crossProgram = await fixture.host.handleAgentRequest(
    CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
    {
      programId: "program-other",
      cycleId: cycle.id,
      workflowRunId: cycle.workflowRunId,
      requestKey: "rk-x",
      provider: "fixture",
      model: "fixture-model",
      pricingVersion: PRICING.pricingVersion,
      reservedCostMicros: 1,
      reservedTokens: 1,
    },
  );
  assert.ok(crossProgram.handled && "error" in crossProgram, "跨 Program 请求按校验失败拒绝");
  await fixture.settle();
  fixture.host.dispose();
});
