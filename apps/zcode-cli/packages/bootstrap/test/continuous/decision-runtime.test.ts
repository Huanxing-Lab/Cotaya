// CT-06 决策适配器测试：escalate → 持久化 Decision + 撤销候选写入许可 + 结构化 defer
// 的接合（E-05：持久化先于撤销、后续写入 scope_denied、不等待人类），以及 run service 的
// wrapEscalatePort 接缝 wiring（managed run 的 actor 升级端口被决策闸门替换；未登记的
// run 原端口透传，普通 Workflow escalation 逐字不变）。用例对应：
// docs/testing/continuous.md §8（E-05/E-07 的执行侧）。
//
// 边界：bootstrap 不依赖 @zcode/services（适配器是端口的结构镜像）——sink 在这里用记录型
// 替身钉住适配器侧契约（输入形状、调用顺序、稳定 fingerprint）；fingerprint 合并/落库的
// 真实持久化链路在 packages/services/test/continuous/decision.test.ts（真实 SQLite +
// ContinuousDecisionService）。撤销链路组合 CT-02 纯执行策略（checkContinuousFilePath 对
// 撤销后的写入返回 candidate_inactive/scope_denied）。运行入口：
// node scripts/test-continuous.mjs --suite integration（tsx + node.test；wiring 用真实
// SQLite session store + 真实 harness 子进程）。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { DwfSequencedReportQueries } from "@zcode/adapters/storage";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { EscalateQuestionRequest, TraceContext, WorkflowEscalatePort } from "@zcode/contracts";
import { createDynamicWorkflowRunService } from "../../src/app/dynamic-workflow-run-service.js";
import {
  createContinuousCandidateGrantHolder,
  createContinuousDecisionGate,
  type ContinuousDecisionRecordInput,
  type ContinuousDecisionSink,
} from "../../src/app/continuous-decision-adapter.js";
import { checkContinuousFilePath } from "../../src/app/continuous-execution-policy.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct06-runtime-"));

// ── sink 替身：记录适配器侧契约（输入形状/顺序/稳定 fingerprint）──────────

interface SinkCall extends ContinuousDecisionRecordInput {
  at: number;
}

function makeRecordingSink(overrides?: {
  persist?: (
    input: ContinuousDecisionRecordInput,
  ) => Promise<{ decisionId: string; merged: boolean }>;
}): {
  sink: ContinuousDecisionSink;
  calls: SinkCall[];
  order: string[];
} {
  const calls: SinkCall[] = [];
  const order: string[] = [];
  let decisionCounter = 0;
  const sink: ContinuousDecisionSink = {
    persist: async (input) => {
      const result =
        overrides?.persist === undefined
          ? {
              decisionId: `dec-fixture-${(decisionCounter += 1)}`,
              fingerprint: input.fingerprint,
              status: "pending" as const,
              merged: calls.some((call) => call.fingerprint === input.fingerprint),
            }
          : await overrides.persist(input);
      order.push("persist");
      calls.push({ ...input, at: calls.length });
      return result;
    },
  };
  return { sink, calls, order };
}

function escalateRequest(question: string, context?: string): EscalateQuestionRequest {
  return {
    toolCallId: "call-1",
    question,
    ...(context === undefined ? {} : { context }),
    trace: { traceId: "trace-ct06" } as TraceContext,
  };
}

/** 不等待任何人的假「主代理端口」：被包装端口绝不委托它；若被调用则测试失败。 */
const unreachablePort: WorkflowEscalatePort = {
  escalate: () => Promise.reject(new Error("被包装端口不得委托原端口（不停驻等待人类）")),
};

/** 撤销动作的记录壳（顺序断言：persist 先于 revoke）。 */
function recordingGrants(order: string[]): ReturnType<typeof createContinuousCandidateGrantHolder> {
  const holder = createContinuousCandidateGrantHolder();
  const inner = holder.revokeActive.bind(holder);
  return {
    authorize: holder.authorize,
    activeGrant: holder.activeGrant,
    isRevoked: holder.isRevoked,
    revokeActive: (reason: string) => {
      const revoked = inner(reason);
      order.push("revoke");
      return revoked;
    },
  };
}

// ── E-05：执行中决策的完整接合 ────────────────────────────────

test("E-05 escalate → 持久化输入先发、候选写入许可撤销、结构化 defer 不等待人", async () => {
  const { sink, calls, order } = makeRecordingSink();
  const grants = recordingGrants(order);
  const gate = createContinuousDecisionGate({
    programId: "prog-e05",
    cycleId: "cycle-e05",
    sink,
    grants,
  });

  // builder 已授权候选（CT-02 策略配置的 activeCandidate 来源）。
  const candidateId = `cand:${"a".repeat(24)}`;
  assert.deepEqual(grants.authorize({ candidateId, targetPaths: ["src/settings/Nav.tsx"] }), {
    ok: true,
  });
  const policyConfig = (active: { candidateId: string; targetPaths: string[] } | null) => ({
    executionPath: "/wt/continuous",
    workspacePath: "/repos/app",
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
    declaredTestCommands: [],
    activeCandidate: active,
    pathStyle: "posix" as const,
    caseInsensitiveFs: false,
    // CT-10：决策撤销语义在 autonomous 平台验证（observe_only 在 platform suite）。
    platformExecutionMode: "autonomous" as const,
  });
  // 授权期内：候选路径内的写入放行。
  assert.equal(
    checkContinuousFilePath(policyConfig(grants.activeGrant()), {
      role: "builder",
      operation: "write",
      path: "/wt/continuous/src/settings/Nav.tsx",
    }).code,
    "allowed",
  );

  // escalate：立刻返回结构化 defer（不停驻等待人类；原端口不被触碰）。
  const wrapped = gate.wrap(unreachablePort);
  const outcome = await wrapped.escalate(
    escalateRequest("Settings 导航要拆成两级菜单吗？", "涉及信息结构，超出自主范围"),
  );
  assert.equal(outcome.kind, "answered");
  if (outcome.kind !== "answered") return;
  assert.match(outcome.qid, /^ctdef-[0-9a-f]{16}$/);
  assert.match(outcome.answer, /^DEFERRED_TO_HUMAN_DECISION /);
  assert.match(outcome.answer, /decisionId=dec-fixture-1/);
  assert.match(outcome.answer, new RegExp(`candidateId=${candidateId}`));
  assert.match(outcome.answer, /写入许可已撤销/);
  assert.match(outcome.answer, /不要等待回答/);

  // 持久化输入先于撤销发出（E-05「Decision 先持久化」；sink 收到的就是 Host 决策行形状）。
  assert.deepEqual(order, ["persist", "revoke"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.programId, "prog-e05");
  assert.equal(calls[0]!.cycleId, "cycle-e05");
  assert.equal(calls[0]!.title, "Settings 导航要拆成两级菜单吗？");
  assert.equal(calls[0]!.classification, "blocking");
  assert.deepEqual(calls[0]!.blockingScope!.candidateIds, [candidateId]);
  assert.deepEqual(calls[0]!.blockingScope!.paths, ["src/settings/Nav.tsx"]);
  assert.equal(calls[0]!.options.length, 2, "标准选项（放行/跳过）供人类回答");
  assert.ok(calls[0]!.evidence!.some((entry) => (entry as { kind: string }).kind === "escalation"));

  // 该候选后续写入拒绝：activeCandidate 为空 → candidate_inactive（scope_denied）。
  const denied = checkContinuousFilePath(policyConfig(grants.activeGrant()), {
    role: "builder",
    operation: "write",
    path: "/wt/continuous/src/settings/Nav.tsx",
  });
  assert.equal(denied.code, "scope_denied");
  assert.equal(denied.reason, "candidate_inactive");
  // 已撤销候选不得重新授权（defer 是终局，骨架必须跳过）。
  assert.deepEqual(grants.authorize({ candidateId, targetPaths: ["src/settings/Nav.tsx"] }), {
    ok: false,
    reason: "candidate_revoked",
  });
  // 其余候选照常：授权下一个候选可行（builder 串行换岗，另两项不被该决策挡住）。
  const nextCandidateId = `cand:${"b".repeat(24)}`;
  assert.deepEqual(
    grants.authorize({ candidateId: nextCandidateId, targetPaths: ["src/ui/A.tsx"] }),
    {
      ok: true,
    },
  );
  assert.equal(
    checkContinuousFilePath(policyConfig(grants.activeGrant()), {
      role: "builder",
      operation: "write",
      path: "/wt/continuous/src/ui/A.tsx",
    }).code,
    "allowed",
    "下一候选的写入照常放行",
  );
});

test("E-07 执行侧：同问题重复 escalate 产出同一 fingerprint（Host 侧合并）；无授权候选时 defer 阻塞零候选", async () => {
  const { sink, calls } = makeRecordingSink();
  const gate = createContinuousDecisionGate({
    programId: "prog-e07x",
    cycleId: "cycle-e07x",
    sink,
    grants: createContinuousCandidateGrantHolder(),
  });
  const wrapped = gate.wrap(unreachablePort);
  const question = "同一个需要决策的问题";
  const expectedFingerprint = createHash("sha256")
    .update(`continuous-decision:${question}`, "utf8")
    .digest("hex");

  await wrapped.escalate(escalateRequest(question));
  const second = await wrapped.escalate(escalateRequest(question));
  assert.equal(calls[0]!.fingerprint, expectedFingerprint, "fingerprint 由问题文本稳定派生");
  assert.equal(
    calls[1]!.fingerprint,
    expectedFingerprint,
    "重复 escalate 同 fingerprint → Host 合并来源",
  );
  assert.equal(calls[1]!.evidence!.length, 1, "第二次的 evidence 仍完整上送（合并归 Host）");
  assert.match(second.answer, /DEFERRED_TO_HUMAN_DECISION/);

  // 无授权候选（observer/reviewer 只读角色 escalate）：照常 defer，blockingScope 为空——
  // 空_scope 阻塞零候选（§8「不默认阻止当前 Cycle」在执行侧的同一谓词）。
  const bare = await wrapped.escalate(escalateRequest("观察期的问题"));
  assert.match(bare.answer, /candidateId=none/);
  const bareCall = calls.find((call) => call.title === "观察期的问题")!;
  assert.deepEqual(bareCall.blockingScope!.candidateIds, []);
  assert.deepEqual(bareCall.blockingScope!.paths, []);
});

test("grant holder：builder 一次一个候选、同候选重授权幂等、不同候选占用期拒绝", () => {
  const grants = createContinuousCandidateGrantHolder();
  const first = { candidateId: "cand-1", targetPaths: ["src/a"] };
  assert.deepEqual(grants.authorize(first), { ok: true });
  assert.deepEqual(grants.authorize(first), { ok: true }, "同候选幂等");
  assert.deepEqual(grants.authorize({ candidateId: "cand-2", targetPaths: ["src/b"] }), {
    ok: false,
    reason: "candidate_busy",
  });
  assert.deepEqual(grants.revokeActive("决策推迟"), {
    candidateId: "cand-1",
    targetPaths: ["src/a"],
  });
  assert.equal(grants.activeGrant(), null);
  assert.equal(grants.revokeActive("再撤"), null, "无授权时撤销为 no-op");
  assert.equal(grants.isRevoked("cand-1"), true);
});

// ── wiring：run service 的 wrapEscalatePort 接缝（真实 service + harness 子进程）──

/** 带 ask 的脚本：引擎必须创建 actor 会话（ask-free 脚本不会走到 runtimeFactory）。 */
const ASK_SCRIPT = `
const probe = agent("decision-probe");
const answer = await probe.ask("reply with ok");
return { answer };
`;

const MANAGED_RUN_ID = "dwfrun-ct06-decision-wiring";

interface WiringHarness {
  root: string;
  journal: JournalStorePort & DwfSequencedReportQueries;
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  recorded: Array<{ runId: string; port: WorkflowEscalatePort; seamInput: WorkflowEscalatePort }>;
  sinkCalls: ContinuousDecisionRecordInput[];
  dispose: () => void;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeWiringHarness(): WiringHarness {
  const root = mkdtempSync(join(tmpRoot, "wiring-"));
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  const journal = store.workflowJournalStore() as JournalStorePort & DwfSequencedReportQueries;
  const fileSystemPort = createNodeFileSystemAdapter();
  const executionPort = {
    run: async (): Promise<never> => {
      throw new Error("CT-06 wiring 脚本不执行 world.run");
    },
  };
  const recorded: WiringHarness["recorded"] = [];
  const sinkCalls: ContinuousDecisionRecordInput[] = [];
  const seamInputs = new Map<string, WorkflowEscalatePort>();
  const sink: ContinuousDecisionSink = {
    persist: async (input) => {
      sinkCalls.push(input);
      return {
        decisionId: "dec-wiring",
        fingerprint: input.fingerprint,
        status: "pending",
        merged: false,
      };
    },
  };
  const gate = createContinuousDecisionGate({
    programId: "prog-wiring",
    cycleId: "cycle-wiring",
    sink,
    grants: createContinuousCandidateGrantHolder(),
  });
  const service = createDynamicWorkflowRunService({
    journal,
    parentSessionId: "app-ct06-wiring",
    fileSystemPort,
    executionPort,
    createActorRuntime: ({ runId, escalatePort }) => {
      // 记录接缝产物即返回最小 stub（同 budget-runtime 惯例：rejected promise 收容于
      // runTurn 的 onTurnRejected，run 落 errored 终态——接线断言不依赖 run 成功）。
      const seamInput = seamInputs.get(runId);
      recorded.push({
        runId,
        port: escalatePort,
        ...(seamInput === undefined ? {} : { seamInput }),
      });
      return {
        getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture-model" }),
        ensureSessionPersistedForExternalActivity: async () => {},
        resumeFromStore: async () => {},
        executeTurn: () => Promise.reject(new Error("ct06 wiring stub: no real turns")),
        dispose: () => {},
      } as never;
    },
    wrapEscalatePort: ({ runId, escalatePort }) => {
      // 与 create-app 的 decisionGateFor 登记模式同一形状：只有 managed run 被包装。
      seamInputs.set(runId, escalatePort);
      return runId === MANAGED_RUN_ID ? gate.wrap(escalatePort) : escalatePort;
    },
  });
  return {
    root,
    journal,
    service,
    recorded,
    sinkCalls,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("wiring：managed run 的 actor 升级端口被决策闸门替换；未登记 run 原端口透传", async (t) => {
  const harness = makeWiringHarness();
  t.after(() => harness.dispose());

  // managed run：submitOnce（内部受控提交路径）。
  const managed = await harness.service.submitOnce({
    runId: MANAGED_RUN_ID,
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: "app-ct06-wiring",
    trace: { traceId: "trace-ct06" } as TraceContext,
  });
  assert.equal(managed.ok, true);
  await waitFor(() => harness.recorded.some((entry) => entry.runId === MANAGED_RUN_ID));
  const managedEntry = harness.recorded.find((entry) => entry.runId === MANAGED_RUN_ID)!;
  assert.notEqual(managedEntry.port, managedEntry.seamInput, "managed run 拿到包装后的端口");
  // 包装后的端口：escalate 走决策闸门（defer），sink 收到 Host 决策行形状的持久化输入。
  const outcome = await managedEntry.port.escalate(escalateRequest("wiring: 需要决策的问题"));
  assert.match(
    outcome.kind === "answered" ? outcome.answer : "",
    /DEFERRED_TO_HUMAN_DECISION/,
    "managed run 的 escalate 被决策闸门接住（不停驻）",
  );
  assert.equal(harness.sinkCalls.length, 1);
  assert.equal(harness.sinkCalls[0]!.programId, "prog-wiring");
  assert.equal(harness.sinkCalls[0]!.cycleId, "cycle-wiring");
  await waitFor(() => harness.journal.getRun(MANAGED_RUN_ID)?.status === "errored");
  await harness.service.waitForQuiescence(MANAGED_RUN_ID);

  // 普通 Workflow（未登记 runId）：seam 收到原端口并原样返回——escalation 逐字不变。
  const normal = await harness.service.submit({
    scriptText: ASK_SCRIPT,
    cwd: harness.root,
    parentSessionId: "app-ct06-wiring",
    trace: { traceId: "trace-normal-ct06" } as TraceContext,
  });
  assert.equal(normal.ok, true);
  await waitFor(() => harness.recorded.some((entry) => entry.runId === normal.runId));
  const normalEntry = harness.recorded.find((entry) => entry.runId === normal.runId)!;
  assert.equal(
    normalEntry.port,
    normalEntry.seamInput,
    "未登记的 run 拿到的就是 driver 铸的原端口（无包装）",
  );
  assert.equal(harness.sinkCalls.length, 1, "普通 run 的 escalate 不触决策持久化");
  await waitFor(() => harness.journal.getRun(normal.runId)?.status === "errored");
  await harness.service.waitForQuiescence(normal.runId);
});
