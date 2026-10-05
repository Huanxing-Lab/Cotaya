// CT-12 登记处测试：continuousManagedRunStore 把 Host 下发的冻结事实（wire schema 在
// shared continuous-registration-protocol）变成 CLI 进程内的预算/决策/IO 端口并按 Run ID
// 登记。用例对应 ticket CT-12 的 CLI 侧半边：
//   - 登记成功：三类端口就位（modelBudgetGateFor/decisionGateFor/executionPolicyFor）、
//     执行路径绑定、并发上限来自冻结配置（引擎 caps 用）；
//   - 登记 → submitOnce 守卫链：requireContinuousManagedGuards 通过（未登记拒绝的既有
//     断言在 release-gaps.test.ts，此处证明登记后放行）；
//   - 能力协商回音：operations 覆盖全部必需操作（含 interrupt）；
//   - 载荷校验：请求上限非正/价格表为空结构化拒绝（registration_invalid）；leaseEpoch
//     回退拒绝；重复登记（恢复/继续前重发）幂等；
//   - 预算闸门经 wire 账本预留/结算（真请求路径经注入的 request 替身），拒绝触发
//     拒绝通知 + 等待解冻（与执行适配器共享同一准入）。
// 运行入口：node scripts/test-continuous.mjs --suite integration。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  CONTINUOUS_AGENT_REQUEST_METHODS,
  continuousBudgetSuspensionResultSchema,
  continuousLedgerReserveResultSchema,
  continuousLedgerSettleResultSchema,
  supportsContinuousCliManagedOperations,
  type ContinuousRegisterManagedRunCommand,
} from "@zcode/shared/continuous-protocol";
import type { ContinuousPriceSnapshot } from "@zcode/shared/continuous-protocol";
import {
  createContinuousManagedRunStore,
  type ContinuousAgentWireRequest,
} from "../../src/app/continuous-registration.js";
import { requireContinuousManagedGuards } from "../../src/app/continuous-managed-guards.js";
import {
  createContinuousExecutionAdapter,
  type ContinuousExecutionContractError,
} from "../../src/app/continuous-execution-adapter.js";
import type { ContinuousRunServiceView } from "../../src/app/continuous-execution-adapter.js";

const PRICING: ContinuousPriceSnapshot = {
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
const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct12-registration-"));
const outputRoot = join(tmpRoot, "outputs");
mkdirSync(outputRoot, { recursive: true });
let objectCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(objectCounter += 1)}`;

function makePayload(overrides: Partial<ContinuousRegisterManagedRunCommand> = {}): ContinuousRegisterManagedRunCommand {
  return {
    programId: nextId("program"),
    cycleId: nextId("cycle"),
    executionSessionId: nextId("session"),
    workflowRunId: nextId("run"),
    traceId: nextId("trace"),
    executionPath: tmpRoot,
    workspacePath: tmpRoot,
    leaseEpoch: 1,
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
    ...overrides,
  };
}

/** 反向请求替身：记录 method/params 并按脚本应答。 */
function makeWire(script: {
  reserve?: (
    params: Record<string, unknown>,
  ) => { ok: true; requestKey: string } | { ok: false; code: string; message: string; denial?: unknown };
}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: ContinuousAgentWireRequest = async <T>(
    method: string,
    params: unknown,
    resultSchema: z.ZodType<T>,
  ) => {
    calls.push({ method, params });
    if (method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve) {
      const override = script.reserve?.(params as Record<string, unknown>);
      return continuousLedgerReserveResultSchema.parse(
        override ?? { ok: true, requestKey: (params as { requestKey: string }).requestKey },
      ) as T;
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

/** 最小执行适配器替身（run service/journal 缺席的窄视图；登记只绑定准入面）。 */
function makeRunServiceStub() {
  const live = new Set<string>();
  return {
    live,
    view: {
      submitOnce: async () => {
        throw new Error("registration.test 不驱动真实提交");
      },
      cancel: async (runId: string) => live.delete(runId),
      waitForQuiescence: async () => {},
      isLiveRun: (runId: string) => live.has(runId),
    } as unknown as ContinuousRunServiceView,
  };
}

function makeAdapter() {
  const stub = makeRunServiceStub();
  const adapter = createContinuousExecutionAdapter({
    runService: stub.view,
    journal: {
      getRun: () => undefined,
      listActors: () => [],
      listEvents: () => [],
      listNodes: () => [],
    } as never,
    reportReader: { listSequencedReportItems: () => [] } as never,
  });
  return { adapter, stub };
}

test("CT-12 CLI：登记把冻结事实变成三类端口；守卫链放行；能力词表含 interrupt", async () => {
  const wire = makeWire({});
  const store = createContinuousManagedRunStore({ request: wire.request });
  const { adapter } = makeAdapter();
  store.bindExecutionAdapter({
    waitForAdmission: (ref, signal) => adapter.waitForAdmission(ref, signal),
    inspectHealth: (ref) => adapter.inspectHealth(ref),
    suspendAtSafeBoundary: (ref, reason) => adapter.suspendAtSafeBoundary(ref, reason),
  });
  const payload = makePayload();
  const result = await store.applyRegistration(payload);
  assert.equal(result.workflowRunId, payload.workflowRunId);
  assert.ok(supportsContinuousCliManagedOperations(result.operations), "能力词表含 interrupt");
  // 三类端口按 Run ID 就位。
  assert.ok(store.modelBudgetGateFor(payload.workflowRunId)?.supportsSuspension);
  assert.ok(store.decisionGateFor(payload.workflowRunId));
  const io = store.executionPolicyFor(payload.workflowRunId);
  assert.ok(io);
  assert.equal(io.executionPath, payload.executionPath);
  // 角色授权来自受信载荷：builder 写面、未知角色只读。
  assert.equal(io.actorPolicyFor("builder").role, "builder");
  assert.equal(io.actorPolicyFor("whoever-unknown").role, "observer");
  // 并发上限来自冻结配置（引擎 caps 用），不能退回 CPU 默认。
  assert.equal(store.maxConcurrentActorsFor(payload.workflowRunId), 10);
  // 登记后 submitOnce 守卫链放行（同轮执行身份与真实工作目录）。
  requireContinuousManagedGuards(
    {
      modelBudgetGateFor: (runId) => store.modelBudgetGateFor(runId),
      decisionGateFor: (runId) => store.decisionGateFor(runId),
      executionPolicyFor: (runId) => store.executionPolicyFor(runId),
    },
    {
      programId: payload.programId,
      cycleId: payload.cycleId,
      executionSessionId: payload.executionSessionId,
      workflowRunId: payload.workflowRunId,
      traceId: payload.traceId,
      executionPath: payload.executionPath,
      scriptText: "return {};",
      scriptHash: "a".repeat(64),
      configurationSnapshot: {},
    },
  );
  // 未登记的 run 仍拒绝（fail closed 不变）。
  assert.throws(
    () =>
      requireContinuousManagedGuards(
        {
          modelBudgetGateFor: (runId) => store.modelBudgetGateFor(runId),
          decisionGateFor: (runId) => store.decisionGateFor(runId),
          executionPolicyFor: (runId) => store.executionPolicyFor(runId),
        },
        {
          programId: "p2",
          cycleId: "c2",
          executionSessionId: "s2",
          workflowRunId: "run-other",
          traceId: "t2",
          executionPath: payload.executionPath,
          scriptText: "return {};",
          scriptHash: "a".repeat(64),
          configurationSnapshot: {},
        },
      ),
    (error: unknown) => (error as ContinuousExecutionContractError).reason === "execution_identity_mismatch",
  );
  store.dispose();
});

test("CT-12 CLI：载荷校验拒绝（上限非正/价格表为空/leaseEpoch 回退）；同轮重发幂等", async () => {
  const wire = makeWire({});
  const store = createContinuousManagedRunStore({ request: wire.request });
  await assert.rejects(
    store.applyRegistration(makePayload({ requestCaps: { inputTokenCap: 0, outputTokenCap: 100 } })),
    (error: unknown) => (error as { reason?: string }).reason === "registration_invalid",
  );
  await assert.rejects(
    store.applyRegistration(makePayload({ pricing: { pricingVersion: "x", prices: [] } })),
    (error: unknown) => (error as { reason?: string }).reason === "registration_invalid",
  );
  const payload = makePayload();
  await store.applyRegistration(payload);
  await assert.rejects(
    store.applyRegistration(makePayload({ ...payload, leaseEpoch: 0 })),
    (error: unknown) => (error as { reason?: string }).reason === "registration_invalid",
    "leaseEpoch 回退拒绝（旧执行权不可写）",
  );
  // 同轮重发（恢复/继续前 Host 重建登记）：幂等成功。
  const again = await store.applyRegistration(makePayload({ ...payload }));
  assert.equal(again.workflowRunId, payload.workflowRunId);
  store.dispose();
});

test("CT-12 CLI：预算闸门经 wire 预留/结算；拒绝触发拒绝通知并等待同一所有者解冻", async () => {
  let approve = false;
  let wake!: () => void;
  const unfrozen = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const wire = makeWire({
    reserve: (params) =>
      approve
        ? { ok: true, requestKey: params.requestKey as string }
        : { ok: false, code: "budget_denied", message: "cycle cost limit", denial: {
            limitKind: "cycle_cost",
            cycleSummary: {
              settledCostMicros: 0,
              reservedCostMicros: 0,
              unknownCostMicros: 0,
              settledTokens: 0,
              reservedTokens: 0,
              unknownTokens: 0,
            },
            currentLimit: {
              cycleCostMicros: 100_000_000,
              cycleTokens: 1_000_000_000,
              dailyCostMicros: 1_000_000_000,
            },
            request: { reservedCostMicros: 3, reservedTokens: 2_000 },
          } },
  });
  const store = createContinuousManagedRunStore({ request: wire.request });
  const { adapter, stub } = makeAdapter();
  store.bindExecutionAdapter({
    waitForAdmission: (ref, signal) => adapter.waitForAdmission(ref, signal),
    inspectHealth: (ref) => adapter.inspectHealth(ref),
    suspendAtSafeBoundary: (ref, reason) => adapter.suspendAtSafeBoundary(ref, reason),
  });
  const payload = makePayload();
  await store.applyRegistration(payload);
  const gate = store.modelBudgetGateFor(payload.workflowRunId)!.wrap(undefined);
  let ticket: Awaited<ReturnType<typeof gate.acquire>> | undefined;
  let failure: unknown;
  const pending = gate
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } })
    .then((acquired) => {
      ticket = acquired;
    })
    .catch((error: unknown) => {
      failure = error;
    });
  // 等待拒绝通知发出（wire 上出现 budget/suspend）。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(failure, undefined, "预算拒绝不逃成调用方失败");
  assert.ok(
    wire.calls.some((call) => call.method === CONTINUOUS_AGENT_REQUEST_METHODS.budgetSuspension),
    "拒绝通知已发 Host（保存暂停与继续确认）",
  );
  assert.equal(ticket, undefined, "用户未授权前不得取得票据");
  // Host 授权后的解冻：resumeSuspended 语义 → 本地准入 open + 唤醒等待。
  await adapter.resumeSuspended(
    {
      cycleId: payload.cycleId,
      executionSessionId: payload.executionSessionId,
      workflowRunId: payload.workflowRunId,
      traceId: payload.traceId,
    },
    payload.leaseEpoch,
  );
  approve = true;
  wake();
  await pending;
  assert.ok(ticket, "授权并解冻后原调用取得票据");
  ticket!.release();
  assert.ok(
    wire.calls.some(
      (call) =>
        call.method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerSettle ||
        call.method === CONTINUOUS_AGENT_REQUEST_METHODS.ledgerReserve,
    ),
    "票据结算事件汇经 wire 上送 Host 账本",
  );
  assert.equal(stub.live.size, 0);
  store.dispose();
});
