// CT-13 CLI 侧预算通信测试：
//   - 单请求尝试上限（retry_limit）有明确继续授权语义：挂起等待用户（释放并发座位、
//     不再触 inner/账本），授权后同一链获得新的尝试预算继续，不抛成 Run errored；
//   - 价格缺失/账本断联/旧执行权（pricing_missing/ledger_unreachable/lease_lost）返回
//     结构化需关注原因，不进入继续等待、不靠自动重试推进；
//   - budget_denied 携带真实 denial 观测（limitKind/已用/预留/unknown/当前限额/本请求
//     需求）透传给暂停通知（Host 据此组装 AskUserQuestion）；
//   - wire 端口：预留/结算请求携带身份四元组与 leaseEpoch（传输严格校验的 CLI 半边）。
// 运行入口：node scripts/test-continuous.mjs --suite integration。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousBudgetSuspensionResultSchema,
  continuousLedgerReserveResultSchema,
  continuousLedgerSettleResultSchema,
  type ContinuousRegisterManagedRunCommand,
} from "@zcode/shared/continuous-protocol";
import {
  createContinuousManagedRunStore,
  type ContinuousAgentWireRequest,
} from "../../src/app/continuous-registration.js";
import {
  ContinuousModelBudgetError,
  createContinuousModelBudgetGate,
  type ContinuousModelBudgetLedgerPort,
} from "../../src/app/continuous-model-budget.js";
import {
  createContinuousExecutionAdapter,
  type ContinuousRunServiceView,
} from "../../src/app/continuous-execution-adapter.js";
import type { ModelRequestAdmission, ModelRequestAdmissionTicket } from "@zcode/contracts";

/** 等待可观察事实的护栏：语义未实现时快速失败，而不是挂住整个测试进程。 */
async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

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

// ── 闸门级行为（不依赖 wire）──────────────────────────────────

function makeLedger(handler?: {
  reserve?: (
    request: Record<string, unknown>,
  ) => Promise<{ ok: true; requestKey: string } | { ok: false; code: string; message: string; denial?: unknown }>;
}) {
  const calls: Array<{ kind: "reserve" | "settle"; request: Record<string, unknown> }> = [];
  const ledger: ContinuousModelBudgetLedgerPort = {
    reserve: async (request) => {
      calls.push({ kind: "reserve", request: { ...request } });
      const override = await handler?.reserve?.(request as Record<string, unknown>);
      if (override) return override as never;
      return { ok: true, requestKey: request.requestKey };
    },
    settle: async (request) => {
      calls.push({ kind: "settle", request: { ...request } });
    },
  };
  return { calls, ledger };
}

function makeInner() {
  const state = { acquired: 0, released: 0 };
  const inner: ModelRequestAdmission = {
    acquire: async () => {
      state.acquired += 1;
      const ticket: ModelRequestAdmissionTicket = {
        publish: () => {},
        publishFailure: () => {},
        release: () => {
          state.released += 1;
        },
      };
      return ticket;
    },
  };
  return { state, inner };
}

test("CT-13 尝试上限继续授权语义：超限先等待用户（不占座位、不发请求），授权后同链获得新尝试预算", async () => {
  const { calls, ledger } = makeLedger();
  const { state, inner } = makeInner();
  let wake!: () => void;
  let parked!: () => void;
  const continuation = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const observedErrors: ContinuousModelBudgetError[] = [];
  const gate = createContinuousModelBudgetGate({
    programId: "prog-ct13",
    cycleId: "cycle-ct13",
    ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 2,
    suspension: {
      waitForContinuation: async (error) => {
        observedErrors.push(error);
        parked();
        await continuation;
      },
    },
  }).wrap(inner);
  const controller = new AbortController();
  // 两次尝试均以 retry_scheduled 终结（新 attempt 新 requestKey、逐次预留）。
  for (let attempt = 0; attempt < 2; attempt++) {
    const ticket = await gate.acquire({
      model: { providerId: "fixture", modelId: "fixture-model" },
      signal: controller.signal,
    });
    ticket.release();
  }
  assert.equal(calls.filter((call) => call.kind === "reserve").length, 2);
  // 第 3 次超限：不抛错，进入可取消的继续等待（明确继续授权语义，CT-13）。
  let failure: unknown;
  let ticket: Awaited<ReturnType<typeof gate.acquire>> | undefined;
  const pending = gate
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" }, signal: controller.signal })
    .then((acquired) => {
      ticket = acquired;
    })
    .catch((error: unknown) => {
      failure = error;
    });
  await withTimeout(paused, "尝试上限未进入继续等待（CT-13 语义未实现）");
  assert.equal(failure, undefined, "尝试上限不能抛成 Run errored（需用户确认）");
  assert.equal(observedErrors.length, 1);
  assert.equal(observedErrors[0]!.code, "retry_limit", "等待原因是结构化 retry_limit");
  const reservesWhileWaiting = calls.filter((call) => call.kind === "reserve").length;
  assert.equal(reservesWhileWaiting, 2, "等待用户期间不向账本预留（不发 provider 请求）");
  assert.equal(state.acquired, 2, "等待用户期间不占并发座位");
  // 用户授权继续：同一链获得新的尝试预算 → 正常预留并返回票据。
  wake();
  await pending;
  assert.equal(failure, undefined);
  assert.ok(ticket, "授权后原调用取得票据");
  assert.equal(
    calls.filter((call) => call.kind === "reserve").length,
    3,
    "授权后重新预留（新尝试预算）",
  );
  ticket!.release();
});

test("CT-13 尝试上限无装配时仍结构化拒绝（测试替身路径不变）", async () => {
  const { ledger } = makeLedger();
  const { inner } = makeInner();
  const gate = createContinuousModelBudgetGate({
    programId: "p",
    cycleId: "c",
    ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 1,
  }).wrap(inner);
  const controller = new AbortController();
  const first = await gate.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
    signal: controller.signal,
  });
  first.release();
  await assert.rejects(
    gate.acquire({ model: { providerId: "fixture", modelId: "fixture-model" }, signal: controller.signal }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "retry_limit",
  );
});

test("CT-13 需关注原因不等待、不自动重试：pricing_missing/ledger_unreachable/lease_lost 结构化抛出", async () => {
  let parked = 0;
  const suspension = {
    waitForContinuation: async () => {
      parked += 1;
    },
  };
  for (const code of ["pricing_missing", "ledger_unreachable", "lease_lost"] as const) {
    const { ledger } = makeLedger({
      reserve: async () => ({ ok: false, code, message: `mock ${code}` }),
    });
    const { state, inner } = makeInner();
    const gate = createContinuousModelBudgetGate({
      programId: "p",
      cycleId: "c",
      ledger,
      pricing: PRICING,
      requestCaps: CAPS,
      maxAttemptsPerRequest: 3,
      suspension,
    }).wrap(inner);
    await assert.rejects(
      gate.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
      (error: unknown) => error instanceof ContinuousModelBudgetError && error.code === code,
      `${code} 必须结构化上送（不进入继续等待）`,
    );
    assert.equal(parked, 0, `${code} 不触发继续等待（不是可扩额上限）`);
    assert.equal(state.released, 1, `${code} 释放 inner 座位`);
  }
});

test("CT-13 budget_denied 的真实 denial 观测透传到暂停等待（供拒绝通知组装）", async () => {
  const denial = {
    limitKind: "cycle_tokens",
    cycleSummary: {
      settledCostMicros: 0,
      reservedCostMicros: 0,
      unknownCostMicros: 151,
      settledTokens: 1_000,
      reservedTokens: 0,
      unknownTokens: 2_000,
    },
    currentLimit: { cycleCostMicros: 100_000_000, cycleTokens: 4_000, dailyCostMicros: null },
    request: { reservedCostMicros: 151, reservedTokens: 2_000 },
  };
  let approve = false;
  const { ledger } = makeLedger({
    reserve: async () =>
      approve
        ? { ok: true, requestKey: `rk-${Date.now()}` }
        : {
            ok: false,
            code: "budget_denied",
            message: "token limit",
            denial,
          },
  });
  const observed: ContinuousModelBudgetError[] = [];
  let wake!: () => void;
  const continuation = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const { inner } = makeInner();
  const gate = createContinuousModelBudgetGate({
    programId: "p",
    cycleId: "c",
    ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    suspension: {
      waitForContinuation: async (error) => {
        observed.push(error);
        await continuation;
      },
    },
  }).wrap(inner);
  let ticketRef: Awaited<ReturnType<typeof gate.acquire>> | undefined;
  const pending = gate
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } })
    .then((acquired) => {
      ticketRef = acquired;
    })
    .catch(() => "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(observed.length, 1, "budget_denied 应触发暂停等待");
  const carried = (observed[0] as { denial?: Record<string, unknown> }).denial;
  assert.ok(carried, "闸门错误携带真实 denial（不只错误文字）");
  assert.equal(carried!.limitKind, "cycle_tokens");
  assert.equal(
    (carried!.currentLimit as Record<string, number>).cycleTokens,
    4_000,
    "当前限额透传",
  );
  assert.equal(
    (carried!.request as Record<string, number>).reservedTokens,
    2_000,
    "本请求需求透传",
  );
  approve = true;
  wake();
  await pending;
  ticketRef?.release();
});

// ── wire 端口：身份与执行权版本随请求携带 ────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct13-cli-wire-"));
const outputRoot = join(tmpRoot, "outputs");
mkdirSync(outputRoot, { recursive: true });
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

function makePayload(): ContinuousRegisterManagedRunCommand {
  return {
    programId: nextId("program"),
    cycleId: nextId("cycle"),
    executionSessionId: nextId("session"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    executionPath: tmpRoot,
    workspacePath: tmpRoot,
    leaseEpoch: 7,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push", "merge"] },
    roles: { observer: "observer", builder: "builder", reviewer: "reviewer" },
    builderRole: "builder",
    declaredTestCommands: [],
    changeLimits: { maxFiles: 10, maxChangedLines: 400 },
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    maxConcurrentActors: 10,
    baseCommit: "f".repeat(40),
    outputRoot,
  };
}

function makeWire() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: ContinuousAgentWireRequest = async <T>(
    method: string,
    params: unknown,
    resultSchema: z.ZodType<T>,
  ) => {
    calls.push({ method, params });
    if (method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve) {
      return continuousLedgerReserveResultSchema.parse({
        ok: true,
        requestKey: (params as { requestKey: string }).requestKey,
      }) as T;
    }
    if (method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle) {
      return continuousLedgerSettleResultSchema.parse({ accepted: true }) as T;
    }
    if (method === CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension) {
      return continuousBudgetSuspensionResultSchema.parse({
        continuationRequestId: `cont-${calls.length}`,
      }) as T;
    }
    throw new Error(`unexpected wire method: ${method}`);
  };
  return { calls, request };
}

function makeAdapter() {
  const live = new Set<string>();
  const adapter = createContinuousExecutionAdapter({
    runService: {
      submitOnce: async () => {
        throw new Error("ct13 wire 测试不驱动真实提交");
      },
      cancel: async (runId: string) => live.delete(runId),
      waitForQuiescence: async () => {},
      isLiveRun: (runId: string) => live.has(runId),
    } as unknown as ContinuousRunServiceView,
    journal: {
      getRun: () => undefined,
      listActors: () => [],
      listEvents: () => [],
      listNodes: () => [],
    } as never,
    reportReader: { listSequencedReportItems: () => [] } as never,
  });
  return { adapter };
}

test("CT-13 wire 请求携带身份/执行权版本：reserve 带 leaseEpoch，settle 带归属三元组，denial 随拒绝通知上送", async () => {
  const wire = makeWire();
  const store = createContinuousManagedRunStore({ request: wire.request });
  const { adapter } = makeAdapter();
  store.bindExecutionAdapter({
    waitForAdmission: (ref, signal) => adapter.waitForAdmission(ref, signal),
    inspectHealth: (ref) => adapter.inspectHealth(ref),
    suspendAtSafeBoundary: (ref, reason) => adapter.suspendAtSafeBoundary(ref, reason),
  });
  const payload = makePayload();
  await store.applyRegistration(payload);
  const gate = store.modelBudgetGateFor(payload.workflowRunId)!.wrap(undefined);
  const ticket = await gate.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  const reserveCall = wire.calls.find(
    (call) => call.method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
  );
  assert.ok(reserveCall, "预留经 wire 上送 Host");
  assert.equal(
    (reserveCall!.params as { leaseEpoch?: number }).leaseEpoch,
    payload.leaseEpoch,
    "预留请求携带执行权版本（传输严格校验）",
  );
  assert.equal(
    (reserveCall!.params as { workflowRunId?: string }).workflowRunId,
    payload.workflowRunId,
    "预留请求携带执行身份 runId",
  );
  ticket.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settleCall = wire.calls.find(
    (call) => call.method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle,
  );
  assert.ok(settleCall, "票据结算经 wire 上送");
  const settleParams = settleCall!.params as {
    programId?: string;
    cycleId?: string;
    workflowRunId?: string;
  };
  assert.equal(settleParams.programId, payload.programId, "结算请求携带归属 programId");
  assert.equal(settleParams.cycleId, payload.cycleId, "结算请求携带归属 cycleId");
  assert.equal(settleParams.workflowRunId, payload.workflowRunId, "结算请求携带归属 runId");
  store.dispose();
});

test("CT-13 wire 拒绝通知：budget_denied 携带 denial 与 leaseEpoch，Host 合并确认的唯一输入", async () => {
  // 直接驱动 wireSuspensionWait 的产物面：经登记处拿不到内部函数，这里用断言重新组装的
  // 最小路径——登记处构造的闸门拒绝后，通知请求必须包含 leaseEpoch 与 denial。
  const wire = makeWire();
  let approve = false;
  const denial = {
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
  const request: ContinuousAgentWireRequest = async <T>(
    method: string,
    params: unknown,
    resultSchema: z.ZodType<T>,
  ) => {
    if (method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve && !approve) {
      return continuousLedgerReserveResultSchema.parse({
        ok: false,
        code: "budget_denied",
        message: "cycle cost limit",
        denial,
      }) as T;
    }
    return await wire.request(method, params, resultSchema);
  };
  const store = createContinuousManagedRunStore({ request });
  const { adapter } = makeAdapter();
  store.bindExecutionAdapter({
    waitForAdmission: (ref, signal) => adapter.waitForAdmission(ref, signal),
    inspectHealth: (ref) => adapter.inspectHealth(ref),
    suspendAtSafeBoundary: (ref, reason) => adapter.suspendAtSafeBoundary(ref, reason),
  });
  const payload = makePayload();
  await store.applyRegistration(payload);
  const gate = store.modelBudgetGateFor(payload.workflowRunId)!.wrap(undefined);
  const pending = gate.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const suspensionCall = wire.calls.find(
    (call) => call.method === CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension,
  );
  assert.ok(suspensionCall, "拒绝通知已发 Host");
  const params = suspensionCall!.params as {
    leaseEpoch?: number;
    code?: string;
    denial?: { limitKind: string };
  };
  assert.equal(params.leaseEpoch, payload.leaseEpoch, "拒绝通知携带执行权版本");
  assert.equal(params.code, "budget_denied");
  assert.equal(params.denial?.limitKind, "cycle_cost", "拒绝通知携带真实 limitKind");
  // 解冻后原调用完成（不悬挂进程）：授权后预留放行。
  approve = true;
  await adapter.resumeSuspended(
    {
      cycleId: payload.cycleId,
      executionSessionId: payload.executionSessionId,
      workflowRunId: payload.workflowRunId,
      traceId: payload.traceId,
    },
    payload.leaseEpoch,
  );
  const ticket = await pending;
  ticket.release();
  store.dispose();
});
