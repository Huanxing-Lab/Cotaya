// CT-04 健康监控集成测试：U-08（15 秒探测、180 秒无进展 + 3 次确认失败才疑似 hang；正常
// 等待要有 owner/原因/期限；heartbeat 不等于进展；有效/等待/离线区间持久化）、
// E-29（正常阻塞超过一小时仍继续）、E-30（健康工作达到一小时暂停询问 + grant 延长）、
// E-31（探活识别卡死，heartbeat 不能掩盖；合法长等待继续；unreachable 进恢复核对）、
// R-12（normal_wait/疑似 hang 期间重启：等待与有效时长保留、离线缺口不计、无固定墙钟取消）。
// 用例定义见 docs/testing/continuous.md；真实 SQLite 持久化 cycle 健康字段，快照/时钟注入。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import { continueCycleExecution } from "../../src/continuous/application/supervisorResume.js";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTINUOUS_DEFAULT_BUDGET, CONTINUOUS_DEFAULT_CADENCE } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";
import {
  ContinuousHealthMonitor,
  type HealthAssessment,
} from "../../src/continuous/application/healthMonitor.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
import type { ExecutionReference, HealthSnapshot } from "../../src/continuous/application/ports.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct04-health-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

interface Fixture {
  repo: SqliteContinuousRepository;
  ref: ExecutionReference;
  cycle: Cycle;
  setNow: (at: number) => void;
  now: () => number;
  dispose: () => void;
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
  void repo.insertProgram(program);
  void repo.insertCycle(cycle);
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
    setNow: (at: number) => {
      now = at;
    },
    now: clock,
    dispose: () => repo.close(),
  };
}

/** 直读快照的执行端口替身：fixture.setSnapshot 控制下一次 inspectHealth 的返回。 */
function snapshotPort(fixture: Fixture, current: () => HealthSnapshot) {
  return { inspectHealth: async (): Promise<HealthSnapshot> => current() };
}

async function probeWith(
  fixture: Fixture,
  monitor: ContinuousHealthMonitor,
): Promise<HealthAssessment> {
  const assessment = await monitor.probeOnce(fixture.ref);
  assert.ok(assessment, "probeOnce 必须返回评估");
  return assessment;
}

function progressingSnapshot(lastProgressAt: number): HealthSnapshot {
  return {
    runId: "run-1",
    actorIds: ["actor-1"],
    lastProgressAt,
    ownerEpoch: 1,
    reachable: true,
  };
}

test("U-08 分类：进展推进归 progressing；等待证据缺失/过期不豁免计时", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const current = progressingSnapshot(fixture.now());
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture, () => current),
  });
  // 首次探活建立基线。
  await probeWith(fixture, monitor);
  // 推进：lastProgressAt 前进 → progressing，区间计入有效时间。
  fixture.setNow(fixture.now() + 15_000);
  current.lastProgressAt = fixture.now();
  let assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.classification, "progressing");
  assert.equal(assessment.activeDeltaMs, 15_000);
  // 等待证据缺期限（deadline 缺席）：不算 normal_wait，时间照计。
  fixture.setNow(fixture.now() + 15_000);
  current.waitingFor = { ownerId: "ask-1", reason: "slot", deadlineAt: 0 };
  current.lastProgressAt = fixture.now() - 30_000;
  assessment = await probeWith(fixture, monitor);
  assert.notEqual(assessment.classification, "normal_wait");
  assert.equal(assessment.activeDeltaMs, 15_000, "无效等待证据仍计有效时间");
  // 证据齐备且期限未过：normal_wait，区间进 blocked，不进有效。
  fixture.setNow(fixture.now() + 15_000);
  current.waitingFor = {
    ownerId: "ask-1",
    reason: "long test",
    deadlineAt: fixture.now() + 60_000,
  };
  assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.classification, "normal_wait");
  assert.equal(assessment.normalBlockedDeltaMs, 15_000);
  assert.equal(assessment.activeDeltaMs, 0);
  // 期限已过：不再豁免。
  fixture.setNow(fixture.now() + 15_000);
  current.waitingFor = { ownerId: "ask-1", reason: "long test", deadlineAt: fixture.now() - 1 };
  assessment = await probeWith(fixture, monitor);
  assert.notEqual(assessment.classification, "normal_wait");
  assert.equal(assessment.activeDeltaMs, 15_000);
  // owner 缺席同样不算（heartbeat/pending 标签不足以证明等待）。
  fixture.setNow(fixture.now() + 15_000);
  current.waitingFor = { ownerId: "", reason: "x", deadlineAt: fixture.now() + 60_000 };
  assessment = await probeWith(fixture, monitor);
  assert.notEqual(assessment.classification, "normal_wait");
});

test("U-08/E-31 疑似 hang：180 秒无进展且连续 3 次确认失败；heartbeat 不掩盖；unreachable 归恢复", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const staleAt = fixture.now();
  const current: HealthSnapshot = { ...progressingSnapshot(staleAt) };
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture, () => current),
  });
  await probeWith(fixture, monitor); // 基线（有进展，计数清零）
  // heartbeat 场景：reachable 恒真、lastProgressAt 不动（仅进程存活不是进展）。
  // 60s/120s：第 1、2 次确认失败，未达「连续 3 次」。
  fixture.setNow(staleAt + 60_000);
  let assessment = await probeWith(fixture, monitor);
  assert.notEqual(assessment.classification, "suspected_hang");
  assert.equal(assessment.action.kind, "none");
  fixture.setNow(staleAt + 120_000);
  assessment = await probeWith(fixture, monitor);
  assert.notEqual(assessment.classification, "suspected_hang");
  // 180s：第 3 次确认失败且停滞满 180 秒 → suspected_hang + 诊断动作（不 failed/cancelled）。
  fixture.setNow(staleAt + 180_000);
  assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.classification, "suspected_hang");
  assert.equal(assessment.action.kind, "suspected_hang");
  if (assessment.action.kind === "suspected_hang") {
    assert.equal(assessment.action.observed.probeFailedCount, 3);
    assert.equal(assessment.action.observed.stalledMs, 180_000);
  }
  const persisted = await fixture.repo.getCycle(fixture.cycle.id);
  assert.equal(persisted?.healthState, "suspected_hang", "诊断持久化在 cycle");
  // 对照：合法长等待（证据齐备）同样 180s 不判 hang。
  const fixture2 = await makeFixture();
  t.after(() => fixture2.dispose());
  const waiting: HealthSnapshot = {
    ...progressingSnapshot(fixture2.now()),
    waitingFor: { ownerId: "ask", reason: "external review", deadlineAt: fixture2.now() + 600_000 },
  };
  const monitor2 = new ContinuousHealthMonitor({
    repository: fixture2.repo,
    clock: { now: fixture2.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture2, () => waiting),
  });
  await monitor2.probeOnce(fixture2.ref);
  fixture2.setNow(fixture2.now() + 200_000);
  const assessment2 = await probeWith(fixture2, monitor2);
  assert.equal(assessment2.classification, "normal_wait", "合法等待继续，不判 hang");
  // 对照：Host 断联 → unreachable（不计时不判 hang，归恢复核对）。
  const unreachable: HealthSnapshot = { ...waiting, reachable: false };
  const monitor3 = new ContinuousHealthMonitor({
    repository: fixture2.repo,
    clock: { now: fixture2.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture2, () => unreachable),
  });
  fixture2.setNow(fixture2.now() + 15_000);
  const assessment3 = await probeWith(fixture2, monitor3);
  assert.equal(assessment3.classification, "unreachable");
  assert.equal(assessment3.activeDeltaMs, 0);
  assert.equal(assessment3.normalBlockedDeltaMs, 0, "离线区间两者都不计");
});

test("E-29 正常阻塞超过一小时仍继续：不触发时间上限、blocked 持久化、等待结束恢复计时", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const start = fixture.now();
  const waiting: HealthSnapshot = {
    ...progressingSnapshot(start),
    waitingFor: {
      ownerId: "ask",
      reason: "registered long test",
      deadlineAt: start + 5 * 3_600_000,
    },
  };
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture, () => waiting),
  });
  await monitor.probeOnce(fixture.ref);
  // 墙钟推进 75 分钟（> 1 小时上限），全部处于已证实正常等待。
  fixture.setNow(start + 75 * 60_000);
  const assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.classification, "normal_wait");
  assert.equal(assessment.action.kind, "none", "不弹时间额度问题、不取消");
  assert.equal(assessment.activeDurationMs, 0);
  assert.equal(assessment.normalBlockedDurationMs, 75 * 60_000);
  // 等待结束恢复有效计时（同一监控实例继续）：不重置累计（blocked 保留，active 继续累计）。
  delete (waiting as { waitingFor?: HealthSnapshot["waitingFor"] }).waitingFor;
  waiting.lastProgressAt = fixture.now() + 15_000;
  fixture.setNow(fixture.now() + 15_000);
  const assessment2 = await probeWith(fixture, monitor);
  assert.equal(assessment2.classification, "progressing");
  assert.equal(assessment2.activeDurationMs, 15_000, "恢复后从零继续，不重置 blocked");
  assert.equal(assessment2.normalBlockedDurationMs, 75 * 60_000, "等待区间保留");
});

test("E-30 健康工作达到一小时：暂停询问；grant 增量延长上限而已用量保留", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const start = fixture.now();
  const current: HealthSnapshot = progressingSnapshot(start);
  const mk = () =>
    new ContinuousHealthMonitor({
      repository: fixture.repo,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
      execution: snapshotPort(fixture, () => current),
    });
  const monitor = mk();
  await monitor.probeOnce(fixture.ref);
  // 59 分钟：健康推进，未到上限。
  fixture.setNow(start + 59 * 60_000);
  current.lastProgressAt = fixture.now();
  let assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.action.kind, "none");
  assert.equal(assessment.activeDurationMs, 59 * 60_000);
  // 再 1 分钟：达到 3,600,000ms → time_limit_reached（观察值携带事实）。
  fixture.setNow(start + 60 * 60_000);
  current.lastProgressAt = fixture.now();
  assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.classification, "progressing");
  assert.equal(assessment.action.kind, "time_limit_reached");
  if (assessment.action.kind === "time_limit_reached") {
    assert.equal(assessment.action.observed.activeDurationMs, 3_600_000);
    assert.equal(assessment.action.observed.effectiveLimitMs, 3_600_000);
  }
  // 用户授权 +1 小时（grant 落库经 continuation 表；此处直接插一条 resolved 请求）。
  await fixture.repo.insertContinuationRequest({
    id: "cont-1",
    programId: fixture.cycle.programId,
    cycleId: fixture.cycle.id,
    reason: "time_limit",
    limitKind: "time",
    reasons: ["time_limit"],
    observedUsage: {},
    currentLimit: {},
    recommendedExtension: {},
    version: 2,
    status: "resolved",
    resolution: {
      kind: "continue_with_grant",
      resolvedAt: fixture.now(),
      grant: { activeMs: 3_600_000 },
    },
    createdAt: start,
    resolvedAt: fixture.now(),
  });
  // 同一 Cycle、同一监控继续：有效上限 2 小时，已用 1 小时保留（grant 是增量不是重置）。
  fixture.setNow(start + 60 * 60_000 + 15_000);
  current.lastProgressAt = fixture.now();
  assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.effectiveLimitMs, 7_200_000, "上限 = 默认 + grant 增量");
  assert.equal(assessment.activeDurationMs, 3_615_000, "已消耗量保留，不重置");
  assert.equal(assessment.action.kind, "none", "未到新上限不再询问");
  // 到 2 小时再次触发（总允许时间 2 小时）。
  fixture.setNow(start + 120 * 60_000);
  current.lastProgressAt = fixture.now();
  assessment = await probeWith(fixture, monitor);
  assert.equal(assessment.action.kind, "time_limit_reached");
});

test("R-12 重启保留区间且离线缺口不计；15 秒节拍由注入 schedule 驱动", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const start = fixture.now();
  const current: HealthSnapshot = progressingSnapshot(start);
  const scheduled: { at: number; callback: () => void }[] = [];
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: {
      now: fixture.now,
      timeZone: () => "Asia/Shanghai",
      schedule: (callback, delayMs) => {
        scheduled.push({ at: fixture.now() + delayMs, callback });
        return () => {};
      },
    },
    execution: snapshotPort(fixture, () => current),
  });
  const assessments: HealthAssessment[] = [];
  const stop = monitor.start(fixture.ref, (assessment) => assessments.push(assessment));
  t.after(() => stop());
  assert.equal(scheduled.length, 1, "启动即排第一个 15 秒探活");
  // 驱动第一个 tick：建立实例基线（区间 0）。
  fixture.setNow(start + 15_000);
  current.lastProgressAt = fixture.now();
  scheduled.shift()!.callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0]!.activeDeltaMs, 0, "首拍建基线");
  assert.ok(scheduled.length >= 1, "探活后重排下一拍");
  // 第二个 tick：完整 15 秒区间计入有效时间。
  fixture.setNow(start + 30_000);
  current.lastProgressAt = fixture.now();
  scheduled.shift()!.callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(assessments.length, 2);
  assert.equal(assessments[1]!.activeDeltaMs, 15_000);
  // 重启模拟：新监控实例；中间隔了 1 小时「离线」——首探活区间为 0，不把缺口计入有效时间。
  fixture.setNow(start + 75 * 60_000);
  current.lastProgressAt = fixture.now();
  const monitor2 = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: snapshotPort(fixture, () => current),
  });
  const afterRestart = await probeWith(fixture, monitor2);
  assert.equal(afterRestart.activeDeltaMs, 0, "离线缺口不计入（R-12/R-09）");
  assert.equal(afterRestart.activeDurationMs, 15_000, "重启前的有效时长保留（0 + 15s 两拍）");
});

test("发布2.1：探活等待快照时发生暂停，旧快照不能覆盖状态或报告游标", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  let deliver!: (snapshot: HealthSnapshot) => void;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: {
      inspectHealth: () => {
        reached();
        return new Promise<HealthSnapshot>((resolve) => {
          deliver = resolve;
        });
      },
    },
  });
  const pending = monitor.probeOnce(fixture.ref);
  await entered;
  await fixture.repo.saveCycle({ ...fixture.cycle, status: "suspended", reportCursor: 99 });
  deliver(progressingSnapshot(fixture.now()));
  assert.equal(await pending, null);
  const saved = await fixture.repo.getCycle(fixture.cycle.id);
  assert.equal(saved?.status, "suspended");
  assert.equal(saved?.reportCursor, 99);
});

test("发布2.1：健康字段原子更新拒绝旧 epoch 和已取消的轮，不覆盖游标", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  await fixture.repo.saveCycle({ ...fixture.cycle, reportCursor: 9 });
  const update = {
    ...fixture.cycle,
    activeDurationMs: 15_000,
    lastProbeAt: fixture.now(),
    updatedAt: fixture.now(),
  };
  assert.equal(await fixture.repo.updateCycleHealth(update), true);
  assert.equal((await fixture.repo.getCycle(fixture.cycle.id))?.reportCursor, 9);
  assert.equal(await fixture.repo.updateCycleHealth({ ...update, leaseEpoch: 0 }), false);
  await fixture.repo.saveCycle({
    ...(await fixture.repo.getCycle(fixture.cycle.id))!,
    status: "cancelled",
  });
  assert.equal(
    await fixture.repo.updateCycleHealth({ ...update, activeDurationMs: 30_000 }),
    false,
  );
  assert.equal((await fixture.repo.getCycle(fixture.cycle.id))?.status, "cancelled");
});

test("发布2.1：Host running 先于唤醒等待者落库，恢复失败重新暂停", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  const suspended = { ...fixture.cycle, status: "suspended" as const };
  await fixture.repo.saveCycle(suspended);
  const execution = {
    resumeSuspended: async () => {
      assert.equal(
        (await fixture.repo.getCycle(suspended.id))?.status,
        "running",
        "预算账本已接受新请求",
      );
    },
  } as never;
  await continueCycleExecution(
    {
      repository: fixture.repo,
      execution,
      clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    },
    suspended,
    fixture.ref,
    { runId: "r", status: "running", resumable: false },
  );
  await fixture.repo.saveCycle(suspended);
  await assert.rejects(
    continueCycleExecution(
      {
        repository: fixture.repo,
        execution: {
          resumeSuspended: async () => {
            throw new Error("CLI 不可达");
          },
        } as never,
        clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
      },
      suspended,
      fixture.ref,
      { runId: "r", status: "running", resumable: false },
    ),
    /CLI 不可达/,
  );
  assert.equal((await fixture.repo.getCycle(suspended.id))?.status, "suspended");
});

test("发布2.1：旧监督者不能借用后来 Cycle 行的新 epoch 更新健康", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.dispose());
  await fixture.repo.saveCycle({ ...fixture.cycle, leaseEpoch: 2, reportCursor: 12 });
  let probes = 0;
  const monitor = new ContinuousHealthMonitor({
    repository: fixture.repo,
    ownerEpoch: 1,
    clock: { now: fixture.now, timeZone: () => "Asia/Shanghai" },
    execution: {
      inspectHealth: async () => {
        probes++;
        return progressingSnapshot(fixture.now());
      },
    },
  });
  assert.equal(await monitor.probeOnce(fixture.ref), null);
  assert.equal(probes, 0);
  assert.equal((await fixture.repo.getCycle(fixture.cycle.id))?.reportCursor, 12);
});
