// CT-13 预算与 AskUserQuestion 的真实通信测试：CLI→Host 预留/结算/拒绝通知的传输严格校验
// （身份、执行权版本、价格版本、请求键）、拒绝结果携带真实 limitKind/已用/预留/unknown/
// 当前限额/本请求需求、多 actor 同时超限合并确认、retry_limit 的继续授权语义、停留 paused
// 不发请求、跨日不自行扩额、旧版 errored 预算轮的不可恢复显示与用户结束旧轮/显式新开轮。
// 真实 SQLite tasks-index + assembleContinuousHost 栈（transport/CLI 对端为进程内替身，
// 命令/请求全部走真实 schema 与真实服务链）。
// 运行入口：node scripts/test-continuous.mjs --suite integration。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../../src/session/tasksDatabase/migrations.js";
import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousLedgerReserveResultSchema,
  type ContinuousLedgerReserveParams,
  type ContinuousRegisterManagedRunCommand,
} from "@zcode/shared/continuous-protocol";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
} from "@zcode/shared/continuous-protocol";
import { uiUxV1Template } from "@zcode/shared/continuous-templates";
import { assembleContinuousHost } from "../../src/continuous/adapters/hostAssembly.js";
import { suspendCycleForAgentNotification } from "../../src/continuous/application/supervisorSettlement.js";
import type { ContinuousAgentTransport } from "../../src/continuous/application/agentTransport.js";
import type { WorkspacePreparationPort } from "../../src/continuous/application/ports.js";
import type { Cycle, Program } from "../../src/continuous/domain/types.js";
import { SqliteContinuousRepository } from "../../src/continuous/adapters/sqliteRepository.js";

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

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct13-budgetcomm-"));
let dbCounter = 0;
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

function migratedDatabasePath(): string {
  dbCounter += 1;
  const path = join(tmpRoot, `tasks-index-${dbCounter}.sqlite`);
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
    throw new Error("ct13 测试不驱动候选检查点");
  },
  restoreCandidateFiles: async () => [],
};

/** 进程内 CLI 对端替身（assembly.test 同款，另支持 inspect 的 failureCode）。 */
interface ScriptedPeer {
  commands: Array<{ type: string; payload: unknown }>;
  runStatus: "running" | "stopped" | "errored" | "completed";
  failureCode?: string;
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
    ensureExecutionSession: async () => {},
    sendCommand: async ({ type, payload }) => {
      peer.commands.push({ type, payload });
      if (type === "continuousRegisterManagedRun") {
        const registration = payload as ContinuousRegisterManagedRunCommand;
        return {
          status: "accepted",
          result: {
            type: "continuousRegisterManagedRun",
            operations: fullOps,
            workflowRunId: registration.workflowRunId,
          },
        };
      }
      if (type === "continuousManagedCycle") {
        const command = payload as { op: string };
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
                ...(peer.failureCode === undefined ? {} : { failureCode: peer.failureCode }),
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
        if (command.op === "inspectHealth") {
          return {
            status: "accepted",
            result: {
              type: "continuousManagedCycle",
              op: "inspectHealth",
              health: {
                runId: "run",
                actorIds: [],
                ownerEpoch: 1,
                reachable: peer.runStatus === "running",
                admissionState: "open",
              },
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
  return { commands: [], runStatus: "running", ...overrides };
}

interface Fixture {
  host: Awaited<ReturnType<typeof assembleContinuousHost>>;
  peer: ScriptedPeer;
  program: Program;
  now: number;
  advance(ms: number): void;
  dispose(): void;
}

async function assembleFixture(
  overrides: { peer?: ScriptedPeer; budget?: Partial<Program["budget"]> } = {},
): Promise<Fixture> {
  const peer = overrides.peer ?? makePeer();
  const host = await assembleContinuousHost({
    databasePath: migratedDatabasePath(),
    clock: { now: () => nowValue, timeZone: () => "Asia/Shanghai" },
    transport: makeTransport(peer),
    pricing: () => PRICING,
    requestCaps: () => CAPS,
    workspace: fakeWorkspace,
    pollIntervalMs: 5,
  });
  let nowValue = Date.UTC(2026, 9, 5, 6, 0, 0);
  const program: Program = {
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
    budget: { ...CONTINUOUS_DEFAULT_BUDGET, ...overrides.budget },
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
    createdAt: nowValue,
    updatedAt: nowValue,
  };
  await host.repository.insertProgram(program);
  return {
    host,
    peer,
    program,
    get now() {
      return nowValue;
    },
    advance: (ms: number) => {
      nowValue += ms;
    },
    dispose: () => host.dispose(),
  };
}

/** 等待可观察事实（数据库行状态），不用 sleep 猜时序。 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function launchCycle(
  fixture: Fixture,
): Promise<{ cycleId: string; runId: string; epoch: number }> {
  const cycle = await fixture.host.commandService.runNow({
    context: {
      workspacePath: fixture.program.workspacePath,
      workspaceKey: fixture.program.workspaceKey,
      traceId: nextId("trace"),
    },
    programId: fixture.program.id,
    requestId: nextId("req"),
  });
  return { cycleId: cycle.id, runId: cycle.workflowRunId, epoch: cycle.leaseEpoch };
}

function reserveParams(
  fixture: Fixture,
  ref: { cycleId: string; runId: string; epoch: number },
  overrides: Partial<ContinuousLedgerReserveParams> = {},
): ContinuousLedgerReserveParams {
  return {
    programId: fixture.program.id,
    cycleId: ref.cycleId,
    workflowRunId: ref.runId,
    requestKey: nextId("rk"),
    provider: "fixture",
    model: "fixture-model",
    pricingVersion: PRICING.pricingVersion,
    reservedCostMicros: 151,
    reservedTokens: 2_000,
    leaseEpoch: ref.epoch,
    ...overrides,
  };
}

async function reserve(fixture: Fixture, params: ContinuousLedgerReserveParams) {
  return await fixture.host.handleAgentRequest(
    CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
    params,
  );
}

type ReserveOutcome =
  | { handled: false }
  | { handled: true; result?: { ok: boolean; code?: string; denial?: Record<string, unknown> } }
  | { handled: true; error: { code: number; message: string } };

/** 观测快照的固定断言片段（已用/预留/unknown 三分 + 当前限额 + 本请求需求）。 */
function assertDenialShape(denial: Record<string, unknown>): void {
  const cycleSummary = denial.cycleSummary as Record<string, number>;
  for (const key of [
    "settledCostMicros",
    "reservedCostMicros",
    "unknownCostMicros",
    "settledTokens",
    "reservedTokens",
    "unknownTokens",
  ]) {
    assert.ok(
      typeof cycleSummary[key] === "number",
      `denial.cycleSummary.${key} 必须是数值（已用/预留/unknown 三分）`,
    );
  }
  assert.ok(denial.currentLimit, "denial 必须携带当前限额（含 grant 增量后的有效值）");
  assert.ok(denial.request, "denial 必须携带本请求需求（reservedCostMicros/reservedTokens）");
}

test("CT-13 传输校验：身份四元组、执行权版本、价格版本、请求键", async () => {
  const fixture = await assembleFixture();
  try {
    const ref = await launchCycle(fixture);
    // 1) 身份：workflowRunId 与持久化行不符 → 校验失败（防串任务）。
    const wrongRun = await reserve(
      fixture,
      reserveParams(fixture, ref, { workflowRunId: "dwfrun-other" }),
    );
    assert.ok(wrongRun.handled && "error" in wrongRun, "runId 不符的预留按校验失败拒绝");
    // 2) 执行权版本：旧 leaseEpoch → 结构化 lease_lost，不落账本行。
    const stale = await reserve(
      fixture,
      reserveParams(fixture, ref, { leaseEpoch: ref.epoch - 1 }),
    );
    const staleResult = (stale as { result?: { ok: boolean; code?: string } }).result;
    assert.ok(staleResult && staleResult.ok === false);
    assert.equal(staleResult.code, "lease_lost", "旧 epoch 的预留结构化拒绝");
    // 3) 价格版本：CLI 持旧价格快照 → pricing_missing（fail closed，不按旧价入账）。
    const stalePricing = await reserve(
      fixture,
      reserveParams(fixture, ref, { pricingVersion: "test-prices-v0" }),
    );
    const pricingResult = (stalePricing as { result?: { ok: boolean; code?: string } }).result;
    assert.ok(pricingResult && pricingResult.ok === false);
    assert.equal(pricingResult.code, "pricing_missing", "价格版本不符结构化拒绝并显示原因");
    // 4) 正确身份/epoch/价格版本 → 预留成功；同 requestKey 同事实重发幂等 ok。
    const params = reserveParams(fixture, ref);
    const first = (await reserve(fixture, params)) as {
      result?: { ok: boolean; requestKey?: string };
    };
    assert.ok(first.result?.ok === true);
    const replay = (await reserve(fixture, params)) as {
      result?: { ok: boolean; requestKey?: string };
    };
    assert.ok(replay.result?.ok === true, "同请求键同事实的重发幂等复用（不落第二行）");
    // 5) 同 requestKey 不同事实 → 拒绝（请求键与事实绑定）。
    const conflicting = await reserve(
      fixture,
      reserveParams(fixture, ref, { ...params, reservedTokens: 999 }),
    );
    assert.ok(conflicting.handled && "error" in conflicting, "同键不同事实的预留拒绝");
  } finally {
    fixture.dispose();
  }
});

test("CT-13 拒绝观测：limitKind 真实、已用/预留/unknown 三分、当前限额与本请求需求；wire schema 可解析", async () => {
  const fixture = await assembleFixture({
    budget: { perCycleCostUsdMicros: 300, perCycleTokens: 4_000 },
  });
  try {
    const ref = await launchCycle(fixture);
    // 已结算 100 微美元 / 1_000 tokens；unknown 预留 151 / 2_000（保留不清零）。
    const settled = reserveParams(fixture, ref, { reservedCostMicros: 100, reservedTokens: 1_000 });
    assert.ok(((await reserve(fixture, settled)) as { result?: { ok: boolean } }).result?.ok);
    await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle, {
      programId: fixture.program.id,
      cycleId: ref.cycleId,
      workflowRunId: ref.runId,
      requestKey: settled.requestKey,
      state: "settled",
      actualTokens: 1_000,
      estimatedCostMicros: 100,
    });
    const unknown = reserveParams(fixture, ref);
    assert.ok(((await reserve(fixture, unknown)) as { result?: { ok: boolean } }).result?.ok);
    await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle, {
      programId: fixture.program.id,
      cycleId: ref.cycleId,
      workflowRunId: ref.runId,
      requestKey: unknown.requestKey,
      state: "unknown",
    });
    // 单轮费用超限（100 已用 + 151 unknown + 151 新需求 > 300）。
    const deniedCost = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    const costResult = (
      deniedCost as { result?: { ok: boolean; code?: string; denial?: Record<string, unknown> } }
    ).result;
    assert.ok(costResult && costResult.ok === false && costResult.code === "budget_denied");
    assert.equal(costResult!.denial!.limitKind, "cycle_cost");
    assertDenialShape(costResult!.denial!);
    const costSummary = costResult!.denial!.cycleSummary as Record<string, number>;
    assert.equal(costSummary.settledCostMicros, 100, "已用按实际结算值");
    assert.equal(costSummary.unknownCostMicros, 151, "unknown 按预留值单列，不清零");
    assert.equal(costSummary.reservedCostMicros, 0, "在途预留单列");
    assert.equal(
      (costResult!.denial!.request as Record<string, number>).reservedCostMicros,
      151,
      "本请求需求如实携带",
    );
    assert.equal(
      (costResult!.denial!.currentLimit as Record<string, number>).cycleCostMicros,
      300,
      "当前限额为并入 grant 后的有效值（此处无 grant = 基础值）",
    );
    // CLI 侧按同一 strict schema 解析（回归：旧实现把 cycle_tokens 投影成 schema 外的
    // cycle_token，CLI 解析失败折算 ledger_unreachable，token 超限被误报成断联）。
    assert.doesNotThrow(() =>
      continuousLedgerReserveResultSchema.parse({
        ok: false,
        code: "budget_denied",
        message: "denied",
        denial: costResult!.denial,
      }),
    );
    // 单轮 token 超限（1_000 已用 + 2_000 unknown + 2_000 新需求 > 4_000）。
    const deniedTokens = (await reserve(
      fixture,
      reserveParams(fixture, ref, { reservedCostMicros: 1 }),
    )) as ReserveOutcome;
    const tokenResult = (
      deniedTokens as { result?: { ok: boolean; code?: string; denial?: Record<string, unknown> } }
    ).result;
    assert.ok(tokenResult && tokenResult.ok === false);
    assert.equal(tokenResult!.denial!.limitKind, "cycle_tokens", "单轮 token 上限的真实 limitKind");
    assert.equal(
      (tokenResult!.denial!.cycleSummary as Record<string, number>).unknownTokens,
      2_000,
    );
    assert.doesNotThrow(() =>
      continuousLedgerReserveResultSchema.parse({
        ok: false,
        code: "budget_denied",
        message: "denied",
        denial: tokenResult!.denial,
      }),
    );
  } finally {
    fixture.dispose();
  }
});

test("CT-13 日费用超限：denial 携带日窗口观测与日限额", async () => {
  const fixture = await assembleFixture({ budget: { dailyCostUsdMicros: 200 } });
  try {
    const ref = await launchCycle(fixture);
    assert.ok(
      ((await reserve(fixture, reserveParams(fixture, ref))) as { result?: { ok: boolean } }).result
        ?.ok,
    );
    const denied = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    const result = (
      denied as { result?: { ok: boolean; code?: string; denial?: Record<string, unknown> } }
    ).result;
    assert.ok(result && result.ok === false && result.code === "budget_denied");
    assert.equal(result!.denial!.limitKind, "daily_cost");
    assert.ok(result!.denial!.dailySummary, "日窗口观测随拒绝携带");
    assert.equal(
      (result!.denial!.currentLimit as Record<string, number | null>).dailyCostMicros,
      200,
    );
  } finally {
    fixture.dispose();
  }
});

/** 预算拒绝通知载荷（带真实 denial 观测，与 CLI 闸门转发形状一致）。 */
function suspensionParams(
  fixture: Fixture,
  ref: { cycleId: string; runId: string; epoch: number },
  denial: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    programId: fixture.program.id,
    cycleId: ref.cycleId,
    workflowRunId: ref.runId,
    leaseEpoch: ref.epoch,
    code: "budget_denied",
    message: "budget limit reached",
    denial,
    ...overrides,
  };
}

test("CT-13 统一暂停：先冻结执行侧，再保存同轮唯一确认；多 actor 同时超限合并不重复弹窗", async () => {
  const fixture = await assembleFixture();
  try {
    const ref = await launchCycle(fixture);
    fixture.peer.commands.length = 0;
    const denialCost = {
      limitKind: "cycle_cost",
      cycleSummary: {
        settledCostMicros: 100,
        reservedCostMicros: 0,
        unknownCostMicros: 151,
        settledTokens: 0,
        reservedTokens: 0,
        unknownTokens: 0,
      },
      currentLimit: { cycleCostMicros: 300, cycleTokens: 1_000_000_000, dailyCostMicros: null },
      request: { reservedCostMicros: 151, reservedTokens: 2_000 },
    };
    const denialTokens = {
      limitKind: "cycle_tokens",
      cycleSummary: {
        settledCostMicros: 100,
        reservedCostMicros: 0,
        unknownCostMicros: 0,
        settledTokens: 1_000,
        reservedTokens: 0,
        unknownTokens: 2_000,
      },
      currentLimit: { cycleCostMicros: 300, cycleTokens: 1_000_000_000, dailyCostMicros: null },
      request: { reservedCostMicros: 151, reservedTokens: 2_000 },
    };
    // 两个 actor 同时超限（并发通知）：合并进同一条 pending 确认。
    const [first, second] = await Promise.all([
      fixture.host.handleAgentRequest(
        CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
        suspensionParams(fixture, ref, denialCost),
      ),
      fixture.host.handleAgentRequest(
        CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
        suspensionParams(fixture, ref, denialTokens),
      ),
    ]);
    assert.ok(first.handled && !("error" in first), "第一个通知成功");
    assert.ok(second.handled && !("error" in second), "并发第二个通知合并成功（不重复弹窗）");
    const suspended = await fixture.host.repository.getCycle(ref.cycleId);
    assert.equal(suspended?.status, "suspended");
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending, "同轮唯一 pending 继续确认");
    assert.deepEqual(
      new Set(pending!.reasons),
      new Set(["cost_limit", "token_limit"]),
      "多上限触发合并进同一条确认的 reasons",
    );
    // 观测是真实账本数字，不是只有错误文字；两个上限的触发都保留在合并确认里。
    const triggers =
      (
        pending!.observedUsage as {
          triggers?: Array<{
            denial?: { limitKind?: string; cycleSummary?: Record<string, number> };
          }>;
        }
      ).triggers ?? [];
    assert.equal(triggers.length, 2, "费用与 token 两个触发都保留（不以后到者覆盖先到者）");
    const costTrigger = triggers.find((trigger) => trigger.denial?.limitKind === "cycle_cost");
    assert.equal(costTrigger?.denial?.cycleSummary?.settledCostMicros, 100);
    const mergedLimit = pending!.currentLimit as Record<string, number>;
    assert.equal(mergedLimit.perCycleCostUsdMicros, 300, "继续确认携带费用当前限额");
    assert.equal(mergedLimit.perCycleTokens, 1_000_000_000, "继续确认同时携带 token 当前限额");
    const program = await fixture.host.repository.getProgram(fixture.program.id);
    assert.equal(program?.status, "paused");
    const flow = fixture.peer.commands.map(
      (c) => `${c.type}:${(c.payload as { op?: string }).op ?? ""}`,
    );
    assert.ok(
      flow.includes("continuousManagedCycle:suspendAtSafeBoundary"),
      "统一暂停路径先冻结 CLI 新模型/写操作（wire suspendAtSafeBoundary）",
    );
  } finally {
    fixture.dispose();
  }
});

test("CT-13 retry_limit 通知：保存 reason=retry_limit 的继续确认（单请求尝试上限的继续授权语义）", async () => {
  const fixture = await assembleFixture();
  try {
    const ref = await launchCycle(fixture);
    const notified = await fixture.host.handleAgentRequest(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      {
        programId: fixture.program.id,
        cycleId: ref.cycleId,
        workflowRunId: ref.runId,
        leaseEpoch: ref.epoch,
        code: "retry_limit",
        message: "continuous model request exceeded 3 attempts",
      },
    );
    assert.ok(notified.handled && !("error" in notified));
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending, "尝试上限触发同轮继续确认");
    assert.equal(pending!.reason, "retry_limit");
    assert.equal(pending!.limitKind, "retry");
    const cycle = await fixture.host.repository.getCycle(ref.cycleId);
    assert.equal(cycle?.status, "suspended");
  } finally {
    fixture.dispose();
  }
});

test("CT-13 change_limit 通知：执行权校验 + reason=change_limit 的继续确认（变更量上限）", async () => {
  const fixture = await assembleFixture();
  try {
    const ref = await launchCycle(fixture);
    // 旧执行权的变更量通知不得写暂停（E-19 旧 epoch 副作用拒绝）。
    const stale = await fixture.host.handleAgentRequest(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      {
        programId: fixture.program.id,
        cycleId: ref.cycleId,
        workflowRunId: ref.runId,
        leaseEpoch: ref.epoch - 1,
        code: "change_limit",
        limitKind: "file_limit",
        message: "file limit",
      },
    );
    assert.ok(stale.handled && "error" in stale, "旧 epoch 的拒绝通知按校验失败拒绝");
    const notified = await fixture.host.handleAgentRequest(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      {
        programId: fixture.program.id,
        cycleId: ref.cycleId,
        workflowRunId: ref.runId,
        leaseEpoch: ref.epoch,
        code: "change_limit",
        limitKind: "file_limit",
        message: "file limit",
      },
    );
    assert.ok(notified.handled && !("error" in notified));
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending, "变更量上限触发同轮继续确认");
    assert.equal(pending!.reason, "change_limit");
    assert.equal(pending!.limitKind, "change");
    assert.equal(
      (pending!.currentLimit as Record<string, number>).perCycleMaxFiles,
      fixture.program.budget.perCycleMaxFiles,
      "变更量上限携带真实配置",
    );
    const cycle = await fixture.host.repository.getCycle(ref.cycleId);
    assert.equal(cycle?.status, "suspended");
  } finally {
    fixture.dispose();
  }
});

test("CT-13 停留 paused 不调用 provider；授权保存增量不重置已用量；重复回答/旧 version 不扩额", async () => {
  const fixture = await assembleFixture({ budget: { perCycleCostUsdMicros: 452 } });
  try {
    const ref = await launchCycle(fixture);
    // 已用 151（结算）+ 挂起触发：unknown 151。
    const first = reserveParams(fixture, ref);
    assert.ok(((await reserve(fixture, first)) as { result?: { ok: boolean } }).result?.ok);
    await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle, {
      programId: fixture.program.id,
      cycleId: ref.cycleId,
      workflowRunId: ref.runId,
      requestKey: first.requestKey,
      state: "settled",
      actualTokens: 2_000,
      estimatedCostMicros: 151,
    });
    const second = reserveParams(fixture, ref);
    assert.ok(((await reserve(fixture, second)) as { result?: { ok: boolean } }).result?.ok);
    await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle, {
      programId: fixture.program.id,
      cycleId: ref.cycleId,
      workflowRunId: ref.runId,
      requestKey: second.requestKey,
      state: "unknown",
    });
    // 第 3 笔 151：151+151+151=453 > 452 → 拒绝 → 挂起。
    const denied = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    assert.equal(
      (denied as { result?: { ok: boolean } }).result?.ok,
      false,
      "452 限额下第三笔 151 被拒（151×3=453）",
    );
    const suspension = await fixture.host.handleAgentRequest(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      suspensionParams(fixture, ref, {
        limitKind: "cycle_cost",
        cycleSummary: {
          settledCostMicros: 151,
          reservedCostMicros: 0,
          unknownCostMicros: 151,
          settledTokens: 2_000,
          reservedTokens: 0,
          unknownTokens: 2_000,
        },
        currentLimit: { cycleCostMicros: 452, cycleTokens: 1_000_000_000, dailyCostMicros: null },
        request: { reservedCostMicros: 151, reservedTokens: 2_000 },
      }),
    );
    assert.ok(
      suspension.handled && !("error" in suspension),
      `拒绝通知必须成功（实际：${JSON.stringify(suspension)}）`,
    );
    // 停留 paused：新预留 admission_closed，不发 provider（账本行数不增）。
    const pausedReserve = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    assert.equal(
      (pausedReserve as { result?: { ok: boolean; code?: string } }).result?.code,
      "admission_closed",
      "停留 paused 期间新请求冻结（provider 调用数为零）",
    );
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending);
    // 授权 +300（增量）：合并后有效限额 752；已用不清零（151 已结算 + 151 unknown 仍占）。
    await fixture.host.commandService.resolveContinuation({
      context: {
        workspacePath: fixture.program.workspacePath,
        workspaceKey: fixture.program.workspaceKey,
        traceId: nextId("trace"),
      },
      programId: fixture.program.id,
      requestId: pending!.id,
      version: pending!.version,
      answer: { kind: "continue_with_grant", grant: { costMicros: 300 } },
    });
    const grants = await fixture.host.repository.listCycleContinuationGrants(ref.cycleId);
    assert.equal(grants.length, 1, "授权保存为增量 grant");
    const cycleAfter = await fixture.host.repository.getCycle(ref.cycleId);
    assert.equal(cycleAfter?.status, "running", "Host 先保存 running，再解除 CLI 等待");
    // 重复同回答（同 version 同 kind）：幂等 no-op，不重复扩额。
    const replayAnswer = await fixture.host.commandService.resolveContinuation({
      context: {
        workspacePath: fixture.program.workspacePath,
        workspaceKey: fixture.program.workspaceKey,
        traceId: nextId("trace"),
      },
      programId: fixture.program.id,
      requestId: pending!.id,
      version: pending!.version,
      answer: { kind: "continue_with_grant", grant: { costMicros: 300 } },
    });
    assert.equal(replayAnswer.status, "resolved");
    assert.equal(
      (await fixture.host.repository.listCycleContinuationGrants(ref.cycleId)).length,
      1,
      "重复回答不重复扩额",
    );
    // 旧 version 回答：version_conflict。
    await assert.rejects(
      fixture.host.commandService.resolveContinuation({
        context: {
          workspacePath: fixture.program.workspacePath,
          workspaceKey: fixture.program.workspaceKey,
          traceId: nextId("trace"),
        },
        programId: fixture.program.id,
        requestId: pending!.id,
        version: 1,
        answer: { kind: "continue_with_grant", grant: { costMicros: 999 } },
      }),
      (error: unknown) => {
        const code =
          (error as { code?: string }).code ?? (error as { error?: { code?: string } }).error?.code;
        assert.equal(code, "version_conflict", "旧 version 回答拒绝");
        return true;
      },
    );
    assert.equal(
      (await fixture.host.repository.listCycleContinuationGrants(ref.cycleId)).length,
      1,
      "旧 version 不扩额",
    );
    // 已用量未重置：752 - (151 settled + 151 unknown) = 450 头寸；第 3 笔 151 通过后
    // 第 4 笔 151（合计 604）通过、第 5 笔（755 > 752）拒绝——若已用量被重置则不会拒绝。
    for (let index = 0; index < 2; index++) {
      const granted = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
      assert.ok(
        (granted as { result?: { ok: boolean } }).result?.ok === true,
        `授权后第 ${index + 1} 笔在增量头寸内通过`,
      );
    }
    const overGranted = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    assert.equal(
      (overGranted as { result?: { ok: boolean } }).result?.ok,
      false,
      "已用/unknown 不清零：累计超出增量后的限额仍拒绝",
    );
  } finally {
    fixture.dispose();
  }
});

test("CT-13 跨日不自行扩额：suspended 跨日/重启保持暂停，继续仍需用户授权", async () => {
  const fixture = await assembleFixture({ budget: { dailyCostUsdMicros: 200 } });
  try {
    const ref = await launchCycle(fixture);
    const first = reserveParams(fixture, ref);
    assert.ok(((await reserve(fixture, first)) as { result?: { ok: boolean } }).result?.ok);
    const denied = (await reserve(fixture, reserveParams(fixture, ref))) as ReserveOutcome;
    assert.equal((denied as { result?: { ok: boolean } }).result?.ok, false);
    await fixture.host.handleAgentRequest(
      CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
      suspensionParams(fixture, ref, {
        limitKind: "daily_cost",
        cycleSummary: {
          settledCostMicros: 0,
          reservedCostMicros: 0,
          unknownCostMicros: 151,
          settledTokens: 0,
          reservedTokens: 0,
          unknownTokens: 2_000,
        },
        dailySummary: {
          settledCostMicros: 0,
          reservedCostMicros: 0,
          unknownCostMicros: 151,
          settledTokens: 0,
          reservedTokens: 0,
          unknownTokens: 2_000,
        },
        currentLimit: {
          cycleCostMicros: 100_000_000,
          cycleTokens: 1_000_000_000,
          dailyCostMicros: 200,
        },
        request: { reservedCostMicros: 151, reservedTokens: 2_000 },
      }),
    );
    // 跨日（26h > 任何 DST 日）：日窗口已翻页，但 suspended 不自动恢复。
    fixture.advance(26 * 3_600_000);
    const report = await fixture.host.recovery.recoverWorkspace(fixture.program.workspaceKey);
    assert.equal(
      report.reconciled.find((entry) => entry.cycleId === ref.cycleId)?.action,
      "kept_suspended",
      "跨日不自动恢复（仅日额度过期不能自行扩额）",
    );
    const stillSuspended = await fixture.host.repository.getCycle(ref.cycleId);
    assert.equal(stillSuspended?.status, "suspended");
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending, "pending 确认跨日保留");
    await assert.rejects(
      fixture.host.supervisor.continueSuspendedCycle(ref.cycleId),
      (error: unknown) => {
        assert.match(String((error as Error).message), /继续确认尚未回答/);
        return true;
      },
    );
  } finally {
    fixture.dispose();
  }
});

test("CT-13 旧版 errored 预算轮：显示不可恢复；用户结束旧轮后显式新开轮，账本与历史保留", async () => {
  const fixture = await assembleFixture({
    peer: makePeer({ runStatus: "errored", failureCode: "budget_denied" }),
  });
  try {
    const ref = await launchCycle(fixture);
    // 旧轮账本事实：一笔已结算（结束旧轮后必须保留）。
    const ledgerRow = reserveParams(fixture, ref);
    assert.ok(((await reserve(fixture, ledgerRow)) as { result?: { ok: boolean } }).result?.ok);
    await fixture.host.handleAgentRequest(CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle, {
      programId: fixture.program.id,
      cycleId: ref.cycleId,
      workflowRunId: ref.runId,
      requestKey: ledgerRow.requestKey,
      state: "settled",
      actualTokens: 2_000,
      estimatedCostMicros: 151,
    });
    // 旧版语义：预算拒绝使 Run errored（failureCode budget_denied）→ 监督按 §6.1 挂起。
    await waitFor(
      async () => (await fixture.host.repository.getCycle(ref.cycleId))?.status === "suspended",
    );
    const pending = await fixture.host.repository.getPendingContinuationRequest(ref.cycleId);
    assert.ok(pending, "旧 errored 轮也有同轮继续确认（挂起而非任务失败）");
    // 不可恢复显示：programDetail 的 currentCycle.executionRecoverable === false。
    const detail = await fixture.host.commandService.programDetail({
      context: {
        workspacePath: fixture.program.workspacePath,
        workspaceKey: fixture.program.workspaceKey,
        traceId: nextId("trace"),
      },
      programId: fixture.program.id,
    });
    assert.equal(
      detail.currentCycle?.executionRecoverable,
      false,
      "errored Run 的预算轮在详情读面显示不可恢复",
    );
    // 用户选择继续：resolve 落库 grant，但恢复被明确拒绝（errored 不冒充可恢复）。
    await assert.rejects(
      fixture.host.commandService.resolveContinuation({
        context: {
          workspacePath: fixture.program.workspacePath,
          workspaceKey: fixture.program.workspaceKey,
          traceId: nextId("trace"),
        },
        programId: fixture.program.id,
        requestId: pending!.id,
        version: pending!.version,
        answer: { kind: "continue_with_grant", grant: { costMicros: 1_000 } },
      }),
      (error: unknown) => {
        const code =
          (error as { code?: string }).code ?? (error as { error?: { code?: string } }).error?.code;
        assert.equal(code, "program_not_runnable", "errored Run 拒绝同 Run 恢复");
        return true;
      },
    );
    // 用户结束旧轮：立即停止链结算 cancelled（errored Run 无副作用可撤销，账本保留）。
    const lease = await fixture.host.repository.getLease(fixture.program.workspaceKey);
    const ended = await fixture.host.commandService.stopCurrentCycle({
      context: {
        workspacePath: fixture.program.workspacePath,
        workspaceKey: fixture.program.workspaceKey,
        traceId: nextId("trace"),
      },
      programId: fixture.program.id,
      epoch: lease?.epoch ?? ref.epoch,
    });
    assert.equal(ended.status, "cancelled", "结束旧轮落 cancelled");
    const keptRow = await fixture.host.repository.getUsageRecord(ledgerRow.requestKey);
    assert.ok(keptRow && keptRow.state === "settled", "旧轮账本行保留");
    const keptSummary = await fixture.host.repository.summarizeUsage({
      programId: fixture.program.id,
      cycleId: ref.cycleId,
    });
    assert.equal(keptSummary.settledCostMicros, 151, "旧轮历史用量不被清零");
    // 显式新开轮：Program 先显式恢复（paused 不可隐式启动，§6），再 runNow 建新
    // Cycle/Run（新执行身份），旧轮行不动。
    await fixture.host.commandService.resumeProgram({
      context: {
        workspacePath: fixture.program.workspacePath,
        workspaceKey: fixture.program.workspaceKey,
        traceId: nextId("trace"),
      },
      programId: fixture.program.id,
    });
    const fresh = await launchCycle(fixture);
    assert.notEqual(fresh.cycleId, ref.cycleId);
    assert.notEqual(fresh.runId, ref.runId);
    const history = await fixture.host.repository.listRecentCycles(fixture.program.id, 10);
    assert.equal(history.length, 2, "旧轮历史保留（不删除）");
    await waitFor(() => fixture.peer.commands.length > 0);
  } finally {
    fixture.dispose();
  }
});

test("CT-13 拒绝通知挂起：wire 往返期间推进的游标/健康列不被旧快照整行覆盖（评审修复）", async () => {
  // 手工 repo + running Cycle 行（不走 runNow/supervisor——本用例只验证挂起落库的写纪律，
  // 不引入监督循环的异步尾巴）。
  const repo = new SqliteContinuousRepository(migratedDatabasePath(), 30_000);
  await repo.ensureReady();
  try {
    const now = Date.UTC(2026, 9, 5, 6, 0, 0);
    const program: Program = {
      id: nextId("program"),
      workspaceKey: "/repos/app",
      workspacePath: "/repos/app",
      revision: 1,
      goal: "持续改进桌面 UI",
      timeZone: "Asia/Shanghai",
      budget: { ...CONTINUOUS_DEFAULT_BUDGET },
      cadence: { ...CONTINUOUS_DEFAULT_CADENCE },
      scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
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
      workflowRunId: "run-race-1",
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
    // 构造真实竞态窗口：suspendAtSafeBoundary 的 wire 往返（秒级）期间，同一监督循环
    // 推进了 reportCursor（报告导入）与健康列（探活持久化，supervisorWatch 的
    // ingest/probeOnce 写路径）。修复前：挂起落库用入口快照整行回写，游标回退、健康列
    // 被旧值覆盖；修复后：落库前重读最新行合并挂起字段。
    const raceExecution = {
      suspendAtSafeBoundary: async () => {
        const mid = (await repo.getCycle(cycle.id))!;
        await repo.saveCycle({
          ...mid,
          reportCursor: 42,
          healthState: "normal_wait",
          lastProbeAt: 12345,
          updatedAt: 12345,
        });
      },
    };
    const requestId = await suspendCycleForAgentNotification(
      { repository: repo, execution: raceExecution, clock: { now: () => 99999 } },
      {
        cycle,
        program,
        code: "budget_denied",
        message: "竞态窗口内的拒绝通知",
      },
    );
    const suspended = (await repo.getCycle(cycle.id))!;
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.pendingContinuationRequestId, requestId);
    assert.equal(
      suspended.reportCursor,
      42,
      "挂起落库不回退报告游标（itemKey 去重兜底不应成为常态）",
    );
    assert.equal(suspended.healthState, "normal_wait", "挂起落库不覆盖健康列");
    assert.equal(suspended.lastProbeAt, 12345, "挂起落库不回退探活时刻");
  } finally {
    repo.close();
  }
});

test("CT-13 拒绝通知挂起：往返窗口内已被停止/退出收尾的轮不被翻写回 suspended（二期评审修复）", async () => {
  // 复现竞态：CLI 的 budgetSuspension 通知进入 Host 后，在 suspendAtSafeBoundary 的 wire
  // 往返窗口内，用户并发的「立即停止」链把 Cycle 结算为 cancelled（或桌面退出保存
  // interrupted）。修复前：守卫只排除 suspended，迟到的通知仍会把终态/interrupted 行整行
  // 翻写回 suspended——违反 §6「立即停止→cancelled」终局性，且被复活的 suspended 行按
  // 部分唯一索引仍算开放轮，下一次 runNow 撞 open_cycle_exists。修复后：仅
  // running/preparing/settling 开放轮才合并挂起字段。
  // interrupted 在部分唯一索引里也算开放轮，两个用例各用独立 Program 避免撞
  // continuous_one_open_cycle。
  const repo = new SqliteContinuousRepository(migratedDatabasePath(), 30_000);
  await repo.ensureReady();
  try {
    const now = Date.UTC(2026, 9, 6, 6, 0, 0);
    const makeProgram = (key: string): Program => ({
      id: nextId("program"),
      workspaceKey: key,
      workspacePath: key,
      revision: 1,
      goal: "持续改进桌面 UI",
      timeZone: "Asia/Shanghai",
      budget: { ...CONTINUOUS_DEFAULT_BUDGET },
      cadence: { ...CONTINUOUS_DEFAULT_CADENCE },
      scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
      decisionPolicy: { unknownToDecision: true },
      authorization: {
        revision: 1,
        templateHash: TEMPLATE.scriptHash,
        grantedAt: "2026-10-06T00:00:00Z",
      },
      templateId: TEMPLATE.templateId,
      templateVersion: TEMPLATE.templateVersion,
      templateHash: TEMPLATE.scriptHash,
      status: "active",
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
    const makeCycle = (program: Program, runId: string): Cycle => ({
      id: nextId("cycle"),
      programId: program.id,
      sequence: 1,
      triggerKey: `manual-${program.id}`,
      trigger: { kind: "manual" },
      status: "running",
      configurationSnapshot: {},
      scriptText: "return {}",
      scriptHash: "c".repeat(64),
      executionSessionId: nextId("session"),
      workflowRunId: runId,
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
    });
    const settleDuringWire = (target: Cycle, finalStatus: "cancelled" | "interrupted") => ({
      suspendAtSafeBoundary: async () => {
        const mid = (await repo.getCycle(target.id))!;
        await repo.saveCycle({
          ...mid,
          status: finalStatus,
          ...(finalStatus === "cancelled" ? { completedAt: 12345 } : {}),
          updatedAt: 12345,
        });
      },
    });

    // 用例一：立即停止链先落 cancelled。
    const programA = makeProgram("/repos/stopped");
    const cycle = makeCycle(programA, "run-race-cancelled");
    await repo.insertProgram(programA);
    await repo.insertCycle(cycle);
    await suspendCycleForAgentNotification(
      {
        repository: repo,
        execution: settleDuringWire(cycle, "cancelled"),
        clock: { now: () => 99999 },
      },
      { cycle, program: programA, code: "budget_denied", message: "停止竞态内的拒绝通知" },
    );
    const stopped = (await repo.getCycle(cycle.id))!;
    assert.equal(stopped.status, "cancelled", "迟到通知不得把 cancelled 翻写回 suspended");
    assert.equal(
      stopped.pendingContinuationRequestId ?? null,
      null,
      "终局轮不挂继续确认指针（无幽灵确认）",
    );
    assert.equal(stopped.completedAt, 12345, "终局时间不被覆盖");

    // 用例二：桌面退出先保存 interrupted，恢复流程接管，通知同样不得翻写。
    const programB = makeProgram("/repos/interrupted");
    const cycleB = makeCycle(programB, "run-race-interrupted");
    await repo.insertProgram(programB);
    await repo.insertCycle(cycleB);
    await suspendCycleForAgentNotification(
      {
        repository: repo,
        execution: settleDuringWire(cycleB, "interrupted"),
        clock: { now: () => 99999 },
      },
      { cycle: cycleB, program: programB, code: "budget_denied", message: "退出竞态内的拒绝通知" },
    );
    const interrupted = (await repo.getCycle(cycleB.id))!;
    assert.equal(interrupted.status, "interrupted", "迟到通知不得把 interrupted 翻写回 suspended");
    assert.equal(interrupted.pendingContinuationRequestId ?? null, null);
  } finally {
    repo.close();
  }
});
