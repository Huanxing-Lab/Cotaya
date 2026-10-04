// CT-03 受控执行单元/集成测试：I-05（submitOnce 重发与不同内容拒绝）、I-06（Run 结束但
// 工具/usage 未结束不提前收尾）、R-01（提交前 kill 后同身份续交）、R-02（ACK 丢失只有一个
// Run）、R-05（completed 后 kill：settling 收尾、不 resume、不新 Run）。用例定义见
// docs/testing/continuous.md §6/§7。
//
// 两层事实来源：
//   - 真实链路（I-05/R-01/R-02/R-05 的执行事实）：真实 SQLite session store（dwf_* 表）、
//     真实 run service、真实 harness 子进程执行 ask-free 脚本（report 落 journal 事件）；
//     「kill」以在**同一 journal 上构造新 service/适配器**模拟——进程死了，注册表没了，行还在。
//   - 替身链路（停止顺序/挂起语义/epoch 守卫）：注入 run service 窄视图替身记录调用顺序，
//     测的是适配器自身的裁决逻辑，不是被替掉的 service。
//
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { DwfSequencedReportQueries } from "@zcode/adapters/storage";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  createDynamicWorkflowRunService,
  supportsSequencedReportReads,
} from "../../src/app/dynamic-workflow-run-service.js";
import { createRunServiceLifecycle } from "../../src/app/dynamic-workflow-run-lifecycle.js";
import {
  ContinuousExecutionError,
  createContinuousExecutionAdapter,
  type ContinuousRunServiceView,
  type ExecutionReference,
  type ManagedCycleInput,
} from "../../src/app/continuous-execution-adapter.js";
import type { RunRegistryEntry } from "../../src/app/dynamic-workflow-run-observation.js";

// ── 共享 fixture ──────────────────────────────────────────────

/** ask-free 脚本：三份报告（两份 ContinuousReportV1 形状 + 一份非 V1）+ 顶层返回值。 */
const SCRIPT = `
log("continuous cycle probe");
report({ kind: "candidate", itemKey: "cand-header", title: "Header spacing" });
report({ kind: "decision", itemKey: "dec-settings", title: "Settings navigation" });
report("plain-string-item");
return { outcome: "changes_verified" };
`;

/** 直接抛错的脚本：制造 errored 终态（resume 拒绝词表的证物）。 */
const FAILING_SCRIPT = `
throw new Error("boom");
`;

function hashOf(scriptText: string): string {
  return createHash("sha256").update(scriptText, "utf8").digest("hex");
}

interface RealHarness {
  root: string;
  journal: JournalStorePort & DwfSequencedReportQueries;
  appSessionId: string;
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  adapter: ReturnType<typeof createContinuousExecutionAdapter>;
  /** 在同一 journal 上构造「下一个进程」的 service+adapter（kill 模拟）。 */
  nextProcess(): {
    service: ReturnType<typeof createDynamicWorkflowRunService>;
    adapter: ReturnType<typeof createContinuousExecutionAdapter>;
  };
  dispose(): void;
}

function makeRealHarness(): RealHarness {
  const root = mkdtempSync(join(tmpdir(), "continuous-ct03-"));
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  const journal = store.workflowJournalStore() as JournalStorePort & DwfSequencedReportQueries;
  const fileSystemPort = createNodeFileSystemAdapter();
  const executionPort = {
    // ask-free 脚本不执行 world.run；到达即接线错误。
    run: async (): Promise<never> => {
      throw new Error("execution port is not expected in ask-free CT-03 scripts");
    },
  };
  const build = () => {
    const service = createDynamicWorkflowRunService({
      journal,
      parentSessionId: `app-${randomUUID()}`,
      fileSystemPort,
      executionPort,
      createActorRuntime: () => {
        throw new Error("ask-free CT-03 scripts never create actor runtimes");
      },
    });
    const adapter = createContinuousExecutionAdapter({
      runService: service,
      journal,
      reportReader: journal,
      reportPageSize: 4,
    });
    return { service, adapter };
  };
  const first = build();
  return {
    root,
    journal,
    appSessionId: "",
    service: first.service,
    adapter: first.adapter,
    nextProcess: build,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeInput(overrides: Partial<ManagedCycleInput> = {}): ManagedCycleInput {
  const id = randomUUID();
  return {
    programId: `prog-${id}`,
    cycleId: `cycle-${id}`,
    executionSessionId: `ctexec-${id}`,
    workflowRunId: `ctrun-${id}`,
    traceId: `trace-${id}`,
    executionPath: "", // 由 harness 按 temp root 填充
    scriptText: SCRIPT,
    scriptHash: hashOf(SCRIPT),
    configurationSnapshot: { template: "ui-ux-v1" },
    ...overrides,
  };
}

/** 等待一个谓词为真（observable state 轮询，有界；不用裸 sleep 表达时序）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function rejectsWith(
  promise: Promise<unknown>,
  reason: string,
): Promise<ContinuousExecutionError> {
  return await assert.rejects(promise, (error: unknown): error is ContinuousExecutionError => {
    assert.ok(error instanceof ContinuousExecutionError, "expected ContinuousExecutionError");
    assert.equal(error.reason, reason);
    return true;
  });
}

// ── I-05：submitOnce 重发 / 不同内容拒绝 / session 绑定可恢复 ────────────────

test("I-05: submitOnce 同 ID 同内容重发只执行一次，报告不重复", async () => {
  const harness = makeRealHarness();
  try {
    const input = makeInput({ executionPath: harness.root });
    const ref = await harness.adapter.submitOnce(input);
    assert.equal(ref.workflowRunId, input.workflowRunId);
    assert.equal(ref.executionSessionId, input.executionSessionId);

    // ACK 丢失语义：同身份重发 → 同一个 run，绝不铸第二个。
    const resubmitted = await harness.adapter.submitOnce(input);
    assert.deepEqual(resubmitted, ref);

    await harness.adapter.waitForQuiescence(ref);
    await waitFor(() => harness.adapter.inspect(ref).then((state) => state.status === "completed"));

    // 一次执行的证据：run-started 事件恰好一条；报告各一条、无重发副本。
    const events = harness.journal.listEvents(ref.workflowRunId);
    const runStarted = events.filter((event) => event.event.type === "run-started");
    assert.equal(runStarted.length, 1);
    const batch = await harness.adapter.readReports(ref, 0);
    assert.equal(batch.items.length, 3);
    assert.equal(batch.items.filter((item) => item.itemKey === "cand-header").length, 1);
  } finally {
    harness.dispose();
  }
});

test("I-05: 相同 ID 不同 script/args/owner 与绑定 hash 不符均被拒绝", async () => {
  const harness = makeRealHarness();
  try {
    const input = makeInput({ executionPath: harness.root });
    await harness.adapter.submitOnce(input);

    // 不同 hash（脚本文本变了）：
    await rejectsWith(
      harness.adapter.submitOnce({
        ...input,
        scriptText: `${SCRIPT}\nlog("extra");`,
        scriptHash: hashOf(`${SCRIPT}\nlog("extra");`),
      }),
      "execution_identity_mismatch",
    );
    // 不同 args：
    await rejectsWith(
      harness.adapter.submitOnce({ ...input, args: { topic: "a11y" } }),
      "execution_identity_mismatch",
    );
    // 不同 owner（执行会话）：
    await rejectsWith(
      harness.adapter.submitOnce({ ...input, executionSessionId: `ctexec-${randomUUID()}` }),
      "execution_identity_mismatch",
    );
    // 绑定自洽：持久化的 hash 与文本对不上，在提交前拒绝（不产生任何执行）。
    const boundWrong = makeInput({ executionPath: harness.root });
    await rejectsWith(
      harness.adapter.submitOnce({ ...boundWrong, scriptHash: hashOf("tampered") }),
      "execution_identity_mismatch",
    );
  } finally {
    harness.dispose();
  }
});

test("I-05: 相同 ID 不同 args 在键序不同但值相同时不误拒（身份按内容而非键序）", async () => {
  const harness = makeRealHarness();
  try {
    const input = makeInput({
      executionPath: harness.root,
      args: { alpha: 1, beta: { deep: [1, 2] } },
    });
    await harness.adapter.submitOnce(input);
    await harness.adapter.submitOnce({
      ...input,
      args: { beta: { deep: [1, 2] }, alpha: 1 },
    });
  } finally {
    harness.dispose();
  }
});

// ── R-01：Cycle 保存后、提交前 kill → 同身份继续提交，无第二执行 ─────────────

test("R-01: 提交前 kill 后按原身份 submitOnce，新进程恰好启动一个 Run", async () => {
  const harness = makeRealHarness();
  try {
    // 「Cycle 保存」：执行身份三元组先持久化（这里即 input 本身），尚未提交。
    const input = makeInput({ executionPath: harness.root });
    // kill 模拟：换一个 service/adapter（新进程的注册表为空），journal 仍是同一份。
    const second = harness.nextProcess();

    // 提交前 inspect：pending（身份已绑定、执行未被接受）。
    const before = await second.adapter.inspect({
      cycleId: input.cycleId,
      executionSessionId: input.executionSessionId,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId,
    });
    assert.equal(before.status, "pending");
    assert.equal(before.resumable, false);

    const ref = await second.adapter.submitOnce(input);
    await second.adapter.waitForQuiescence(ref);
    await waitFor(() => second.adapter.inspect(ref).then((state) => state.status === "completed"));

    // 无第二执行：run-started 恰好一条；「无第二 Cycle」在此层的事实是同一 workflowRunId
    // 没有产生第二份执行身份（Program/Cycle 唯一性由 CT-01 的 open-cycle 索引保证）。
    const events = harness.journal.listEvents(ref.workflowRunId);
    assert.equal(events.filter((event) => event.event.type === "run-started").length, 1);
  } finally {
    harness.dispose();
  }
});

// ── R-02：Run 接受后 ACK 丢失/kill → inspect 原 Run，只有一个工作集合 ─────────

test("R-02: ACK 丢失后重发命中同一 Run，actor 工作集合只有一个", async () => {
  const harness = makeRealHarness();
  try {
    const input = makeInput({ executionPath: harness.root });
    const ref = await harness.adapter.submitOnce(input);
    // ACK 丢失 + kill：原 service 的注册表消亡，调用方只能靠持久身份重试。
    const second = harness.nextProcess();
    const ref2 = await second.adapter.submitOnce(input);
    assert.equal(ref2.workflowRunId, ref.workflowRunId);

    // inspect 原 Run：同一执行会话、同一条 journal 行。
    const state = await second.adapter.inspect(ref);
    assert.equal(state.runId, input.workflowRunId);
    assert.equal(state.status === "completed" || state.status === "running", true);

    await second.adapter.waitForQuiescence(ref);
    // 结算的可观察事实是 journal 里的 run-settled 事件（status 列的翻转可能早它数毫秒）。
    await waitFor(() =>
      harness.journal
        .listEvents(ref.workflowRunId)
        .some((event) => event.event.type === "run-settled"),
    );
    const events = harness.journal.listEvents(ref.workflowRunId);
    assert.equal(events.filter((event) => event.event.type === "run-started").length, 1);
    assert.equal(events.filter((event) => event.event.type === "run-settled").length, 1);
    // 报告不因重发而双计。
    const batch = await second.adapter.readReports(ref, 0);
    assert.equal(batch.items.length, 3);
  } finally {
    harness.dispose();
  }
});

// ── R-05：Run completed 后、Cycle terminal 前 kill → settling 收尾 ───────────

test("R-05: completed 后 kill：不 resume、不新 Run，报告与收尾仍可读", async () => {
  const harness = makeRealHarness();
  try {
    const input = makeInput({ executionPath: harness.root });
    const ref = await harness.adapter.submitOnce(input);
    await harness.adapter.waitForQuiescence(ref);
    await waitFor(() => harness.adapter.inspect(ref).then((state) => state.status === "completed"));

    // completed 后、Cycle terminal 前 kill：新进程接管 settling。
    const second = harness.nextProcess();
    const state = await second.adapter.inspect(ref);
    assert.equal(state.status, "completed");
    assert.equal(state.resumable, false);

    // completed 不 resume；同身份 submitOnce（试图重跑）也被拒绝——不冒充可恢复。
    await rejectsWith(second.adapter.resume(ref, 1), "not_resumable");
    await rejectsWith(second.adapter.submitOnce(input), "not_resumable");

    // settling 收尾在新进程可完成：quiescence 对冷行立即返回，报告可按序读取。
    await second.adapter.waitForQuiescence(ref);
    const batch = await second.adapter.readReports(ref, 0);
    assert.equal(batch.items.length, 3);
    // 增量游标：cursor 之后为空页且 nextCursor 原样返回（幂等）。
    const tail = await second.adapter.readReports(ref, batch.nextCursor);
    assert.equal(tail.items.length, 0);
    assert.equal(tail.nextCursor, batch.nextCursor);
  } finally {
    harness.dispose();
  }
});

test("R-05/词表: errored 与 superseded 的 Run 拒绝 resume（不冒充可恢复）", async () => {
  const harness = makeRealHarness();
  try {
    const failing = makeInput({
      executionPath: harness.root,
      scriptText: FAILING_SCRIPT,
      scriptHash: hashOf(FAILING_SCRIPT),
    });
    const failedRef = await harness.adapter.submitOnce(failing);
    await harness.adapter.waitForQuiescence(failedRef);
    await waitFor(() =>
      harness.adapter.inspect(failedRef).then((state) => state.status === "errored"),
    );
    await rejectsWith(harness.adapter.resume(failedRef, 1), "not_resumable");

    // superseded 场景：journal 行直接置 stopped(superseded)（amend 的落库形态），
    // resume 门按同一谓词拒绝（isResumableSettlement 排除 superseded）。
    const input = makeInput({ executionPath: harness.root });
    const ref = await harness.adapter.submitOnce(input);
    await harness.adapter.waitForQuiescence(ref);
    await waitFor(() => harness.adapter.inspect(ref).then((state) => state.status === "completed"));
    harness.journal.updateRunStatus(ref.workflowRunId, "stopped", {
      stopReason: "superseded",
      supersededBy: `ctrun-${randomUUID()}`,
    });
    await rejectsWith(harness.adapter.resume(ref, 1), "superseded");
  } finally {
    harness.dispose();
  }
});

// ── 报告读面：按序、投影与去重键 ─────────────────────────────────────────────

test("readReports: journal sequence 游标 + V1 投影 + 非 V1 载荷标 unknown 不丢行", async () => {
  const harness = makeRealHarness();
  try {
    assert.equal(supportsSequencedReportReads(harness.journal), true);
    const input = makeInput({ executionPath: harness.root });
    const ref = await harness.adapter.submitOnce(input);
    await harness.adapter.waitForQuiescence(ref);
    await waitFor(() => harness.adapter.inspect(ref).then((state) => state.status === "completed"));

    // 单页上限 4 → 3 条一页读完；分页（pageSize=4 恰好容下，这里用 afterSequence 验证游标语义）。
    const first = await harness.adapter.readReports(ref, 0);
    assert.equal(first.items.length, 3);
    const kinds = first.items.map((item) => item.kind);
    assert.deepEqual(kinds, ["candidate", "decision", "unknown"]);
    // itemKey：V1 自带键 + sequence 参与去重（后两条的 journalSequence 不同）。
    assert.equal(first.items[0]!.itemKey, "cand-header");
    assert.ok(first.items[2]!.journalSequence > first.items[1]!.journalSequence);
    // 游标推进：从第二条开始读只剩一条，且不重复第一页内容。
    const secondPage = await harness.adapter.readReports(ref, first.items[0]!.journalSequence);
    assert.equal(secondPage.items.length, 2);
    assert.equal(secondPage.items[0]!.itemKey, "dec-settings");
  } finally {
    harness.dispose();
  }
});

// ── I-06：Run 结束但工具/usage 未结束 → 不提前收尾 ───────────────────────────

test("I-06: waitForQuiescence 在结算之后还要等被中止 turn 的收尾（不只等 run-settled）", async () => {
  const runs = new Map<string, RunRegistryEntry>();
  const journal = new InMemoryJournalStore();
  let settleRun: (() => void) | undefined;
  let resolveQuiet: (() => void) | undefined;
  const settlementGate = new Promise<void>((resolve) => {
    settleRun = resolve;
  });
  const quietGate = new Promise<void>((resolve) => {
    resolveQuiet = resolve;
  });
  const entry = {
    controller: new AbortController(),
    control: undefined,
    startedAt: new Date(),
    cwd: "/tmp",
    scriptText: "x",
    settlement: settlementGate.then(() => ({ status: "completed" as const })),
    quiescence: {
      // 模拟「引擎已结算、被中止 turn 的工具/转录尾巴还没写完」。
      quietSessions: () => quietGate.then(() => new Set<string>()),
    },
  } as unknown as RunRegistryEntry;
  runs.set("ctrun-quiesce", entry);

  const lifecycle = createRunServiceLifecycle({ journal, runs, parentSessionId: "app" });
  const observed: string[] = [];
  const waiting = lifecycle.waitForRunQuiescence("ctrun-quiesce").then(() => {
    observed.push("resolved");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 结算未落地：不得提前收尾（Cycle 不能提前进入下一轮）。
  assert.deepEqual(observed, []);
  settleRun!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 结算已落地但会话未静默：仍不得收尾——run-settled 不是工具停止的证据。
  assert.deepEqual(observed, []);
  resolveQuiet!();
  await waiting;
  assert.deepEqual(observed, ["resolved"]);

  // 冷行（本进程无注册表条目）：立即返回——没有本地尾巴可等，晚到 usage 走账本幂等结算。
  await lifecycle.waitForRunQuiescence("ctrun-unknown");
});

// ── 停止 / 挂起 / epoch 守卫（替身链路：裁决逻辑本身） ────────────────────────

interface FakeView extends ContinuousRunServiceView {
  calls: string[];
}

function makeFakeView(): FakeView {
  const calls: string[] = [];
  const view: FakeView = {
    calls,
    submitOnce: async (request) => {
      calls.push("submitOnce");
      return { ok: true, runId: request.runId, reused: false };
    },
    resume: async (runId) => {
      calls.push("resume");
      return { ok: true, runId };
    },
    cancel: async (runId, initiator) => {
      calls.push(`cancel:${initiator ?? "user"}`);
      return true;
    },
    waitForQuiescence: async (runId) => {
      calls.push(`quiescence:${runId}`);
    },
    isLiveRun: () => false,
  };
  return view;
}

function makeFakeAdapter(view: FakeView) {
  return createContinuousExecutionAdapter({
    runService: view,
    journal: new InMemoryJournalStore(),
    reportReader: {
      listSequencedReportItems: () => [],
    },
  });
}

function refOf(input: ManagedCycleInput): ExecutionReference {
  return {
    cycleId: input.cycleId,
    executionSessionId: input.executionSessionId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
  };
}

test("用户停止：先撤销准许（revoke）再 abort，等待工具停止而不只等 run-settled", async () => {
  const view = makeFakeView();
  const adapter = makeFakeAdapter(view);
  const input = makeInput();
  const ref = refOf(input);

  await adapter.stop(ref, "user_request");
  // 顺序即规格 §6：撤销（无独立调用面，由准许状态体现）→ cancel(user) → 等待收尾。
  assert.deepEqual(view.calls, ["cancel:user", `quiescence:${input.workflowRunId}`]);

  // 用户取消的 Run 不自动 resume（规格 §6）；同一 Cycle 的挂起恢复也被封锁。
  await rejectsWith(adapter.resume(ref, 1), "stopped");
  await rejectThrows(adapter.resumeSuspended(ref, 1));
});

test("suspendAtSafeBoundary 不等同 stop：不 cancel，Run 不落终态，恢复走 resumeSuspended", async () => {
  const view = makeFakeView();
  const adapter = makeFakeAdapter(view);
  const input = makeInput();
  const ref = refOf(input);

  await adapter.suspendAtSafeBoundary(ref, "budget_denied");
  // 资源暂停不能调用 stop 结束 Run：cancel 从未被调。
  assert.deepEqual(view.calls, []);
  const health = await adapter.inspectHealth(ref);
  assert.equal(health.admissionState, "suspended");
  assert.equal(health.reachable, false);

  // 挂起不是撤销：epoch 推进后 resumeSuspended 恢复准许（同 Run、同 Cycle）。
  await adapter.resumeSuspended(ref, 3);
  assert.equal((await adapter.inspectHealth(ref)).admissionState, "open");
  // 未挂起时 resumeSuspended 明确拒绝，不静默通过。
  await rejectThrows(adapter.resumeSuspended(ref, 4));
});

test("epoch 守卫：回退的 epoch 一律 lease_lost（旧 epoch 不可写）", async () => {
  const view = makeFakeView();
  const adapter = makeFakeAdapter(view);
  const input = makeInput();
  const ref = refOf(input);

  await adapter.suspendAtSafeBoundary(ref, "token_limit");
  await adapter.resumeSuspended(ref, 5);
  // 回退 epoch（旧 owner 的迟到调用）被拒绝，且不改变已恢复的准许状态。
  await rejectsWith(adapter.resume(ref, 4), "lease_lost");
  await rejectThrows(adapter.resumeSuspended(ref, 2));
  assert.equal((await adapter.inspectHealth(ref)).admissionState, "open");
  assert.equal((await adapter.inspectHealth(ref)).ownerEpoch, 5);
});

/** 期望抛 ContinuousExecutionError（reason 由调用方另行断言或不需要）的简写。 */
function rejectThrows(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: unknown): boolean => {
    assert.ok(error instanceof ContinuousExecutionError);
    return true;
  }) as Promise<void>;
}
