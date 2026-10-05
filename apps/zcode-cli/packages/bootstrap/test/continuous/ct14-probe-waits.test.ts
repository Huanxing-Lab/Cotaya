// CT-14 完整主动探活和正常阻塞——CLI 侧回归：
//   - 操作等待登记（测试/工具等实际等待）：owner/run/epoch、原因、开始时刻、真实期限、
//     取消与完成通知；过期登记移除、旧 epoch 登记失效（ticket CT-14）。
//   - 聚合规则：只有全部正在执行的节点都在有效等待中才承认整轮 normal_wait——journal
//     backoff 等待与操作登记等待共同覆盖；任一 actor 仍工作（未被覆盖）则不豁免。
//   - 可信工具端口（continuous-test / continuous-browser）在实际执行期间登记真实期限
//     （test 的受控超时、browser 的通信期限）；完成/取消后移除登记。
//   - 执行适配器 inspectHealth 把登记等待并入健康快照；epoch 高水位前进后旧登记失效。
// 规则来源：docs/tickets/continuous-release-gaps.md CT-14、docs/specs/continuous.md §10.1。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  createContinuousOperationWaitRegistry,
  type ContinuousOperationWaitHandle,
} from "../../src/app/continuous-operation-waits.js";
import { createContinuousHealthEvidence } from "../../src/app/continuous-health-evidence.js";
import { createContinuousExecutionAdapter } from "../../src/app/continuous-execution-adapter.js";
import {
  CONTINUOUS_CONFINED_DEFAULT_TIMEOUT_MS,
  type ContinuousConfinedTestRunner,
} from "../../src/app/continuous-confined-execution.js";
import { createContinuousTrustedPorts } from "../../src/app/continuous-trusted-ports.js";
import { createContinuousEvidenceRegistry } from "../../src/app/continuous-evidence.js";
import { createContinuousCandidateGrantHolder } from "../../src/app/continuous-decision-adapter.js";
import type { ContinuousActorIoPolicy } from "../../src/app/continuous-io-guards.js";
import type { ContinuousExecutionPolicyConfig } from "../../src/app/continuous-execution-policy.js";

function putRunningNode(journal: InMemoryJournalStore, siteId: string): void {
  journal.putNode({
    runId: "run-1",
    siteId,
    ordinal: 0,
    kind: "ask",
    status: "running",
    inputHash: "h",
  } as never);
}

test("CT-14 操作等待登记：完成/取消移除；过期与旧 epoch 登记失效", () => {
  const registry = createContinuousOperationWaitRegistry();
  const base = {
    runId: "run-1",
    epoch: 2,
    reason: "declared test: npm test",
    startedAt: 1_000,
  };
  let handle: ContinuousOperationWaitHandle | undefined = registry.register({
    ...base,
    ownerId: "op-1",
    deadlineAt: 1_000 + 600_000,
  });
  assert.deepEqual(
    registry.activeOf("run-1", 2_000, 2).map((fact) => fact.ownerId),
    ["op-1"],
    "有效登记可读，带齐 owner/run/epoch/原因/时刻/期限",
  );
  // 过期登记移除：期限已过 → 不再是正常等待证据（等待失效后重新计时的事实基础）。
  assert.deepEqual(registry.activeOf("run-1", 1_000 + 600_001, 2), [], "过期登记被移除");
  assert.deepEqual(registry.activeOf("run-1", 3_000, 2), [], "移除是持久的（惰性清理落地）");
  // 旧 epoch 的登记不作数（执行权已被接管，旧操作的等待不能豁免新轮计时）。
  registry.register({ ...base, ownerId: "op-2", deadlineAt: 1_000 + 600_000 });
  assert.deepEqual(registry.activeOf("run-1", 2_000, 3), [], "旧 epoch 登记失效");
  // 完成通知移除；取消（AbortSignal）同样移除。
  handle = registry.register({ ...base, ownerId: "op-3", deadlineAt: 1_000 + 600_000 });
  handle.complete();
  handle.complete();
  assert.deepEqual(registry.activeOf("run-1", 2_000, 2), [], "完成通知移除登记（幂等）");
  const controller = new AbortController();
  registry.register(
    { ...base, ownerId: "op-4", deadlineAt: 1_000 + 600_000 },
    controller.signal,
  );
  assert.deepEqual(registry.activeOf("run-1", 2_000, 2).map((f) => f.ownerId), ["op-4"]);
  controller.abort();
  assert.deepEqual(registry.activeOf("run-1", 2_000, 2), [], "取消通知移除登记");
  // 登记按 run 隔离。
  registry.register({ ...base, runId: "run-2", ownerId: "op-5", deadlineAt: 5_000 });
  assert.deepEqual(registry.activeOf("run-1", 2_000, 2), [], "登记按 runId 隔离");
});

test("CT-14 聚合：全部运行节点都被有效等待覆盖才承认 normal_wait；任一 actor 工作不豁免", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "run-1", status: "running" } as never);
  const registry = createContinuousOperationWaitRegistry();
  const evidence = createContinuousHealthEvidence(journal, {
    operationWaits: registry,
    now: () => Date.now(),
  });
  // 一个运行节点 + 一条操作登记（例如长测试在执行）→ 整轮 normal_wait 证据成立。
  putRunningNode(journal, "builder");
  registry.register({
    runId: "run-1",
    ownerId: "test:cand:0",
    epoch: 1,
    reason: "declared test",
    startedAt: Date.now(),
    deadlineAt: Date.now() + 7_200_000,
  });
  let wait = evidence("run-1").waitingFor;
  assert.ok(wait, "登记等待覆盖全部运行节点 → waitingFor 在场");
  assert.equal(wait!.deadlineAt, 1_000_000 + 7_200_000, "期限来自登记的真实期限");
  assert.equal(wait!.reason, "declared test");
  // 第二个 actor 开始工作（无等待证据）→ 任一 actor 仍工作，整轮照计有效时间。
  putRunningNode(journal, "observer");
  assert.equal(evidence("run-1").waitingFor, undefined, "任一 actor 工作仍计有效时间");
  // 第二条登记覆盖第二个节点 → 再次全部等待。
  registry.register({
    runId: "run-1",
    ownerId: "browser:cand",
    epoch: 1,
    reason: "browser validation",
    startedAt: Date.now(),
    deadlineAt: Date.now() + 300_000,
  });
  wait = evidence("run-1").waitingFor;
  assert.ok(wait, "两条登记覆盖两个运行节点 → 全部等待");
  assert.equal(wait!.deadlineAt, 1_000_000 + 300_000, "多登记取最早期限");
  // 登记过期：等待失效（等待失效后重新计时）。
  t.mock.timers.setTime(1_000_000 + 300_001);
  assert.equal(evidence("run-1").waitingFor, undefined, "过期登记移除后不再豁免");
});

test("CT-14 聚合：journal backoff 等待与操作登记共同覆盖", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "run-1", status: "running" } as never);
  const registry = createContinuousOperationWaitRegistry();
  const evidence = createContinuousHealthEvidence(journal, {
    operationWaits: registry,
    now: () => Date.now(),
  });
  // 节点 a：journal backoff 等待（模型重试，期限来自落库事件）。
  putRunningNode(journal, "a");
  journal.appendEvent("run-1", {
    type: "node-waiting",
    instance: { siteId: "a", ordinal: 0 } as never,
    cause: "backoff",
    reason: "rate_limited",
    delayMs: 600_000,
  });
  assert.equal(evidence("run-1").waitingFor?.deadlineAt, 1_000_000 + 600_000);
  // 节点 b 开始真实长测试（操作登记）→ 覆盖后整轮等待。
  putRunningNode(journal, "b");
  assert.equal(evidence("run-1").waitingFor, undefined);
  registry.register({
    runId: "run-1",
    ownerId: "test:cand:0",
    epoch: 1,
    reason: "declared test",
    startedAt: Date.now(),
    deadlineAt: Date.now() + 300_000,
  });
  assert.ok(evidence("run-1").waitingFor, "journal 等待 + 登记等待共同覆盖全部节点");
});

test("CT-14 trusted 端口：声明测试执行期间登记真实期限，完成/取消后移除", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "continuous-ct14-trusted-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const config: ContinuousExecutionPolicyConfig = {
    executionPath: outputRoot,
    workspacePath: outputRoot,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
    declaredTestCommands: [{ argv: ["node", "test.js"] }],
    activeCandidate: { candidateId: "c", targetPaths: ["src"] },
    pathStyle: "posix",
    caseInsensitiveFs: false,
    platformExecutionMode: "autonomous",
  };
  const policy: ContinuousActorIoPolicy = {
    role: "builder",
    config: () => config,
    waitForAdmission: async () => {},
  };
  const registry = createContinuousOperationWaitRegistry();
  let releaseRun: (() => void) | undefined;
  /** 受控 runner：登记断言在「执行中」窗口内完成，再放行结果。 */
  const runner: ContinuousConfinedTestRunner = {
    available: true,
    isolationKey: "test-isolation",
    run: async () => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return {
        status: "completed",
        exitCode: 0,
        stdoutTail: "",
        stderrTail: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        outputDir: outputRoot,
        stdoutPath: join(outputRoot, "stdout.txt"),
        stderrPath: join(outputRoot, "stderr.txt"),
        startedAt: Date.now(),
        durationMs: 5,
        isolationKey: "test-isolation",
      };
    },
  };
  const ports = createContinuousTrustedPorts({
    policy,
    identity: () => ({ programId: "p", cycleId: "c", runId: "run-1", epoch: 4 }),
    baseCommit: () => undefined,
    evidence: createContinuousEvidenceRegistry(),
    testRunner: runner,
    grants: createContinuousCandidateGrantHolder(),
    changeLimits: () => ({ maxFiles: 10, maxChangedLines: 400 }),
    suspendForChangeLimit: async () => {},
    outputRoot,
    registerOperationWait: (input) =>
      registry.register(
        {
          runId: "run-1",
          epoch: 4,
          ownerId: input.ownerId,
          reason: input.reason,
          startedAt: input.startedAt,
          deadlineAt: input.deadlineAt,
        },
        input.signal,
      ),
  });
  const running = ports.run({ file: "continuous-test", args: ["cand", "0"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const active = registry.activeOf("run-1", Date.now() + 1, 4);
  assert.equal(active.length, 1, "测试执行期间存在登记");
  assert.equal(active[0]!.ownerId, "test:cand:0");
  assert.equal(active[0]!.deadlineAt, active[0]!.startedAt + CONTINUOUS_CONFINED_DEFAULT_TIMEOUT_MS, "期限 = 受控执行的真实超时");
  releaseRun!();
  const result = (await running).stdout.text;
  assert.ok(result.includes('"status":"ok"'), `测试结果信封正常: ${result}`);
  assert.deepEqual(registry.activeOf("run-1", Date.now() + 1, 4), [], "完成后移除登记");
});

test("CT-14 trusted 端口：浏览器验证有通信期限，超时不伪造证据并移除登记", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "continuous-ct14-browser-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const config: ContinuousExecutionPolicyConfig = {
    executionPath: outputRoot,
    workspacePath: outputRoot,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
    declaredTestCommands: [],
    activeCandidate: null,
    pathStyle: "posix",
    caseInsensitiveFs: false,
    platformExecutionMode: "autonomous",
  };
  const registry = createContinuousOperationWaitRegistry();
  const evidence = createContinuousEvidenceRegistry();
  const ports = createContinuousTrustedPorts({
    policy: {
      role: "builder",
      config: () => config,
      waitForAdmission: async () => {},
    },
    identity: () => ({ programId: "p", cycleId: "c", runId: "run-1", epoch: 1 }),
    baseCommit: () => undefined,
    evidence,
    testRunner: {
      available: false,
      isolationKey: "none",
      run: async () => {
        throw new Error("不应执行测试");
      },
    },
    grants: createContinuousCandidateGrantHolder(),
    changeLimits: () => ({ maxFiles: 10, maxChangedLines: 400 }),
    suspendForChangeLimit: async () => {},
    outputRoot,
    browserDeadlineMs: 40,
    browser: {
      check: () => new Promise(() => {}),
    },
    registerOperationWait: (input) =>
      registry.register(
        {
          runId: "run-1",
          epoch: 1,
          ownerId: input.ownerId,
          reason: input.reason,
          startedAt: input.startedAt,
          deadlineAt: input.deadlineAt,
        },
        input.signal,
      ),
  });
  const result = JSON.parse(
    (await ports.run({ file: "continuous-browser", args: ["cand"] })).stdout.text,
  );
  assert.equal(result.outcome, "unverified", "期限超时只能如实 unverified，不伪造通过/失败");
  assert.match(result.reason, /deadline/);
  assert.equal(registry.activeOf("run-1", Date.now() + 1, 1).length, 0, "超时后登记移除");
  const browserRecord = evidence.latest("cand", "browser");
  assert.equal((browserRecord as { outcome?: string } | undefined)?.outcome, "unverified");
});

test("CT-14 适配器 inspectHealth：登记等待进快照；epoch 高水位前进后旧登记失效", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "run-1", status: "running" } as never);
  const adapter = createContinuousExecutionAdapter({
    journal,
    reportReader: { listSequencedReportItems: () => [] },
    runService: {
      submitOnce: async (r) => ({ ok: true, runId: r.runId, reused: false }),
      resume: async () => ({ ok: true }),
      cancel: async () => true,
      waitForQuiescence: async () => {},
      isLiveRun: () => true,
    },
  });
  const ref = { cycleId: "c", executionSessionId: "s", workflowRunId: "run-1", traceId: "t" };
  putRunningNode(journal, "builder");
  const startedAt = Date.now();
  const handle = adapter.registerOperationWait({
    runId: "run-1",
    ownerId: "test:cand:0",
    epoch: 0,
    reason: "declared test",
    startedAt,
    deadlineAt: startedAt + 600_000,
  });
  const snapshot = await adapter.inspectHealth(ref);
  assert.ok(snapshot.waitingFor, "登记等待并入健康快照");
  assert.equal(snapshot.waitingFor!.ownerId, "test:cand:0");
  // 执行权前进（resume 以新 epoch 到达）：旧 epoch 的登记不作数。
  await adapter.resume(ref, 7);
  const after = await adapter.inspectHealth(ref);
  assert.equal(after.waitingFor, undefined, "旧 epoch 登记在高水位前进后失效");
  handle.complete();
});
