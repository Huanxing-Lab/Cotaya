// CT-11（docs/tickets/continuous-release-gaps.md）：安全操作与可信验证。
//
// 先失败再修复的绕过回归（失败首跑见 docs/tickets/records/CT-11.md）：
// 1. 受限递归搜索——不能先读全目录再过滤文件名；逐个实际目标检查 Scope/forbidden/
//    protected/链接目标；允许路径的上级目录只用于导航。
// 2. 文件检查后替换 symlink 的竞态——realpath 检查通过后在准入等待窗口内把目标换成
//    指向受保护文件的符号链接，读写都必须被拒且零副作用。
//
// 其余为 CT-11 新能力的真实执行测试：
// 3. 受控 argv 测试端口——固定 cwd/环境/超时/输出/取消；真实 darwin seatbelt 隔离
//    自证（金丝雀不通过即 skip，不伪装）；request.sandbox.enabled 不构成证明。
// 4. 可信证据与提交门——缺任一阶段验证拒绝提交；提交只落 Program worktree。
// 5. 文件/行数上限——达到即同轮挂起（继续只增加本轮额度）；Decision 推迟立即撤写许可。
//
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node.test）。

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { guardContinuousActorIo } from "../../src/app/continuous-io-guards.js";
import type { ContinuousExecutionPolicyConfig } from "../../src/app/continuous-execution-policy.js";
import {
  createDarwinSeatbeltProvider,
  createPassthroughIsolationProvider,
} from "../../src/app/continuous-isolation.js";
import { createContinuousConfinedTestRunner } from "../../src/app/continuous-confined-execution.js";
import { createContinuousEvidenceRegistry } from "../../src/app/continuous-evidence.js";
import { createContinuousTrustedPorts } from "../../src/app/continuous-trusted-ports.js";
import { createContinuousCandidateGrantHolder } from "../../src/app/continuous-decision-adapter.js";
import type { ContinuousActorIoPolicy } from "../../src/app/continuous-io-guards.js";

interface PolicyOverrides {
  role?: "observer" | "builder" | "reviewer";
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  activeCandidate?: { candidateId: string; targetPaths: string[] } | null;
  onAdmission?: () => void | Promise<void>;
}

function makeConfig(
  root: string,
  worktree: string,
  overrides: PolicyOverrides = {},
): ContinuousExecutionPolicyConfig {
  return {
    executionPath: worktree,
    workspacePath: root,
    scope: {
      allowedPaths: overrides.allowedPaths ?? ["src/ui"],
      forbiddenPaths: overrides.forbiddenPaths ?? [],
      forbiddenCapabilities: ["push", "merge"],
    },
    declaredTestCommands: [],
    activeCandidate:
      overrides.activeCandidate === undefined
        ? { candidateId: "c1", targetPaths: ["src/ui"] }
        : overrides.activeCandidate,
    pathStyle: "posix",
    caseInsensitiveFs: false,
    platformExecutionMode: "autonomous",
  };
}

function makePolicy(config: ContinuousExecutionPolicyConfig, overrides: PolicyOverrides = {}) {
  let admissionCalls = 0;
  return {
    role: overrides.role ?? "builder",
    config: () => config,
    waitForAdmission: async () => {
      admissionCalls += 1;
      await overrides.onAdmission?.();
    },
    admissionCalls: () => admissionCalls,
  };
}

test("CT-11 受限递归搜索：逐个实际目标检查，越界/forbidden/protected/链接目标不进结果也不被读", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-search-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, "src/ui"), { recursive: true });
  await mkdir(join(worktree, "src/other"), { recursive: true });
  await mkdir(join(worktree, "src/ui/generated"), { recursive: true });
  // 允许路径内的正常目标。
  await writeFile(join(worktree, "src/ui/header.tsx"), "export const header = 'needle-ui';\n");
  // 允许路径内、forbidden 前缀下的目标。
  await writeFile(join(worktree, "src/ui/generated/gen.tsx"), "export const gen = 'needle-gen';\n");
  // 允许目录外（Scope 只允许 src/ui）。
  await writeFile(join(worktree, "src/other/other.tsx"), "export const other = 'needle-other';\n");
  // 允许目录内但受保护（lockfile 语义用 pnpm-lock.yaml 表示）。
  await writeFile(join(worktree, "src/ui/pnpm-lock.yaml"), "needle-lock\n");
  // 允许目录内但指向允许目录外的符号链接（链接目标越界）。
  await symlink(join(worktree, "src/other/other.tsx"), join(worktree, "src/ui/link.tsx"));
  // 一个指向允许目录内部文件的符号链接：目标合法，允许进入结果。
  await symlink(join(worktree, "src/ui/header.tsx"), join(worktree, "src/ui/self-link.tsx"));

  const config = makeConfig(root, worktree, { forbiddenPaths: ["src/ui/generated"] });
  const observer = guardContinuousActorIo(makePolicy(config, { role: "observer" }), {
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: { run: async () => ({}) as never },
  });

  const files = await observer.fileSystemPort.searchFiles({
    path: join(worktree, "src"),
    pattern: "*.tsx",
    maxResults: 100,
  });
  const names = files.files.map((path) => path.split("/").pop());
  assert.ok(names.includes("header.tsx"), "允许路径内的匹配必须返回");
  assert.ok(names.includes("self-link.tsx"), "指向允许目录内目标的链接可以返回");
  assert.ok(!names.includes("gen.tsx"), "forbidden 前缀下的目标不能进结果");
  assert.ok(!names.includes("other.tsx"), "允许路径之外的目标不能进结果");
  assert.ok(!names.includes("link.tsx"), "链接目标越界的符号链接不能进结果");

  const text = await observer.fileSystemPort.searchText({
    path: join(worktree, "src"),
    pattern: "needle-",
    outputMode: "content",
    showLineNumbers: true,
  });
  const textNames = text.entries.map((entry) => entry.path.split("/").pop());
  assert.ok(textNames.includes("header.tsx"), "允许目标的内容匹配必须返回");
  assert.ok(!textNames.includes("gen.tsx"), "forbidden 内容不能被读出");
  assert.ok(!textNames.includes("other.tsx"), "允许路径外内容不能被读出");
  assert.ok(!textNames.includes("link.tsx"), "越界链接目标内容不能被读出");
  assert.ok(!textNames.includes("pnpm-lock.yaml"), "受保护路径内容不能被读出");

  // 上级目录只用于导航：列目录返回条目名，但不因此获得其余文件读取权限。
  const listing = await observer.fileSystemPort.listDirectory({ path: join(worktree, "src") });
  assert.ok(listing.entries.some((entry) => entry.name === "other"));
  await assert.rejects(
    observer.fileSystemPort.readTextFile({ path: join(worktree, "src/other/other.tsx") }),
    /not_in_allowed_paths/,
  );
});

test("CT-11 检查后替换 symlink 的竞态：准入等待窗口内换链，读写被拒且零副作用", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, "src/ui"), { recursive: true });
  await mkdir(join(root, "protected"), { recursive: true });
  const allowedPath = join(worktree, "src/ui/header.tsx");
  const protectedPath = join(root, "protected/secret.ts");
  await writeFile(allowedPath, "public");
  await writeFile(protectedPath, "secret-content");

  // 攻击者：在检查通过之后（第二次准入等待时）把允许文件替换为指向受保护文件的符号链接。
  let admissions = 0;
  const attack = async () => {
    admissions += 1;
    if (admissions === 2) {
      await rm(allowedPath);
      await symlink(protectedPath, allowedPath);
    }
  };
  const config = makeConfig(root, worktree);
  const builder = guardContinuousActorIo(makePolicy(config, { onAdmission: attack }), {
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: { run: async () => ({}) as never },
  });

  await assert.rejects(
    builder.fileSystemPort.readTextFile({ path: allowedPath }),
    /symlink_escape|scope_denied/,
  );
  // 换链后重置，再测写入路径的同一竞态。
  admissions = 0;
  await rm(allowedPath);
  await writeFile(allowedPath, "public");
  await assert.rejects(
    builder.fileSystemPort.writeTextFile({ path: allowedPath, content: "attacker" }),
    /symlink_escape|scope_denied/,
  );
  assert.equal(await readFile(protectedPath, "utf8"), "secret-content", "受保护文件必须零副作用");
  // 符号链接本身残留也不能被后续操作利用：读取继续拒绝。
  await assert.rejects(
    builder.fileSystemPort.readTextFile({ path: allowedPath }),
    /symlink_escape|scope_denied/,
  );
});

// ── CT-11 第 3 条：受控 argv 测试端口（真实执行）────────────────

/** git fixture：原仓库 + Program worktree（独立分支），返回两者路径与分支名。 */
async function makeGitFixture(
  root: string,
): Promise<{ repo: string; worktree: string; branch: string }> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "fixture@test"], repo);
  git(["config", "user.name", "fixture"], repo);
  await writeFile(join(repo, "src-ui.ts"), "export const v = 1;\n");
  await mkdir(join(repo, "src"), { recursive: true }).catch(() => undefined);
  await writeFile(join(repo, "src", "nested.ts"), "export const n = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  const branch = "codex/continuous-fixture";
  const worktree = join(root, "worktree");
  git(["worktree", "add", "-q", "-b", branch, worktree], repo);
  return { repo, worktree, branch };
}

test("CT-11 受控 argv 测试执行：固定 cwd/环境、真实 seatbelt 隔离下外部写与网络被拒、输出落盘", async (t) => {
  const canaryRoot = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-sbx-")));
  t.after(() => rm(canaryRoot, { recursive: true, force: true }));
  const isolation = await createDarwinSeatbeltProvider({ canaryRoot });
  if (!isolation.verified) {
    t.skip(`darwin seatbelt 自证未通过，不伪装隔离：${JSON.stringify(isolation.verification)}`);
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-confined-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const outsideFile = join(root, "outside.txt");
  // 探针：记录 worktree 内写、外部写、网络、环境事实到 worktree 内的结果文件。
  await writeFile(
    join(worktree, "ct11-probe.js"),
    `const fs = require('fs');
const result = {
  insideWrite: true, outsideWrite: true, network: true,
  cwd: process.cwd(), tmpdir: process.env.TMPDIR, home: process.env.HOME, secret: process.env.CONTINUOUS_SECRET,
};
try { fs.writeFileSync('probe-inside.txt', 'x'); } catch { result.insideWrite = false; }
try { fs.writeFileSync(process.argv[2], 'x'); } catch { result.outsideWrite = false; }
fetch('https://example.com/').then(() => {
  result.network = true; finish();
}).catch(() => { result.network = false; finish(); });
function finish() { fs.writeFileSync('ct11-probe-result.json', JSON.stringify(result)); }
`,
    "utf8",
  );
  const config = makeConfig(root, worktree, {
    allowedPaths: ["."],
    activeCandidate: { candidateId: "c1", targetPaths: ["."] },
  });
  config.declaredTestCommands = [{ argv: ["node", "ct11-probe.js", outsideFile] }];
  const outputRoot = join(root, "outputs");
  const guard = guardContinuousActorIo(makePolicy(config), {
    testRunner: createContinuousConfinedTestRunner({
      executionPath: worktree,
      outputRoot,
      isolation,
    }),
  });
  const result = await guard.executionPort.run({
    command: { mode: "argv", file: "node", args: ["ct11-probe.js", outsideFile] },
    timeoutMs: 60_000,
  });
  assert.equal(result.status, "completed", `探针必须跑完：${JSON.stringify(result.stderr)}`);
  assert.equal(result.exitCode, 0);
  const probe = JSON.parse(
    await readFile(join(worktree, "ct11-probe-result.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(probe.insideWrite, true, "worktree 内写放行");
  assert.equal(probe.outsideWrite, false, "外部写被 OS 拒绝（真实隔离，不是策略声称）");
  assert.equal(probe.network, false, "出网被 OS 拒绝");
  assert.equal(probe.cwd, await realpath(worktree), "cwd 固定为 worktree");
  assert.notEqual(probe.tmpdir, tmpdir(), "TMPDIR 重定向进受控输出目录");
  assert.ok(
    typeof probe.home === "string" && !probe.home.includes(process.env.HOME ?? "@@"),
    "HOME 重定向",
  );
  assert.equal(probe.secret, undefined, "宿主环境变量不进入子进程");
  // 输出落盘（证据面）：stdout 证据文件存在于受控输出根内。
  const artifact = result.stdout.artifactPath;
  assert.ok(
    typeof artifact === "string" && artifact.startsWith(outputRoot),
    "stdout 证据必须在受控输出根内",
  );
  await access(artifact);
});

test("CT-11 受控执行：取消与超时杀整棵进程树（子进程也退出）", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-kill-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  await writeFile(
    join(worktree, "ct11-tree.js"),
    `const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'const fs=require("fs");fs.writeFileSync("child-alive.txt", String(process.pid));setInterval(()=>{},1000);'], { stdio: 'ignore', detached: false });
fs.writeFileSync('parent-alive.txt', String(process.pid));
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  const config = makeConfig(root, worktree, {
    allowedPaths: ["."],
    activeCandidate: { candidateId: "c1", targetPaths: ["."] },
  });
  config.declaredTestCommands = [{ argv: ["node", "ct11-tree.js"] }];
  const runner = createContinuousConfinedTestRunner({
    executionPath: worktree,
    outputRoot: join(root, "outputs"),
    isolation: createPassthroughIsolationProvider(),
  });
  const guard = guardContinuousActorIo(makePolicy(config), { testRunner: runner });
  const controller = new AbortController();
  const running = guard.executionPort.run(
    { command: { mode: "argv", file: "node", args: ["ct11-tree.js"] }, timeoutMs: 60_000 },
    { signal: controller.signal },
  );
  // 等两个 pid 文件出现（父进程与其子进程都已启动）。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [parent, child] = await Promise.all([
      readFile(join(worktree, "parent-alive.txt"), "utf8").catch(() => ""),
      readFile(join(worktree, "child-alive.txt"), "utf8").catch(() => ""),
    ]);
    if (parent && child) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const parentPid = Number(await readFile(join(worktree, "parent-alive.txt"), "utf8"));
  const childPid = Number(await readFile(join(worktree, "child-alive.txt"), "utf8"));
  controller.abort();
  const result = await running;
  assert.equal(result.status, "cancelled");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // 杀树后给 OS 一点回收时间再断言整棵树消失。
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(alive(parentPid), false, "父进程必须退出");
  assert.equal(alive(childPid), false, "子进程必须随进程树退出");
  // 超时路径：同 runner、短超时。
  await writeFile(join(worktree, "ct11-sleep.js"), "setInterval(() => {}, 1000);\n", "utf8");
  config.declaredTestCommands = [{ argv: ["node", "ct11-sleep.js"] }];
  const timed = await guard.executionPort.run({
    command: { mode: "argv", file: "node", args: ["ct11-sleep.js"] },
    timeoutMs: 300,
  });
  assert.equal(timed.status, "timed_out");
});

// ── CT-11 第 4/5 条：可信证据门与提交端口───────────────────────

interface TrustedHarness {
  root: string;
  repo: string;
  worktree: string;
  branch: string;
  guard: ReturnType<typeof guardContinuousActorIo>;
  trusted: ReturnType<typeof createContinuousTrustedPorts>;
  evidence: ReturnType<typeof createContinuousEvidenceRegistry>;
  grants: ReturnType<typeof createContinuousCandidateGrantHolder>;
  suspensions: Array<{ kind: string; projectedFiles: number; projectedChangedLines: number }>;
  limits: { maxFiles: number; maxChangedLines: number };
  browser: { outcome: "passed" | "failed" | "unverified" };
  baseCommit: string;
}

async function makeTrustedHarness(t: test.TestContext): Promise<TrustedHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-trusted-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, worktree, branch } = await makeGitFixture(root);
  const harness: TrustedHarness = {
    root,
    repo,
    worktree,
    branch,
    guard: undefined as never,
    trusted: undefined as never,
    evidence: createContinuousEvidenceRegistry(),
    grants: createContinuousCandidateGrantHolder(),
    suspensions: [],
    limits: { maxFiles: 10, maxChangedLines: 400 },
    browser: { outcome: "passed" },
    baseCommit: "",
  };
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  harness.baseCommit = baseCommit;
  // fixture 文件都落在候选授权内（policy 的 allowedPaths 与 grant targetPaths 同面）。
  const covered = ["src", "src-ui.ts", "extra.ts", "ct11-ok.js", "ct11-fail.js", "outside.ts"];
  const baseConfig = makeConfig(root, worktree, { allowedPaths: covered });
  // 声明测试命令：真实 node 进程（退出码 0）。
  await writeFile(join(worktree, "ct11-ok.js"), "process.exit(0);\n", "utf8");
  await writeFile(join(worktree, "ct11-fail.js"), "process.exit(2);\n", "utf8");
  baseConfig.declaredTestCommands = [{ argv: ["node", "ct11-ok.js"] }];
  // 与产品装配同语义：activeCandidate 每次 config() 都从 grants holder 现读——
  // 决策推迟撤销后写路径立即回到 candidate_inactive（不是静态快照）。
  const config: ContinuousExecutionPolicyConfig = new Proxy(baseConfig, {
    get(target, prop: keyof ContinuousExecutionPolicyConfig) {
      return prop === "activeCandidate" ? harness.grants.activeGrant() : target[prop];
    },
  });
  const policy: ContinuousActorIoPolicy = makePolicy(config);
  const evidence = harness.evidence;
  const grants = harness.grants;
  const identity = { programId: "p1", cycleId: "cy1", runId: "run-1", epoch: 7 };
  const trusted = createContinuousTrustedPorts({
    policy,
    identity: () => identity,
    baseCommit: () => baseCommit,
    evidence,
    testRunner: createContinuousConfinedTestRunner({
      executionPath: worktree,
      outputRoot: join(root, "outputs"),
      isolation: createPassthroughIsolationProvider(),
    }),
    browser: {
      check: async (input) => ({
        outcome: harness.browser.outcome,
        assertions: [{ kind: "browser", detail: `fixture ${input.widths.join("x")}` }],
        reason: harness.browser.outcome === "passed" ? "fixture 通过" : "fixture 不可用",
      }),
    },
    grants,
    changeLimits: () => harness.limits,
    suspendForChangeLimit: async (detail) => {
      harness.suspensions.push(detail);
    },
    outputRoot: join(root, "outputs"),
  });
  harness.trusted = trusted;
  harness.guard = guardContinuousActorIo(policy, {
    trusted,
    testRunner: createContinuousConfinedTestRunner({
      executionPath: worktree,
      outputRoot: join(root, "outputs"),
      isolation: createPassthroughIsolationProvider(),
    }),
  });
  return harness;
}

async function trustedRun(
  harness: TrustedHarness,
  file: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await harness.guard.executionPort.run({ command: { mode: "argv", file, args } });
  assert.equal(result.status, "completed", `trusted ${file} 必须以信封返回：${result.stderr.text}`);
  return JSON.parse(result.stdout.text) as Record<string, unknown>;
}

test("CT-11 提交门：缺任一阶段工具证据拒绝提交；模型/转述的 exitCode 0 不构成授权", async (t) => {
  const harness = await makeTrustedHarness(t);
  const key = "cand-1";
  const covered = ["src", "src-ui.ts", "extra.ts", "ct11-ok.js", "ct11-fail.js", "outside.ts"];
  assert.equal(harness.grants.authorize({ candidateId: key, targetPaths: covered }).ok, true);
  await writeFile(join(harness.worktree, "src-ui.ts"), "export const v = 2;\n", "utf8");

  // ① 什么证据都没有：review 文本说 passed 也拒绝（tests_missing——工具证据缺席）。
  let commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.status, "refused");
  assert.equal(commit.reason, "tests_missing");

  // ② 只有测试证据（工具端口真实跑过）：browser 证据仍缺 → 拒绝。
  const testRun = await trustedRun(harness, "continuous-test", [key, "0"]);
  assert.equal(testRun.status, "ok");
  assert.equal(testRun.exitCode, 0);
  assert.equal(testRun.isolationKey, "test-passthrough");
  commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.reason, "browser_missing");

  // ③ 浏览器证据（工具端口）+ review failed → 拒绝。
  await trustedRun(harness, "continuous-browser", [key]);
  commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "failed", findings: ["越界"] } }),
  ]);
  assert.equal(commit.reason, "review_failed");

  // ④ 测试事实后来变坏（最新结果语义）：exit 非 0 的重跑覆盖通过 → 拒绝提交。
  const evidence = harness.evidence;
  evidence.recordTest({
    programId: "p1",
    cycleId: "cy1",
    runId: "run-1",
    epoch: 7,
    candidateKey: key,
    argv: ["node", "ct11-fail.js"],
    exitCode: 2,
    status: "failed",
    stdoutPath: "-",
    stderrPath: "-",
    stdoutBytes: 0,
    stderrBytes: 0,
    durationMs: 1,
    isolationKey: "test-passthrough",
  });
  commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.reason, "tests_failed", "最新一次测试失败必须压过早前的通过");

  // ⑤ 全过（重新跑真实测试成功）→ 真实提交，只在 Program 分支上。
  const okAgain = await trustedRun(harness, "continuous-test", [key, "0"]);
  assert.equal(okAgain.exitCode, 0);
  // 工具端口证据关联 candidate/run/epoch（模型转述不携带这些身份）。
  const testEvidence = harness.evidence.latest(key, "tests");
  assert.ok(testEvidence, "tests 证据必须在册");
  assert.equal(testEvidence!.candidateKey, key);
  assert.equal(testEvidence!.runId, "run-1");
  assert.equal(testEvidence!.epoch, 7);
  await trustedRun(harness, "continuous-diff", [key]);
  commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: 真实提交",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.status, "ok", JSON.stringify(commit));
  const commitHash = commit.commit as string;
  assert.match(commitHash, /^[0-9a-f]{40}$/);
  // 分支上有该提交；原仓库工作树与 HEAD 分支不变（原仓库不改）。
  const branchLog = execFileSync("git", ["log", "-1", "--format=%H", harness.branch], {
    cwd: harness.repo,
    encoding: "utf8",
  }).trim();
  assert.equal(branchLog, commitHash, "提交落在 Program 分支");
  const repoHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: harness.repo,
    encoding: "utf8",
  }).trim();
  assert.equal(repoHead, harness.baseCommit, "原仓库 HEAD 不变");
  const repoStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: harness.repo,
    encoding: "utf8",
  });
  assert.equal(repoStatus.trim(), "", "原仓库工作树无变化");
  // 提交后 worktree 对应路径干净。
  const wtStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: harness.worktree,
    encoding: "utf8",
  });
  assert.equal(wtStatus.trim(), "", "提交后授权路径干净");
});

test("CT-11 提交前复查：只提交候选授权路径内改动，无关改动保留且不清理", async (t) => {
  const harness = await makeTrustedHarness(t);
  const key = "cand-2";
  assert.equal(harness.grants.authorize({ candidateId: key, targetPaths: ["src"] }).ok, true);
  // 授权路径内 + 之外的改动同时存在。
  await mkdir(join(harness.worktree, "src"), { recursive: true }).catch(() => undefined);
  await writeFile(join(harness.worktree, "src", "allowed.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(harness.worktree, "outside.ts"), "外部改动\n", "utf8");
  await trustedRun(harness, "continuous-test", [key, "0"]);
  await trustedRun(harness, "continuous-browser", [key]);
  await trustedRun(harness, "continuous-diff", [key]);
  const commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.status, "ok", JSON.stringify(commit));
  // 提交只含授权路径内文件。
  const committed = execFileSync(
    "git",
    ["show", "--name-only", "--format=", commit.commit as string],
    { cwd: harness.worktree, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.deepEqual(committed, ["src/allowed.ts"]);
  // 无关改动保留（不提交、不清理、不覆盖）。
  assert.equal(await readFile(join(harness.worktree, "outside.ts"), "utf8"), "外部改动\n");
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: harness.worktree,
    encoding: "utf8",
  });
  assert.ok(status.includes("outside.ts"), "无关改动保留在工作区");
});

test("CT-11 变更量上限：达到即同轮挂起（继续只增加本轮额度），Decision 推迟立即撤写许可", async (t) => {
  const harness = await makeTrustedHarness(t);
  const key = "cand-3";
  const covered3 = ["src", "src-ui.ts", "extra.ts", "ct11-ok.js", "ct11-fail.js", "outside.ts"];
  assert.equal(harness.grants.authorize({ candidateId: key, targetPaths: covered3 }).ok, true);
  harness.limits = { maxFiles: 1, maxChangedLines: 3 };
  // 超限改动：2 个文件、4 行。
  await writeFile(
    join(harness.worktree, "src-ui.ts"),
    "export const v = 2;\nexport const w = 3;\n",
    "utf8",
  );
  await writeFile(join(harness.worktree, "extra.ts"), "export const e = 1;\n", "utf8");
  const diff = await trustedRun(harness, "continuous-diff", [key]);
  assert.equal(diff.status, "suspended");
  assert.equal(diff.reason, "file_limit");
  assert.equal(harness.suspensions.length, 1, "挂起回调必须通知（Host 保存继续确认）");
  assert.equal(harness.suspensions[0]!.kind, "file_limit");
  // 用户「增加本轮额度」后：同一 worktree、同一证据链继续（不重置已用量）。
  harness.limits = { maxFiles: 10, maxChangedLines: 400 };
  const diffAfter = await trustedRun(harness, "continuous-diff", [key]);
  assert.equal(diffAfter.status, "ok");
  assert.ok((diffAfter.cumulative as Record<string, number>).files >= 2, "累计口径保留已消耗量");

  // Decision 推迟：撤销写许可后，写被拒且可信提交同样拒绝（candidate_inactive）。
  harness.grants.revokeActive("决策推迟");
  await assert.rejects(
    harness.guard.fileSystemPort.writeTextFile({
      path: join(harness.worktree, "src-ui.ts"),
      content: "x",
    }),
    /candidate_inactive/,
  );
  const commit = await trustedRun(harness, "continuous-commit", [
    key,
    "continuous: t",
    JSON.stringify({ review: { outcome: "passed", findings: [] } }),
  ]);
  assert.equal(commit.status, "refused");
  assert.equal(commit.reason, "candidate_inactive");
});

test("CT-11 未声明命令变体与任意 git 仍拒；只读角色不能经声明命令执行", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "continuous-ct11-deny-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const config = makeConfig(root, worktree, {
    allowedPaths: ["."],
    activeCandidate: { candidateId: "c", targetPaths: ["."] },
  });
  config.declaredTestCommands = [{ argv: ["node", "ok.js"] }];
  const runner = createContinuousConfinedTestRunner({
    executionPath: worktree,
    outputRoot: join(root, "outputs"),
    isolation: createPassthroughIsolationProvider(),
  });
  const observer = guardContinuousActorIo(makePolicy(config, { role: "observer" }), {
    testRunner: runner,
  });
  await assert.rejects(
    observer.executionPort.run({ command: { mode: "argv", file: "node", args: ["ok.js"] } }),
    /role_read_only/,
  );
  const builder = guardContinuousActorIo(makePolicy(config), { testRunner: runner });
  await assert.rejects(
    builder.executionPort.run({
      command: { mode: "argv", file: "node", args: ["ok.js", "--extra"] },
    }),
    /undeclared_command/,
  );
  await assert.rejects(
    builder.executionPort.run({ command: { mode: "argv", file: "git", args: ["add", "."] } }),
    /forbidden_capability/,
  );
  await assert.rejects(
    builder.executionPort.run({ command: { mode: "argv", file: "sh", args: ["-c", "echo hi"] } }),
    /undeclared_command/,
  );
});
