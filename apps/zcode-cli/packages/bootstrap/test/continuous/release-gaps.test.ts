import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  guardContinuousActorIo,
  continuousActorToolAllowlist,
} from "../../src/app/continuous-io-guards.js";
import { requireContinuousManagedGuards } from "../../src/app/continuous-managed-guards.js";
import { createContinuousExecutionAdapter } from "../../src/app/continuous-execution-adapter.js";
import { createContinuousHealthEvidence } from "../../src/app/continuous-health-evidence.js";
import type { ContinuousExecutionPolicyConfig } from "../../src/app/continuous-execution-policy.js";

test("发布2.1：实际文件端口执行只读、候选授权和 symlink 检查，拒绝前没有写入", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-real-io-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, "src"), { recursive: true });
  const file = join(worktree, "src", "view.tsx");
  const outside = join(root, "outside.tsx");
  await writeFile(file, "original");
  await writeFile(outside, "outside");
  await symlink(outside, join(worktree, "src", "escape.tsx"));
  const config: ContinuousExecutionPolicyConfig = {
    executionPath: worktree,
    workspacePath: root,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push", "merge"] },
    declaredTestCommands: [{ argv: ["node", "test.js"] }],
    activeCandidate: { candidateId: "c", targetPaths: ["src"] },
    pathStyle: "posix",
    caseInsensitiveFs: false,
    platformExecutionMode: "autonomous",
  };
  let processes = 0;
  const ports = {
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: {
      run: async (): Promise<never> => {
        processes++;
        throw new Error("不应启动");
      },
    },
  };
  const observer = guardContinuousActorIo(
    { role: "observer", config: () => config, waitForAdmission: async () => {} },
    ports,
  );
  await assert.rejects(
    observer.fileSystemPort.writeTextFile({ path: file, content: "bad" }),
    /role_read_only/,
  );
  assert.equal(await readFile(file, "utf8"), "original");
  const builder = guardContinuousActorIo(
    { role: "builder", config: () => config, waitForAdmission: async () => {} },
    ports,
  );
  await builder.fileSystemPort.writeTextFile({ path: "src/view.tsx", content: "allowed" });
  assert.equal(await readFile(file, "utf8"), "allowed");
  await assert.rejects(
    builder.fileSystemPort.writeTextFile({ path: "src/escape.tsx", content: "bad" }),
    /symlink_escape/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside");
  config.activeCandidate = null;
  await assert.rejects(builder.fileSystemPort.removeFile({ path: file }), /candidate_inactive/);
  await assert.rejects(
    builder.executionPort.run({ command: { mode: "shell", command: "git push" } }),
    /shell_not_supported/,
  );
  await assert.rejects(
    builder.executionPort.run({ command: { mode: "argv", file: "git", args: ["push"] } }),
    /forbidden_capability/,
  );
  await assert.rejects(
    builder.executionPort.run({
      command: { mode: "argv", file: "node", args: ["test.js"] },
      sandbox: { enabled: true },
    }),
    /confined_execution_not_supported/,
  );
  assert.equal(processes, 0, "请求宣称 enabled 不能证明已装配真实沙箱");
  assert.equal(continuousActorToolAllowlist("builder").includes("Bash"), false);
  await assert.rejects(
    builder.fileSystemPort.searchText({ path: join(worktree, "src"), pattern: "secret" }),
    /recursive_read_not_supported/,
  );
});

test("发布2.1：缺少受管登记时，真实 submit 接口在调用 RunService 前拒绝", async () => {
  let submissions = 0;
  const adapter = createContinuousExecutionAdapter({
    journal: new InMemoryJournalStore(),
    reportReader: { listSequencedReportItems: () => [] },
    runService: {
      submitOnce: async (r) => {
        submissions++;
        return { ok: true, runId: r.runId, reused: false };
      },
      cancel: async () => true,
      waitForQuiescence: async () => {},
      isLiveRun: () => false,
    },
    beforeSubmit: (input) => requireContinuousManagedGuards(undefined, input),
  });
  const scriptText = "return 1;";
  await assert.rejects(
    adapter.submitOnce({
      programId: "p",
      cycleId: "c",
      executionSessionId: "s",
      workflowRunId: "r",
      traceId: "t",
      executionPath: "/worktree",
      scriptText,
      scriptHash: createHash("sha256").update(scriptText).digest("hex"),
      configurationSnapshot: {},
    }),
    /guards are missing/,
  );
  assert.equal(submissions, 0);
});

test("发布2.1：真实 journal 时间保持稳定；所有运行节点有期限才认正常阻塞", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "r", status: "running" } as never);
  const first = journal.appendEvent("r", { type: "phase-entered", name: "work", ordinal: 0 });
  const evidence = createContinuousHealthEvidence(journal);
  assert.equal(evidence("r").lastProgressAt, first.timeCreated, "sequence 0 也不能漏读");
  t.mock.timers.setTime(2_000_000);
  assert.equal(evidence("r").lastProgressAt, first.timeCreated, "查询不刷新进展时间");
  journal.putNode({
    runId: "r",
    siteId: "a",
    ordinal: 0,
    kind: "ask",
    status: "running",
    inputHash: "h",
  } as never);
  journal.appendEvent("r", {
    type: "node-waiting",
    instance: { siteId: "a", ordinal: 0 } as never,
    cause: "backoff",
    reason: "rate_limited",
    delayMs: 7_200_000,
  });
  const wait = evidence("r").waitingFor;
  assert.equal(wait?.deadlineAt, 9_200_000);
  assert.ok(wait?.ownerId);
  journal.putNode({
    runId: "r",
    siteId: "b",
    ordinal: 0,
    kind: "ask",
    status: "running",
    inputHash: "h",
  } as never);
  assert.equal(evidence("r").waitingFor, undefined, "另一 actor 工作时不能豁免整轮计时");
  journal.putNode({
    runId: "r",
    siteId: "b",
    ordinal: 0,
    kind: "ask",
    status: "completed",
    inputHash: "h",
  } as never);
  journal.appendEvent("r", {
    type: "node-executing",
    instance: { siteId: "a", ordinal: 0 } as never,
  });
  assert.equal(evidence("r").waitingFor, undefined, "重试实际开始后取消等待证明");
});

test("发布2.1：文件与模型共享同一准入等待，停止后不能重新挂起绕过撤销", async () => {
  const adapter = createContinuousExecutionAdapter({
    journal: new InMemoryJournalStore(),
    reportReader: { listSequencedReportItems: () => [] },
    runService: {
      submitOnce: async (r) => ({ ok: true, runId: r.runId, reused: false }),
      cancel: async () => true,
      waitForQuiescence: async () => {},
      isLiveRun: () => false,
    },
  });
  const ref = { cycleId: "c", executionSessionId: "s", workflowRunId: "r", traceId: "t" };
  await adapter.suspendAtSafeBoundary(ref, "budget");
  let resumed = false;
  const waiting = adapter.waitForAdmission(ref).then(() => {
    resumed = true;
  });
  await Promise.resolve();
  assert.equal(resumed, false);
  await adapter.resumeSuspended(ref, 1);
  await waiting;
  assert.equal(resumed, true);
  await adapter.suspendAtSafeBoundary(ref, "time_limit");
  const revoked = adapter.waitForAdmission(ref);
  const rejection = assert.rejects(revoked, /revoked/);
  await adapter.stop(ref, "user_stop");
  await rejection;
  await assert.rejects(adapter.suspendAtSafeBoundary(ref, "budget"), /stopped by the user/);
});
