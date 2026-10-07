// CT-09 runner 自检（快速、不启动 Electron；归入 CT-00 runner 的 unit suite manifest）。
//
// 覆盖两类要求（ticket CT-09）：
// 1. 隔离校验：临时根创建、路径越界拒绝（含 symlink 逃逸）、隔离环境变量逐个在根内；
//    bridge 双重条件——bridgeRunId 为空时不得设置任何测试桥变量。
// 2. suite 缺失非零：CT-00 runner 对空 manifest suite（missing）、未知 suite（usage）与
//    未授权 live（blocked）都必须非零退出，绝不打印通过。
// 另外 barrier/时钟/脚本化 provider/目标应用/git fixture 的行为基线在这里锁定，
// 供 e2e/mobile/live suite 复用（真实 Electron 链路不在本文件启动）。

import { execFile } from "node:child_process";
import { existsSync, realpathSync, symlinkSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT, buildIsolationEnv, createTestRun, stopRunResources } from "./runner.mjs";
import { createBarrier, createControllableClock, createGitRepoFixture } from "./fixtures.mjs";
import { createScriptedProvider } from "./fixturesProvider.mjs";
import { createTargetAppServer } from "./fixturesTargetApp.mjs";
import { sanitizeText } from "./evidence.mjs";

function runNode(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ exitCode: error?.code ?? 0, stdout: `${stdout}${stderr}` }),
    );
  });
}

test("隔离：testRun 目录全部落在系统临时根下", () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    const tmpReal = realpathSync(os.tmpdir());
    assert.ok(
      realpathSync(run.root).startsWith(`${tmpReal}${path.sep}`),
      `root 应在 os.tmpdir 下: ${run.root}`,
    );
    for (const dir of Object.values(run.dirs)) {
      assert.ok(existsSync(dir), `目录未创建: ${dir}`);
      assert.equal(run.assertInsideRoot(dir, "selfcheck-dir"), realpathSync(dir));
    }
  } finally {
    void rm(run.root, { recursive: true, force: true });
  }
});

test("隔离：越界路径与 symlink 逃逸必须被拒绝", () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    assert.throws(() => run.assertInsideRoot(os.homedir(), "home"), /越出临时根/);
    assert.throws(() => run.assertInsideRoot(REPO_ROOT, "repo"), /越出临时根/);
    const outside = mkdtempSync(path.join(os.tmpdir(), "continuous-outside-"));
    try {
      const link = path.join(run.root, "escape-link");
      symlinkSync(outside, link);
      assert.throws(() => run.assertInsideRoot(link, "symlink-escape"), /越出临时根/);
    } finally {
      void rm(outside, { recursive: true, force: true });
    }
  } finally {
    void rm(run.root, { recursive: true, force: true });
  }
});

test("隔离环境：路径变量逐个校验；bridge 缺 run ID 时不得开启", () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    const plain = buildIsolationEnv(run);
    assert.equal(plain.VITE_ZCODE_E2E_STORE_BRIDGE, undefined);
    assert.equal(plain.ZCODE_E2E_RUN_ID, undefined);
    const bridged = buildIsolationEnv(run, { bridgeRunId: run.testRunId });
    assert.equal(bridged.VITE_ZCODE_E2E_STORE_BRIDGE, "1");
    assert.equal(bridged.ZCODE_E2E_RUN_ID, run.testRunId);
    // 任何路径型变量越界（这里把 HOME 指到临时根外）都必须在校验期抛错。
    const broken = { ...run, dirs: { ...run.dirs, home: os.homedir() } };
    assert.throws(() => buildIsolationEnv(broken, {}), /越出临时根/);
  } finally {
    void rm(run.root, { recursive: true, force: true });
  }
});

test("barrier：到达-释放事件序与超时失败", async () => {
  const barrier = createBarrier("selfcheck", { timeoutMs: 50 });
  assert.equal(barrier.isArrived(), false);
  const waiting = barrier.wait();
  barrier.arrive();
  assert.equal(barrier.isArrived(), true);
  barrier.release();
  await waiting;
  const timeoutBarrier = createBarrier("timeout", { timeoutMs: 30 });
  timeoutBarrier.arrive();
  await assert.rejects(() => timeoutBarrier.wait(), /超时/);
  timeoutBarrier.dispose();
});

test("可控时钟：墙钟/有效/正常等待三计数", () => {
  const clock = createControllableClock({ startMs: 1_000 });
  clock.advance(10_000);
  clock.advance(5_000, { normalWait: true });
  clock.advance(1_000, { countsAsEffective: false, normalWait: false });
  assert.deepEqual(clock.totals(), { wallMs: 16_000, effectiveMs: 10_000, normalWaitMs: 5_000 });
  assert.equal(clock.now(), 17_000);
});

test("脚本化 provider：脚本步进、barrier、故障与 usage 记录", async () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    const provider = createScriptedProvider(run);
    const baseUrl = await provider.url();
    await provider.control.setScript({
      steps: [
        { barrier: "before-first", content: "hello" },
        { fault: { kind: "transient", status: 502 } },
        { fault: { kind: "drop-usage" }, content: "no usage" },
      ],
    });
    const first = fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.control.barrierState("before-first").arrived, true);
    provider.control.release("before-first");
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.match(JSON.stringify(await firstResponse.json()), /hello/);
    const transient = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(transient.status, 502);
    const dropped = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    const droppedBody = await dropped.json();
    assert.equal(droppedBody.usage, undefined, "drop-usage：响应不带 usage（账本须保留 unknown）");
    assert.equal(provider.facts().requestCount, 3);
    const usage = (await readFile(provider.facts().usageFile, "utf8")).trim().split("\n");
    assert.equal(usage.length, 1, "只有第一笔请求发布 usage");
    assert.equal(JSON.parse(usage[0]).requestKey, "req-1");
  } finally {
    // 失败路径也必须关服务器，否则监听 socket 会挂住整个 node --test 进程。
    await stopRunResources(run);
    await rm(run.root, { recursive: true, force: true });
  }
});

test("目标应用 fixture：三个已知问题使自测命令失败（初始态）", async () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    const repo = await createGitRepoFixture(run, { name: "target-check" });
    const verify = await runNode([path.join(repo.dir, "test", "verify.mjs"), "--json"]);
    assert.notEqual(verify.exitCode, 0, "初始 fixture 必须处于已知问题状态（自测失败）");
    const parsed = JSON.parse(verify.stdout.trim().split("\n").at(-1));
    assert.deepEqual(parsed.failures, [
      "header-padding-too-small",
      "sidebar-overflow-at-390",
      "empty-state-contrast-below-4-5",
    ]);
    const server = createTargetAppServer(run, { repoDir: repo.dir });
    const url = await server.url();
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /target-app-sidebar/);
    // fetch 会按 URL 规则归一化 ../；原始 ../ 请求被 HTTP 层以 400 拒绝——两种路径都拿不到文件。
    const traversal = await new Promise((resolve, reject) => {
      const req = httpRequest(
        new URL(url),
        { path: "../../../etc/passwd", method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.notEqual(traversal.status, 200, "traversal 请求不得返回 200");
    assert.ok(!traversal.body.includes("root:"), "不得泄漏 /etc/passwd 内容");
    await server.close();
  } finally {
    await stopRunResources(run);
    await rm(run.root, { recursive: true, force: true });
  }
});

test("git fixture：staged/unstaged/untracked 快照可区分", async () => {
  const run = createTestRun({ suiteLabel: "selfcheck" });
  try {
    const repo = await createGitRepoFixture(run, { name: "git-check" });
    const before = await repo.snapshotState();
    assert.equal(before.statusPorcelain.length, 0);
    assert.ok(before.trackedFiles.includes("index.html"));
    await repo.addUncommittedUserChanges();
    const after = await repo.snapshotState();
    const staged = after.statusPorcelain.filter(
      (line) => line.startsWith("A ") || line.startsWith("M "),
    );
    const unstaged = after.statusPorcelain.filter(
      (line) => line.startsWith(" M") || line.startsWith("MM"),
    );
    const untracked = after.statusPorcelain.filter((line) => line.startsWith("??"));
    assert.equal(staged.length, 1);
    assert.equal(unstaged.length, 1);
    assert.equal(untracked.length, 1);
    assert.equal(after.head, before.head, "未提交改动不产生新提交");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("脱敏：凭据与 home 路径不落盘", () => {
  const home = os.homedir();
  const sample = `Authorization: Bearer sk-abcdef1234567890\npath=${home}/secret\napi_key: "abcdefgh1234"`;
  const sanitized = sanitizeText(sample);
  assert.ok(!sanitized.includes("sk-abcdef1234567890"), "bearer token 必须打码");
  assert.ok(!sanitized.includes(home), "home 路径必须折叠为 ~");
  assert.ok(!/api_key: "abcdefgh1234"/.test(sanitized), "api key 必须打码");
});

test("CT-00 runner：空 manifest suite 非零退出且标 missing", async () => {
  // CT-10 起 platform/regression 都有真实 manifest；空 manifest 语义改用脚本副本验证：
  // 副本放在 scripts/ 下（repoRoot 解析不变），把 platform suite 的 files 置空后运行。
  // 随机后缀防并发自检互踩；finally 删除，不向仓库留临时文件。
  const { writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const tempName = `.test-continuous-selfcheck-${randomUUID().slice(0, 8)}.mjs`;
  const tempScript = path.join(REPO_ROOT, "scripts", tempName);
  const source = await readFile(path.join(REPO_ROOT, "scripts", "test-continuous.mjs"), "utf8");
  const patched = source.replace(
    /platform:\s*\{[^{}]*\},/,
    'platform: { description: "selfcheck-empty", kind: "node-test", files: [] },',
  );
  assert.notEqual(patched, source, "platform suite 块未被替换（自检正则失配时大声失败）");
  try {
    await writeFile(tempScript, patched, "utf8");
    const result = await runNode([`scripts/${tempName}`, "--suite", "platform"]);
    assert.notEqual(result.exitCode, 0, "missing suite 不能退出 0");
    assert.match(result.stdout, /"status": "missing"/);
    assert.doesNotMatch(result.stdout, /"status": "passed"/);
  } finally {
    await rm(tempScript, { force: true });
  }
});

test("CT-00 runner：未知 suite 非零退出（usage 错误）", async () => {
  const result = await runNode(["scripts/test-continuous.mjs", "--suite", "bogus"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /未知 suite/);
});

test("CT-00 runner：未授权 live 非零退出且标 blocked", async () => {
  const result = await runNode(["scripts/test-continuous.mjs", "--suite", "live"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /"status": "blocked"/);
  assert.match(result.stdout, /--allow-live/);
});

test("报告契约：e2e/mobile/live/regression 入口与 platform manifest 存在（CT-10 起）", () => {
  for (const entry of ["e2e.test.mjs", "mobile.test.mjs", "live.test.mjs", "regression.test.mjs"]) {
    assert.ok(
      existsSync(path.join(REPO_ROOT, "packages/desktop/test/continuous", entry)),
      `缺少 ${entry}`,
    );
  }
  for (const file of [
    "packages/services/test/continuous/platform.test.ts",
    "apps/zcode-cli/packages/bootstrap/test/continuous/platform-runtime.test.ts",
  ]) {
    assert.ok(existsSync(path.join(REPO_ROOT, file)), `platform manifest 条目缺失: ${file}`);
  }
});
