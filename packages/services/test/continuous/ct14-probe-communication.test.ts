// CT-14 完整主动探活和正常阻塞——Host 侧回归：
//   - 读取执行快照与报告有可诊断的通信期限：inspect/inspectHealth/readReports 超时/
//     传输失败按 execution_unreachable 上送（含期限事实），不让监督循环永远卡在一次 RPC；
//   - 失联（探活 RPC 失败/unreachable 分类）冻结新操作：不发 wire 挂起（同一断链上只会
//     同样卡住），保存 interrupted 与证据事件、Program paused，由恢复核对；
//   - 监督循环对 readReports/inspect 的失联错误退出并保存 interrupted，而不是把异常
//     抛给上层后丢下无人监督的 running 轮；
//   - 两小时登记等待跨一小时墙钟仍继续（normal_wait 不触发时间上限），等待失效后重新计时。
// 规则来源：docs/tickets/continuous-release-gaps.md CT-14、docs/specs/continuous.md §10.1、
// 「2026-10-05：发布文档 §2.1 修复边界」。运行入口：node scripts/test-continuous.mjs --suite
// integration（tsx + node:test，真实 SQLite 持久化 Cycle/Program/事件）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import { createWireContinuousExecutionPort } from "../../src/continuous/adapters/wireExecutionPort.js";
import { ContinuousSupervisorError } from "../../src/continuous/application/supervisorLifecycle.js";
import {
  ContinuousHealthMonitor,
  type HealthAssessment,
} from "../../src/continuous/application/healthMonitor.js";
import {
  applyHealthAssessment,
  freezeCycleForUnreachableExecution,
} from "../../src/continuous/application/supervisorHealth.js";
import { watchCycle } from "../../src/continuous/application/supervisorWatch.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
import type { ContinuousAgentTransport } from "../../src/continuous/application/agentTransport.js";
import type {
  ContinuousExecutionPort,
  ExecutionReference,
  HealthSnapshot,
} from "../../src/continuous/application/ports.js";

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

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct14-comm-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

interface Fixture {
  repo: SqliteContinuousRepository;
  ref: ExecutionReference;
  cycle: Cycle;
  program: Program;
  setNow: (at: number) => void;
  now: () => number;
  dispose: () => void;
}

async function makeFixture(): Promise<Fixture> {
  dbCounter += 1;
  const path = join(tmpRoot, `tasks-${dbCounter}.sqlite`);
  const db = new DatabaseSync(path);
  try {
    runTasksDatabaseMigrations(db);
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  let now = 10_000_000;
  const clock = () => now;
  const repo = new SqliteContinuousRepository(path);
  const program: Program = {
    id: nextId("program"),
    workspaceKey: "/repos/app",
    workspacePath: "/repos/app",
    revision: 1,
    goal: "持续改进桌面 UI",
    timeZone: "Asia/Shanghai",
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push"] },
    budget: { ...CONTINUOUS_DEFAULT_BUDGET },
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: { unknownToDecision: true },
    authorization: { revision: 1, templateHash: "a".repeat(64), grantedAt: "2026-10-05T00:00:00Z" },
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
    workflowRunId: "run-1",
    traceId: nextId("trace"),
    leaseEpoch: 1,
    resumeAttempts: 0,
    activeDurationMs: 0,
    normalBlockedDurationMs: 0,
    healthState: "progressing",
    reportCursor: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await repo.insertProgram(program);
  await repo.insertCycle(cycle);
  const ref: ExecutionReference = {
    cycleId: cycle.id,
    executionSessionId: cycle.executionSessionId,
    workflowRunId: cycle.workflowRunId,
    traceId: cycle.traceId,
  };
  return {
    repo,
    ref,
    cycle,
    program,
    setNow: (at: number) => {
      now = at;
    },
    now: clock,
    dispose: () => repo.close(),
  };
}

/** 永不回应的传输：模拟 stdio 卡死（监督循环不能永远挂在这类 RPC 上）。 */
const hangingTransport: ContinuousAgentTransport = {
  ensureExecutionSession: async () => {},
  sendCommand: () => new Promise(() => {}),
};

test(
  "CT-14 读取快照/报告有通信期限：超时按 execution_unreachable 可诊断上送",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await makeFixture();
    t.after(() => fixture.dispose());
    const port = createWireContinuousExecutionPort({
      transport: hangingTransport,
      repository: fixture.repo,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
      pricing: () => PRICING,
      requestCaps: () => CAPS,
      readDeadlineMs: 40,
    });
    for (const op of ["inspectHealth", "inspect", "readReports"] as const) {
      const startedAt = Date.now();
      await assert.rejects(
        op === "inspectHealth"
          ? port.inspectHealth(fixture.ref)
          : op === "inspect"
            ? port.inspect(fixture.ref)
            : port.readReports(fixture.ref, 0),
        (error: unknown) => {
          assert.ok(error instanceof ContinuousSupervisorError, `${op} 超时抛结构化错误`);
          assert.equal(error.code, "execution_unreachable", `${op} 超时码可诊断`);
          assert.match(error.message, /40ms/, `${op} 错误携带期限事实`);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 5_000, `${op} 在期限内返回，不永久等待`);
    }
  },
);

test("CT-14 读操作传输失败同样按 execution_unreachable 上送（不是笼统 not_quiescent）", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const transport: ContinuousAgentTransport = {
    ensureExecutionSession: async () => {},
    sendCommand: async () => {
      throw new Error("stdio closed");
    },
  };
  const port = createWireContinuousExecutionPort({
    transport,
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    pricing: () => PRICING,
    requestCaps: () => CAPS,
    readDeadlineMs: 1_000,
  });
  await assert.rejects(port.inspectHealth(fixture.ref), (error: unknown) => {
    assert.ok(error instanceof ContinuousSupervisorError);
    assert.equal(error.code, "execution_unreachable");
    return true;
  });
});

test("CT-14 探活 RPC 失败按 unreachable 处理：不计时不判 hang，冻结走落库链", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const wireSuspendCalls: string[] = [];
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: {
      inspectHealth: async () => {
        throw new ContinuousSupervisorError("execution_unreachable", "通信超时（40ms 期限）");
      },
    },
  });
  const first = await monitor.probeOnce(fixture.ref);
  assert.ok(first, "探活失败必须返回评估（不能抛给监督循环后丢下 running 轮）");
  assert.equal(first.classification, "unreachable", "RPC 失败 = 不可达，不冒充健康或等待");
  assert.equal(first.activeDeltaMs, 0);
  assert.equal(first.normalBlockedDeltaMs, 0);
  // 冻结：不发 wire 挂起（同一断链上只会同样卡住），直接落库 interrupted + 证据。
  const execution = {
    inspectHealth: async (): Promise<HealthSnapshot> => {
      throw new Error("unreachable path");
    },
    suspendAtSafeBoundary: async (_ref: unknown, reason: string) => {
      wireSuspendCalls.push(reason);
    },
  } as unknown as ContinuousExecutionPort;
  const second = await new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: { inspectHealth: execution.inspectHealth as never },
  }).probeOnce(fixture.ref);
  assert.equal(second?.classification, "unreachable");
  await applyHealthAssessment(
    {
      repository: fixture.repo,
      execution,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    },
    fixture.ref,
    fixture.program,
    second!,
  );
  assert.deepEqual(wireSuspendCalls, [], "unreachable 不发 wire 挂起（会卡在同一断链上）");
  const saved = await fixture.repo.getCycle(fixture.cycle.id);
  assert.equal(saved?.status, "interrupted", "保留 interrupted 交恢复核对");
  const program = await fixture.repo.getProgram(fixture.program.id);
  assert.equal(program?.status, "paused", "失联冻结新操作（Program paused）");
  const events = await fixture.repo.listCycleEvents(fixture.program.id, fixture.cycle.id);
  assert.ok(
    events.some((event) => event.type === "cycle.execution_unreachable"),
    "证据事件保留（诊断可核对）",
  );
});

test("CT-14 失联冻结不覆盖执行权已改变的轮（旧监督者不给新 epoch 落 interrupted）", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  // 接管发生：行上的 leaseEpoch 已前进到 2；旧监督者（expectedEpoch 1）的失联观察
  // 不能覆盖新执行权下的 running 轮。
  await fixture.repo.saveCycle({ ...fixture.cycle, leaseEpoch: 2, reportCursor: 77 });
  await freezeCycleForUnreachableExecution(
    {
      repository: fixture.repo,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    },
    fixture.ref,
    { reason: "执行进程不可达", expectedEpoch: 1 },
  );
  const saved = await fixture.repo.getCycle(fixture.cycle.id);
  assert.equal(saved?.status, "running", "执行权改变的轮不被旧观察覆盖");
  assert.equal(saved?.leaseEpoch, 2);
  assert.equal(saved?.reportCursor, 77, "报告游标不被触碰");
  assert.equal((await fixture.repo.getProgram(fixture.program.id))?.status, "active");
});

test("CT-14 监督循环读报告失联：退出循环并保存 interrupted/证据，不抛异常不空转", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const execution: ContinuousExecutionPort = {
    readReports: async () => {
      throw new ContinuousSupervisorError("execution_unreachable", "readReports 通信超时");
    },
    inspect: async () => ({ runId: "run-1", status: "running", resumable: false }),
    submitOnce: async () => {
      throw new Error("不应提交");
    },
    resume: async () => {},
    stop: async () => {},
    interrupt: async () => {},
    waitForQuiescence: async () => {},
    suspendAtSafeBoundary: async () => {},
    resumeSuspended: async () => {},
    inspectHealth: async () => {
      throw new Error("unreachable");
    },
  };
  const outcome = await watchCycle(
    {
      repository: fixture.repo,
      execution,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
      pollIntervalMs: 5,
    },
    { cycle: fixture.cycle, program: fixture.program, ownerId: "host-a" },
  );
  assert.equal(outcome.cycleStatus, "interrupted");
  const saved = await fixture.repo.getCycle(fixture.cycle.id);
  assert.equal(saved?.status, "interrupted");
  assert.equal((await fixture.repo.getProgram(fixture.program.id))?.status, "paused");
  const events = await fixture.repo.listCycleEvents(fixture.program.id, fixture.cycle.id);
  assert.ok(events.some((event) => event.type === "cycle.execution_unreachable"));
});

test("CT-14 两小时登记等待跨一小时墙钟仍继续；等待失效后重新计时", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const start = fixture.now();
  let snapshot: HealthSnapshot = {
    runId: "run-1",
    actorIds: ["actor-1"],
    ownerEpoch: 1,
    reachable: true,
    lastProgressAt: start,
    waitingFor: {
      ownerId: "run-1:test:cand:0",
      reason: "declared test",
      deadlineAt: start + 2 * 3_600_000,
    },
  };
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: { inspectHealth: async () => snapshot },
  });
  await monitor.probeOnce(fixture.ref);
  // 墙钟跨过一小时上限：全部节点处于已登记的两小时等待 → 继续，不弹时间额度问题。
  fixture.setNow(start + 61 * 60_000);
  let assessment: HealthAssessment | null = await monitor.probeOnce(fixture.ref);
  assert.equal(assessment.classification, "normal_wait");
  assert.equal(assessment.action.kind, "none", "不触发时间上限");
  assert.equal(assessment.activeDurationMs, 0);
  assert.equal(assessment.normalBlockedDurationMs, 61 * 60_000);
  // 登记期限已过（等待失效）：不再豁免，恢复有效计时（不重置累计等待）。
  snapshot = { ...snapshot, waitingFor: undefined };
  fixture.setNow(start + 61 * 60_000 + 15_000);
  assessment = await monitor.probeOnce(fixture.ref);
  assert.notEqual(assessment.classification, "normal_wait");
  assert.ok(assessment.activeDeltaMs > 0, "等待失效后重新计有效时间");
  assert.equal(assessment.normalBlockedDurationMs, 61 * 60_000, "已确认等待区间保留");
});
