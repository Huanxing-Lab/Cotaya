// CT-04 模型预算闸门测试：闸门与 ModelRequestAdmission 接缝的接合（预留先于 provider、
// 尝试上限、价格缺失拒绝、票据结算事件汇、unknown 兜底、Host 断联拒绝、inner 转发），
// 以及 run service 的 wrapModelRequestAdmission 接缝 wiring（managed run 的 actor 准入端口
// 被闸门包装；覆盖 turn/工具/压缩的全部模型句柄是端口绑定的结构性事实——contracts 的
// ModelRequestAdmission 注释：runtime 交出的每一个模型句柄都带它）。
// 用例对应：U-05（请求 3 次、上限拒绝）、I-07（票据结算幂等语义的闸门侧）、E-08（超额请求
// 未发 provider）、E-10（不存在无限自动重试）、§9 断联语义。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node.test；wiring 用
// 真实 SQLite session store + 真实 harness 子进程）。

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { DwfSequencedReportQueries } from "@zcode/adapters/storage";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import type { TraceContext } from "@zcode/contracts";
import { createContinuousExecutionAdapter } from "../../src/app/continuous-execution-adapter.js";
import { createDynamicWorkflowRunService } from "../../src/app/dynamic-workflow-run-service.js";
import {
  ContinuousModelBudgetError,
  createContinuousModelBudgetGate,
  type ContinuousModelBudgetLedgerPort,
  type ContinuousModelBudgetGateDeps,
} from "../../src/app/continuous-model-budget.js";

test("发布2.1：预算拒绝等待用户继续，不把同一模型调用抛成不可恢复失败", async () => {
  let approved = false;
  let wake!: () => void;
  const continuation = new Promise<void>((resolve) => {
    wake = resolve;
  });
  let reachedPause!: () => void;
  const paused = new Promise<void>((resolve) => {
    reachedPause = resolve;
  });
  const recorder = makeLedger({
    reserve: () =>
      approved ? { ok: true } : { ok: false, code: "budget_denied", message: "needs continuation" },
  });
  const inner = makeInner();
  const gate = createContinuousModelBudgetGate({
    programId: "regression-program",
    cycleId: "regression-cycle",
    ledger: recorder.ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    ...{
      suspension: {
        waitForContinuation: async () => {
          reachedPause();
          await continuation;
        },
      },
    },
  }).wrap(inner.inner);
  let failure: unknown;
  const pending = gate
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } })
    .catch((error: unknown) => {
      failure = error;
      return undefined;
    });
  await Promise.race([paused, pending]);
  assert.equal(failure, undefined, "预算拒绝不能逃到driver导致Run errored");
  assert.equal(inner.state.released, 1, "等用户时不能占并发座位");
  approved = true;
  wake();
  const ticket = await pending;
  assert.ok(ticket, "授权后原调用继续取得票据");
  ticket.release();
});

// ── 替身：账本 / inner 准入 ───────────────────────────────────

interface LedgerCall {
  kind: "reserve" | "settle";
  request: Record<string, unknown>;
}

function makeLedger(handler?: {
  reserve?: (
    request: Record<string, unknown>,
  ) => { ok: true } | { ok: false; code: string; message: string };
}) {
  const calls: LedgerCall[] = [];
  const ledger: ContinuousModelBudgetLedgerPort = {
    reserve: async (request) => {
      calls.push({ kind: "reserve", request: { ...request } });
      const override = handler?.reserve?.(request);
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
  const state = { acquired: 0, released: 0, published: 0, publishedFailure: 0 };
  const inner: ModelRequestAdmission = {
    tryAcquire: () => {
      throw new Error("预算闸门包装下不应走 inner 快路径");
    },
    acquire: async () => {
      state.acquired += 1;
      const ticket: ModelRequestAdmissionTicket = {
        publish: () => {
          state.published += 1;
        },
        publishFailure: () => {
          state.publishedFailure += 1;
        },
        release: () => {
          state.released += 1;
        },
      };
      return ticket;
    },
  };
  return { state, inner };
}

const PRICING = {
  pricingVersion: "prices-ct04",
  prices: [
    {
      providerId: "fixture",
      modelId: "fixture-model",
      inputMicrosPerMillionTokens: 333,
      outputMicrosPerMillionTokens: 150_000,
    },
  ],
};
const CAPS = { inputTokenCap: 1_000, outputTokenCap: 1_000 };

function makeGate(ledger: ContinuousModelBudgetLedgerPort) {
  return createContinuousModelBudgetGate({
    programId: "prog-1",
    cycleId: "cycle-1",
    ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
  });
}

/** runner 状态事件的骨架（票据事件汇只读这些字段）。 */
function statusEvent(
  type: ModelNetworkStatusEvent["type"],
  extra: Partial<ModelNetworkStatusEvent> = {},
): ModelNetworkStatusEvent {
  return {
    timestamp: new Date().toISOString(),
    traceId: "t" as never,
    requestId: "req",
    providerId: "fixture",
    modelId: "fixture-model",
    transport: "http",
    attempt: 1,
    maxAttempts: 0,
    type,
    ...extra,
  } as ModelNetworkStatusEvent;
}

// ── 闸门行为 ─────────────────────────────────────────────────

// ── 准许冻结接缝（评审修复）──────────────────────────────────

test("admissionProbe：挂起/撤销后新请求在最前置点被 admission_closed 拒绝，不触 inner、不占额度", async () => {
  const { calls, ledger } = makeLedger();
  const { state, inner } = makeInner();
  let admissionState: "open" | "suspended" | "revoked" = "open";
  const gate = createContinuousModelBudgetGate({
    programId: "prog-1",
    cycleId: "cycle-1",
    ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    admissionProbe: async () => ({ admissionState }),
  });
  const wrapped = gate.wrap(inner);
  // open：正常放行（inner + 预留都发生）。
  await wrapped.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  assert.equal(state.acquired, 1);
  // 挂起（suspendAtSafeBoundary 后）：新请求在 inner/预留之前拒绝——「适配器已冻结而
  // Host 账本行尚未推进」的竞态窗口被本地硬执行点封死（§6.1 挂起冻结新请求）。
  admissionState = "suspended";
  await assert.rejects(
    wrapped.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "admission_closed",
  );
  // 用户停止（stop → revoked）：同拒绝。
  admissionState = "revoked";
  await assert.rejects(
    wrapped.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "admission_closed",
  );
  assert.equal(state.acquired, 1, "冻结后的请求不触 inner（不占座位）");
  assert.equal(
    calls.filter((call) => call.kind === "reserve").length,
    1,
    "冻结后的请求不向 Host 账本预留额度",
  );
});

test("闸门 acquire：先过 inner、再原子预留；整数微美元向上取整；不提供 tryAcquire 快路径", async () => {
  const { calls, ledger } = makeLedger();
  const { state, inner } = makeInner();
  const gate = makeGate(ledger);
  const wrapped = gate.wrap(inner);
  assert.equal("tryAcquire" in wrapped, false, "预算闸门无快路径（runner 直接 await acquire）");
  const ticket = await wrapped.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
  });
  assert.equal(state.acquired, 1, "inner 先取得票据");
  const reserve = calls.find((call) => call.kind === "reserve")!.request;
  assert.equal(reserve.pricingVersion, "prices-ct04");
  assert.equal(reserve.programId, "prog-1");
  assert.equal(reserve.cycleId, "cycle-1");
  // 保守预留 = ceil(333×1000/1e6) + ceil(150000×1000/1e6) = 1 + 150。
  assert.equal(reserve.reservedCostMicros, 151);
  assert.equal(reserve.reservedTokens, 2_000);
  assert.ok(ticket);
  // completed（带 usage）→ 幂等结算实际值；事件同时转发给 inner。
  ticket.publish(
    statusEvent("model_request_completed", {
      usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.published, 1, "票据事件转发给 inner（治理器不失明）");
  const settle = calls.find((call) => call.kind === "settle")!.request;
  assert.equal(settle.state, "settled");
  assert.equal(settle.actualTokens, 500);
  // ceil(333×400/1e6)=1 + ceil(150000×100/1e6)=15 → 16 微美元（整数、向上取整）。
  assert.equal(settle.estimatedCostMicros, 16);
  ticket.release();
  assert.equal(state.released, 1, "release 传导到 inner");
  const settles = calls.filter((call) => call.kind === "settle");
  assert.equal(settles.length, 1, "重复终局事件不重复结算（票据内幂等）");
});

test("预算拒绝/价格缺失/断联：请求不发给 provider，inner 票据释放", async () => {
  // budget_denied：ledger 拒绝 → acquire reject + inner 票据释放。
  const denied = makeLedger({
    reserve: () => ({ ok: false, code: "budget_denied", message: "额度已满" }),
  });
  const deniedInner = makeInner();
  const deniedGate = makeGate(denied.ledger).wrap(deniedInner.inner);
  await assert.rejects(
    deniedGate.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "budget_denied",
  );
  assert.equal(deniedInner.state.released, 1, "拒绝路径释放 inner 票据（不占治理器槽位）");
  assert.equal(denied.calls.filter((call) => call.kind === "settle").length, 0, "未发请求无结算");

  // pricing_missing：快照无该模型单价 → fail-closed。
  const missing = makeLedger();
  const missingInner = makeInner();
  const missingGate = makeGate(missing.ledger).wrap(missingInner.inner);
  await assert.rejects(
    missingGate.acquire({ model: { providerId: "fixture", modelId: "unknown-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "pricing_missing",
  );
  assert.equal(missing.calls.length, 0, "价格缺失不触账本");
  assert.equal(missingInner.state.released, 1);

  // ledger_unreachable（Host 断联）：新请求拒绝，不在本地扩额。
  const offline = makeLedger({
    reserve: () => ({ ok: false, code: "ledger_unreachable", message: "host 不可达" }),
  });
  const offlineInner = makeInner();
  const offlineGate = makeGate(offline.ledger).wrap(offlineInner.inner);
  await assert.rejects(
    offlineGate.acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "ledger_unreachable",
  );

  // admission_closed（cycle 挂起）。
  const suspended = makeLedger({
    reserve: () => ({ ok: false, code: "admission_closed", message: "cycle suspended" }),
  });
  await assert.rejects(
    makeGate(suspended.ledger)
      .wrap()
      .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "admission_closed",
  );
});

test("U-05/E-10 尝试上限：同一逻辑请求（同一 signal）最多 3 次，第 4 次拒绝且不再触 inner", async () => {
  const { calls, ledger } = makeLedger();
  const { state, inner } = makeInner();
  const wrapped = makeGate(ledger).wrap(inner);
  const controller = new AbortController();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ticket = await wrapped.acquire({
      model: { providerId: "fixture", modelId: "fixture-model" },
      signal: controller.signal,
    });
    // 每次尝试以 retry_scheduled 终结（无 usage → unknown 保留；新 attempt 新 requestKey）。
    ticket.publish(statusEvent("model_retry_scheduled", { nextAttempt: attempt + 1 }));
    ticket.release();
  }
  assert.equal(state.acquired, 3);
  assert.equal(calls.filter((call) => call.kind === "reserve").length, 3, "逐次预留");
  const unknowns = calls.filter(
    (call) => call.kind === "settle" && call.request.state === "unknown",
  );
  assert.equal(unknowns.length, 3, "重试的旧尝试无 usage 证据 → unknown 保留");
  // 第 4 次（Unbounded retry 预算下 runner 会继续）→ retry_limit，inner 不再被触碰。
  await assert.rejects(
    wrapped.acquire({
      model: { providerId: "fixture", modelId: "fixture-model" },
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof ContinuousModelBudgetError && error.code === "retry_limit",
  );
  assert.equal(state.acquired, 3, "超限尝试不再进 inner（不存在无限自动重试）");
  // 新逻辑请求（新 signal）：attempt 计数重新开始。
  const fresh = new AbortController();
  const ticket = await wrapped.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
    signal: fresh.signal,
  });
  ticket.publish(
    statusEvent("model_request_completed", {
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    calls.filter((call) => call.kind === "reserve").length,
    4,
    "新请求链不受旧链计数影响",
  );
});

test("票据终局分类：completed 无 usage→unknown；failed(connect)→结零；failed(其他)/release 兜底→unknown", async () => {
  // completed 但 provider 未回报 usage → unknown。
  const noUsage = makeLedger();
  const t1 = await makeGate(noUsage.ledger)
    .wrap()
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  t1.publish(statusEvent("model_request_completed"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(noUsage.calls.find((call) => call.kind === "settle")!.request.state, "unknown");

  // connect 阶段失败（请求未发出）→ 结零。
  const connectFail = makeLedger();
  const t2 = await makeGate(connectFail.ledger)
    .wrap()
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  t2.publish(
    statusEvent("model_request_failed", {
      reason: "connect_error",
      retryable: true,
      message: "x",
      errorPhase: "connect",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const zero = connectFail.calls.find((call) => call.kind === "settle")!.request;
  assert.equal(zero.state, "settled");
  assert.equal(zero.estimatedCostMicros, 0);

  // 非 connect 失败（流中断等，provider 可能已处理）→ unknown。
  const streamFail = makeLedger();
  const t3 = await makeGate(streamFail.ledger)
    .wrap()
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  t3.publish(
    statusEvent("model_request_failed", { reason: "stream_error", retryable: false, message: "x" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(streamFail.calls.find((call) => call.kind === "settle")!.request.state, "unknown");

  // release 兜底（未见任何终结事件，如消费者提前放弃流）→ unknown；publishFailure 只转发。
  const ghost = makeLedger();
  const ghostInner = makeInner();
  const t4 = await makeGate(ghost.ledger)
    .wrap(ghostInner.inner)
    .acquire({ model: { providerId: "fixture", modelId: "fixture-model" } });
  t4.publishFailure(
    statusEvent("model_request_failed", { reason: "x", retryable: true, message: "x" }),
    new Error("transport"),
  );
  t4.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ghostInner.state.publishedFailure, 1, "publishFailure 转发给 inner");
  assert.equal(ghost.calls.find((call) => call.kind === "settle")!.request.state, "unknown");
});

test("caps 非法在构造期失败：不能限制请求就不该在费用限额下自动执行", () => {
  const { ledger } = makeLedger();
  assert.throws(
    () =>
      createContinuousModelBudgetGate({
        programId: "p",
        cycleId: "c",
        ledger,
        pricing: PRICING,
        requestCaps: { inputTokenCap: 0, outputTokenCap: 100 },
        maxAttemptsPerRequest: 3,
      }),
    (error: unknown) =>
      error instanceof ContinuousModelBudgetError && error.code === "caps_invalid",
  );
});

// ── wiring：run service 的 wrapModelRequestAdmission 接缝（真实 service + harness 子进程）──

/** 带 ask 的脚本：引擎必须创建 actor 会话（ask-free 脚本不会走到 runtimeFactory）。 */
const ASK_SCRIPT = `
const probe = agent("budget-probe");
const answer = await probe.ask("reply with ok");
return { answer };
`;

interface WiringHarness {
  root: string;
  journal: JournalStorePort & DwfSequencedReportQueries;
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  recorded: { runId: string; admission: ModelRequestAdmission | undefined }[];
  dispose: () => void;
}

/** 等待可观察事实（journal 行的终态），不用 sleep 猜时序。 */
async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeWiringHarness(
  gateLedger: ContinuousModelBudgetLedgerPort,
  options?: {
    suspension: NonNullable<ContinuousModelBudgetGateDeps["suspension"]>;
    admissionProbe: NonNullable<ContinuousModelBudgetGateDeps["admissionProbe"]>;
    onProvider: () => void;
  },
): WiringHarness {
  const root = mkdtempSync(join(tmpdir(), "continuous-ct04-runtime-"));
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  const journal = store.workflowJournalStore() as JournalStorePort & DwfSequencedReportQueries;
  const fileSystemPort = createNodeFileSystemAdapter();
  const executionPort = {
    run: async (): Promise<never> => {
      throw new Error("CT-04 wiring 脚本不执行 world.run");
    },
  };
  const recorded: { runId: string; admission: ModelRequestAdmission | undefined }[] = [];
  const gate = createContinuousModelBudgetGate({
    programId: "prog-wiring",
    cycleId: "cycle-wiring",
    ledger: gateLedger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    ...(options ? { suspension: options.suspension, admissionProbe: options.admissionProbe } : {}),
  });
  const MANAGED_RUN_ID = "dwfrun-ct04-budget-wiring";
  const service = createDynamicWorkflowRunService({
    journal,
    parentSessionId: `app-${randomUUID()}`,
    fileSystemPort,
    executionPort,
    createActorRuntime: ({ runId, modelRequestAdmission, submitPort }) => {
      // 记录接缝产物即返回最小 stub：会话创建所需的最小面 + 任何真实使用都大声失败
      //（run 随后 errored 无妨——本测试只断言接线）。
      recorded.push({ runId, admission: modelRequestAdmission });
      return {
        getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture-model" }),
        ensureSessionPersistedForExternalActivity: async () => {},
        resumeFromStore: async () => {},
        executeTurn: options
          ? async (
              _input: string,
              _context: unknown,
              turnOptions: { abortSignal?: AbortSignal },
            ) => {
              const ticket = await modelRequestAdmission!.acquire({
                model: { providerId: "fixture", modelId: "fixture-model" },
                signal: turnOptions.abortSignal,
              });
              options.onProvider();
              ticket.release();
              await submitPort.respond({
                toolCallId: "budget-real-turn",
                result: "ok",
                trace: { traceId: "trace-ct04" as never },
              });
              return {
                response: "submitted",
                turnId: "budget-turn",
                traceId: "trace-ct04",
                events: [],
                projection: {},
              };
            }
          : () => Promise.reject(new Error("ct04 wiring stub: no real turns")),
        dispose: () => {},
      } as never;
    },
    wrapModelRequestAdmission: ({ runId, admission }) =>
      runId === MANAGED_RUN_ID ? gate.wrap(admission) : admission,
  });
  return {
    root,
    journal,
    service,
    recorded,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("wiring：managed run 的 actor 准入端口被预算闸门包装，预留经接缝真实发生", async (t) => {
  const ledgerRecorder: LedgerCall[] = [];
  const ledger: ContinuousModelBudgetLedgerPort = {
    reserve: async (request) => {
      ledgerRecorder.push({ kind: "reserve", request: { ...request } });
      return { ok: true, requestKey: request.requestKey };
    },
    settle: async (request) => {
      ledgerRecorder.push({ kind: "settle", request: { ...request } });
    },
  };
  const harness = makeWiringHarness(ledger);
  t.after(() => harness.dispose());
  const result = await harness.service.submitOnce({
    runId: "dwfrun-ct04-budget-wiring",
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: `app-${randomUUID()}`,
    trace: { traceId: "trace-ct04" as never } satisfies TraceContext,
  });
  assert.equal(result.ok, true);
  // 等 actor 会话被创建（真实 harness 子进程驱动引擎）。
  await waitFor(() => harness.recorded.length >= 1);
  assert.equal(harness.recorded.length, 1, "引擎为 ask 创建恰一个 actor 会话");
  const admission = harness.recorded[0]!.admission;
  assert.ok(admission, "managed run 的 actor 拿到包装后的准入端口");
  assert.equal("tryAcquire" in admission, false, "包装端口无快路径（闸门特征）");
  // 真实跑一次 acquire：经过接缝的预留必须落在账本端口上（provider 请求前的最后一步）。
  const ticket = await admission!.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
  });
  assert.equal(ledgerRecorder.length, 1);
  assert.equal(ledgerRecorder[0]!.request.cycleId, "cycle-wiring");
  assert.equal(ledgerRecorder[0]!.request.reservedCostMicros, 151);
  ticket.publish(
    statusEvent("model_request_completed", {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ledgerRecorder.length, 2, "结算事件汇经同一票据回路到账本");
  // 收尾：等 run 落终态（stub turn 同步失败 → errored）并等待执行静默，不悬挂进程。
  await waitFor(() => harness.journal.getRun("dwfrun-ct04-budget-wiring")?.status === "errored");
  await harness.service.waitForQuiescence("dwfrun-ct04-budget-wiring");
});

test("wiring：普通 submit（未登记 runId）的 actor 准入端口不经闸门", async (t) => {
  const ledgerRecorder: LedgerCall[] = [];
  const ledger: ContinuousModelBudgetLedgerPort = {
    reserve: async (request) => {
      ledgerRecorder.push({ kind: "reserve", request: { ...request } });
      return { ok: true, requestKey: request.requestKey };
    },
    settle: async (request) => {
      ledgerRecorder.push({ kind: "settle", request: { ...request } });
    },
  };
  const harness = makeWiringHarness(ledger);
  t.after(() => harness.dispose());
  const submitted = await harness.service.submit({
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: `app-${randomUUID()}`,
    trace: { traceId: "trace-normal" as never } satisfies TraceContext,
  });
  assert.equal(submitted.ok, true);
  await waitFor(() => harness.recorded.length >= 1);
  assert.equal(harness.recorded.length, 1);
  // 本装配没有治理器（deps.concurrency 缺席）→ 原始 admission 是 undefined；
  // 闸门没有凭空造一个：普通 run 与 CT-04 之前逐字相同。
  assert.equal(harness.recorded[0]!.admission, undefined);
  assert.equal(ledgerRecorder.length, 0, "未登记的 run 不触预算账本");
  await waitFor(() => harness.journal.getRun(submitted.runId)?.status === "errored");
  await harness.service.waitForQuiescence(submitted.runId);
});

test("发布2.1：真实 DWF 引擎预算等待保持 running，授权后同 Run 完成", async (t) => {
  let approved = false;
  let suspended = false;
  let providers = 0;
  let wake!: () => void;
  let parked!: () => void;
  const continuation = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const ledger = makeLedger({
    reserve: () =>
      approved ? { ok: true } : { ok: false, code: "budget_denied", message: "budget" },
  });
  const harness = makeWiringHarness(ledger.ledger, {
    admissionProbe: async () => ({ admissionState: suspended ? "suspended" : "open" }),
    suspension: {
      waitForContinuation: async () => {
        suspended = true;
        parked();
        await continuation;
      },
    },
    onProvider: () => {
      providers++;
    },
  });
  t.after(() => harness.dispose());
  const runId = "dwfrun-ct04-budget-wiring";
  await harness.service.submitOnce({
    runId,
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: "budget-parent",
    trace: { traceId: "trace-ct04" as never },
  });
  await Promise.race([
    paused,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("未进入预算等待")), 15_000);
      timer.unref();
    }),
  ]);
  assert.equal(harness.journal.getRun(runId)?.status, "running", "没有 errored 终态");
  assert.equal(providers, 0, "未获授权不发请求");
  approved = true;
  suspended = false;
  wake();
  await waitFor(() => harness.journal.getRun(runId)?.status === "completed");
  await harness.service.waitForQuiescence(runId);
  assert.equal(providers, 1);
  assert.equal(harness.recorded.length, 1, "原 actor、原 Run，无重启");
});

test("发布2.1：预算等待收到停止信号立即取消，不等待用户回答", async () => {
  const controller = new AbortController();
  let parked!: () => void;
  const paused = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const inner = makeInner();
  const ledger = makeLedger({
    reserve: () => ({ ok: false, code: "budget_denied", message: "budget" }),
  });
  const gate = createContinuousModelBudgetGate({
    programId: "p",
    cycleId: "c",
    ledger: ledger.ledger,
    pricing: PRICING,
    requestCaps: CAPS,
    maxAttemptsPerRequest: 3,
    suspension: {
      waitForContinuation: async () => {
        parked();
        await new Promise<void>(() => {});
      },
    },
  }).wrap(inner.inner);
  const pending = gate.acquire({
    model: { providerId: "fixture", modelId: "fixture-model" },
    signal: controller.signal,
  });
  await paused;
  controller.abort(new Error("用户停止"));
  await assert.rejects(pending, /用户停止/);
  assert.equal(inner.state.released, 1);
});

test("发布2.1：退出中断真实预算等待，Run stopped/interrupted 且工具完成收尾", async (t) => {
  let parked!: () => void;
  const paused = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const ledger = makeLedger({
    reserve: () => ({ ok: false, code: "budget_denied", message: "budget" }),
  });
  const harness = makeWiringHarness(ledger.ledger, {
    admissionProbe: async () => ({ admissionState: "open" }),
    suspension: {
      waitForContinuation: async () => {
        parked();
        await new Promise<void>(() => {});
      },
    },
    onProvider: () => assert.fail("退出前后都没有授权，不能调用 provider"),
  });
  t.after(() => harness.dispose());
  const runId = "dwfrun-ct04-budget-wiring";
  await harness.service.submitOnce({
    runId,
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: "budget-parent",
    trace: { traceId: "trace-ct04" as never },
  });
  await paused;
  const adapter = createContinuousExecutionAdapter({
    runService: harness.service,
    journal: harness.journal,
    reportReader: harness.journal,
  });
  await adapter.interrupt(
    {
      cycleId: "cycle-wiring",
      executionSessionId: "budget-parent",
      workflowRunId: runId,
      traceId: "trace-ct04",
    },
    1,
  );
  assert.equal(harness.journal.getRun(runId)?.status, "stopped");
  assert.equal(harness.journal.getRun(runId)?.stopReason, "interrupted");
});
