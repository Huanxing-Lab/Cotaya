// CT-10 平台实测（bootstrap 侧）：E-25（跨平台路径与取消）在当前真实机器上的执行面 +
// §13 平台能力降级（observe_only 只提供观察）。用例定义见 docs/testing/continuous.md §8。
//
// 与 scope.test.ts 的分工：那边是纯函数策略语义（假路径）；这边必须在**真实文件系统**上
// 采集事实（含空格/Unicode/大小写/symlink 的路径、进程树、argv 传递），并写证据 JSON
// （os.tmpdir 下，路径打印到 stdout，供 CT-10 记录引用）。Windows/Linux 上同样可运行；
// 未在本仓库验证过的平台不因本文件通过而视为已验证（登记表在 shared，评估函数独立断言）。
// 运行入口：node scripts/test-continuous.mjs --suite platform（tsx + node:test）。

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessContinuousPlatformExecution,
  CONTINUOUS_VERIFIED_PLATFORM_EXECUTION,
} from "@zcode/shared";
import {
  checkContinuousFilePath,
  checkContinuousGitOperation,
  checkContinuousShellCommand,
  type ContinuousExecutionPolicyConfig,
} from "../../src/app/continuous-execution-policy.js";

// 证据目录：路径含空格与 Unicode 本身就是被测事实的一部分（E-25「含空格/Unicode 路径」）。
const evidenceRoot = mkdtempSync(join(realpathSync(tmpdir()), "continuous-ct10-runtime 🚀-"));
const executionPath = join(evidenceRoot, "worktree 目标Dir");
const outsidePath = join(evidenceRoot, "outside 外部");
const elsewherePath = join(evidenceRoot, "elsewhere 别处");
mkdirSync(executionPath, { recursive: true });
mkdirSync(outsidePath, { recursive: true });
mkdirSync(elsewherePath, { recursive: true });

const evidence: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  evidenceRoot,
  executionPath,
};

/** 真实探测：写 Case 探针文件后按小写名 stat——不敏感 FS 上两个名字指向同一文件。 */
function detectCaseInsensitiveFs(): boolean {
  const probeDir = join(evidenceRoot, "case probe");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, "CaseFile.txt"), "probe");
  return existsSync(join(probeDir, "casefile.txt"));
}

const TREE_PARENT_PID: number[] = [];

after(() => {
  // 兜底：断言失败也把进程树收掉，不向测试环境泄漏心跳进程。
  for (const pid of TREE_PARENT_PID) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
      else process.kill(-pid, "SIGKILL");
    } catch {
      // 已退出：无事可做。
    }
  }
  const file = join(evidenceRoot, "evidence.json");
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[platform-runtime] evidence: ${file}`);
});

function makeConfig(
  overrides: Partial<ContinuousExecutionPolicyConfig> = {},
): ContinuousExecutionPolicyConfig {
  return {
    executionPath,
    workspacePath: outsidePath,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: [] },
    declaredTestCommands: [{ argv: [process.execPath, "-e", "0"] }],
    activeCandidate: { candidateId: "cand-ct10", targetPaths: ["src"] },
    pathStyle: "posix",
    // 真实文件系统大小写敏感性实测后填（策略行为必须与真实 FS 一致，不假定 APFS 形态）。
    caseInsensitiveFs: detectCaseInsensitiveFs(),
    platformExecutionMode: "autonomous",
    ...overrides,
  };
}

test("E-25/§13: 真实平台评估——登记表与评估函数一致；未登记平台 fail closed", () => {
  const assessment = assessContinuousPlatformExecution({
    platform: process.platform,
    arch: process.arch,
  });
  evidence.platformAssessment = assessment;
  evidence.fsCaseInsensitive = detectCaseInsensitiveFs();
  // 登记表是唯一事实源：本机 platformKey 在表内 ⇔ 评估为 autonomous。
  const registered = CONTINUOUS_VERIFIED_PLATFORM_EXECUTION[assessment.platformKey] !== undefined;
  assert.equal(assessment.verified, registered);
  assert.equal(assessment.mode, registered ? "autonomous" : "observe_only");
  // 未登记平台（win32/linux 在本仓库未实测）必须评估为 observe_only，不凭代码审查放行。
  for (const unverified of [
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "x64" },
  ]) {
    const result = assessContinuousPlatformExecution(unverified);
    assert.equal(result.mode, "observe_only", `${unverified.platform} 未验证必须只读观察`);
    assert.equal(result.reason, "platform_not_verified");
  }
});

test("E-25: 含空格/Unicode 的真实路径——读放行、写按平台与角色裁决", () => {
  const config = makeConfig();
  const relative = "src/组件 Component.tsx";
  mkdirSync(join(executionPath, "src"), { recursive: true });
  writeFileSync(join(executionPath, relative), "export const a = 1;\n");

  const read = checkContinuousFilePath(config, {
    role: "observer",
    operation: "read",
    path: relative,
  });
  assert.equal(read.allowed, true, "观察角色读真实含空格/Unicode 路径必须放行");

  const write = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    path: relative,
  });
  assert.equal(write.allowed, true, "autonomous 平台 builder 写同一路径必须放行");

  const traversal = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    // elsewhere 是 executionPath 之外、也不是原始仓库的第三目录：traversal 归一后按
    // outside_execution_path 拒绝（原始仓库路径另有更明确的原因，见大小写用例）。
    path: "src/../../elsewhere 别处/x.ts",
  });
  assert.equal(traversal.allowed, false);
  assert.equal(traversal.reason, "outside_execution_path");
  evidence.paths = {
    relative,
    read: read.allowed,
    write: write.allowed,
    traversal: traversal.reason,
  };
});

test("E-25: 真实 symlink——指向外部拒绝（symlink_escape），指向 worktree 内放行", () => {
  const config = makeConfig();
  mkdirSync(join(executionPath, "src"), { recursive: true });
  writeFileSync(join(outsidePath, "外部 target.md"), "outside\n");
  const escapeLink = join(executionPath, "src", "逃逸 link.md");
  symlinkSync(join(outsidePath, "外部 target.md"), escapeLink);
  const denied = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    path: "src/逃逸 link.md",
    resolvedRealPath: realpathSync(escapeLink),
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "symlink_escape");

  const insideTarget = join(executionPath, "src", "真实 target.md");
  writeFileSync(insideTarget, "inside\n");
  const innerLink = join(executionPath, "src", "内部 link.md");
  symlinkSync(insideTarget, innerLink);
  const allowed = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    path: "src/内部 link.md",
    resolvedRealPath: realpathSync(innerLink),
  });
  assert.equal(allowed.allowed, true, "指向 worktree 内部的 symlink 不是逃逸");
  evidence.symlinks = { escapeReason: denied.reason, innerAllowed: allowed.allowed };
});

test("E-25: 大小写——策略与真实文件系统敏感性一致，不借字符串差异绕过", () => {
  const insensitive = detectCaseInsensitiveFs();
  const config = makeConfig({ caseInsensitiveFs: insensitive });
  mkdirSync(join(executionPath, "src"), { recursive: true });
  writeFileSync(join(executionPath, "src", "CaseFile.ts"), "x\n");
  const variant = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    // 不敏感 FS 上这是同一文件（放行 = 可写既有文件）；敏感 FS 上是另一条路径，但仍在
    // Scope 与候选路径（src）内。两种敏感性下都不允许借大小写变体越出授权范围。
    path: "src/casefile.ts",
    ...(insensitive
      ? { resolvedRealPath: realpathSync(join(executionPath, "src", "CaseFile.ts")) }
      : {}),
  });
  assert.equal(variant.allowed, true);

  // 越界目录的大小写变体：无论 FS 敏感性如何都必须拒绝（不敏感 FS 上按折叠后包含判定
  // 命中原始仓库 → original_workspace_out_of_scope；敏感 FS 上 → outside_execution_path）。
  const outsideVariant = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    path: realpathSync(outsidePath).toUpperCase().concat("/x.ts"),
  });
  assert.equal(outsideVariant.allowed, false);
  assert.ok(
    outsideVariant.reason === "outside_execution_path" ||
      outsideVariant.reason === "original_workspace_out_of_scope",
  );
  evidence.caseSensitivity = { insensitive, variantAllowed: variant.allowed };
});

test("E-25: 声明命令 argv 真实传递——空格/Unicode 单参数不经 shell 重释", async () => {
  const config = makeConfig();
  const magicArg = "参数 with spaces/路径 🚀'\"quote.bin";
  // 与产品同一机制：spawn(file, argv) 直传（规格 §7「使用 argv 而非 shell 拼接」）。
  // -e 脚本把收到的 argv 原样打印，验证 shell 元字符/空格/Unicode 不被二次解释。
  const argvOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv))", "--", magicArg],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`argv 探针退出码 ${code}`)),
    );
  });
  const received = JSON.parse(argvOutput) as string[];
  assert.equal(
    received.filter((part) => part === magicArg).length,
    1,
    "argv 必须逐字节原样到达子进程（无 shell 拼接/拆参）",
  );
  assert.equal(received[received.length - 1], magicArg, "参数保持单个 argv 条目到末位");
  evidence.argvProbe = { arg: magicArg, received };

  // 命令白名单：与声明完全一致的 argv 放行；任何变体（注入/拆参/换命令）拒绝。
  const declared = checkContinuousShellCommand(config, {
    role: "builder",
    argv: [process.execPath, "-e", "0"],
  });
  assert.equal(declared.allowed, true);
  const mutated = checkContinuousShellCommand(config, {
    role: "builder",
    argv: [process.execPath, "-e", "0; rm -rf /"],
  });
  assert.equal(mutated.allowed, false);
  assert.equal(mutated.reason, "undeclared_command", "变体 argv 不等于声明，必须拒绝");
});

test("§13/E-24: observe_only 平台——写入/命令/提交全拒（platform_read_only），读照常", () => {
  const config = makeConfig({ platformExecutionMode: "observe_only" });
  mkdirSync(join(executionPath, "src"), { recursive: true });
  writeFileSync(join(executionPath, "src", "既有 file.ts"), "x\n");

  const read = checkContinuousFilePath(config, {
    role: "observer",
    operation: "read",
    path: "src/既有 file.ts",
  });
  assert.equal(read.allowed, true, "observe_only 平台观察（读）不受影响");

  const write = checkContinuousFilePath(config, {
    role: "builder",
    operation: "write",
    path: "src/既有 file.ts",
  });
  assert.equal(write.allowed, false);
  assert.equal(write.reason, "platform_read_only", "连 builder 也只有读");

  const del = checkContinuousFilePath(config, {
    role: "builder",
    operation: "delete",
    path: "src/既有 file.ts",
  });
  assert.equal(del.reason, "platform_read_only");

  const command = checkContinuousShellCommand(config, {
    role: "builder",
    argv: [process.execPath, "-e", "0"],
  });
  assert.equal(command.reason, "platform_read_only", "声明测试命令同样不开放");

  const commit = checkContinuousGitOperation(config, {
    role: "builder",
    operation: "commit",
    verification: { testsPassed: true, browserVerified: true, reviewPassed: true },
  });
  assert.equal(commit.reason, "platform_read_only", "三验证全过的本地提交也不做（不开放自动实施）");
  evidence.observeOnly = {
    read: read.allowed,
    write: write.reason,
    command: command.reason,
    commit: commit.reason,
  };
});

// 三层进程树脚本：每层打印 {pid, role} 后心跳保活；断言前由父进程组整棵取消。
const HEARTBEAT = "setInterval(() => {}, 1000);";
const REPORT = (role: string) =>
  `process.stdout.write(JSON.stringify({ pid: process.pid, role: "${role}" }) + "\\n");`;
const GRANDCHILD = `${REPORT("grandchild")}${HEARTBEAT}`;
const CHILD = `
  const { spawn } = require("node:child_process");
  ${REPORT("child")}
  spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { stdio: "inherit" });
  ${HEARTBEAT}
`;
const PARENT = `
  const { spawn } = require("node:child_process");
  ${REPORT("parent")}
  spawn(process.execPath, ["-e", ${JSON.stringify(CHILD)}], { stdio: "inherit" });
  ${HEARTBEAT}
`;

test("E-25: 进程树取消——杀掉所属进程组后整棵树消失（posix 实测；win32 分支待验证）", async () => {
  const parent = spawn(process.execPath, ["-e", PARENT], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    // detached: 新进程组（posix）——与产品「取消整棵所属进程树」同一机制。
    detached: process.platform !== "win32",
  });
  TREE_PARENT_PID.push(parent.pid!);
  let output = "";
  parent.stdout.on("data", (chunk) => (output += chunk.toString()));
  // 可观察事件而非固定 sleep：等齐三层 pid 上报（带 10s 上限）。
  const deadline = Date.now() + 10_000;
  const pids: number[] = [parent.pid!];
  const reportedRoles = new Set<string>();
  while (Date.now() < deadline) {
    for (const match of output.matchAll(/\{"pid":(\d+),"role":"(\w+)"\}/g)) {
      const pid = Number(match[1]);
      if (!pids.includes(pid)) pids.push(pid);
      reportedRoles.add(match[2]!);
    }
    if (reportedRoles.has("child") && reportedRoles.has("grandchild")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    reportedRoles.has("child") && reportedRoles.has("grandchild"),
    `进程树三层未齐（roles=${[...reportedRoles]}，output=${output}）`,
  );

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const pid of pids) assert.ok(alive(pid), `取消前 pid ${pid} 应存活`);

  // 取消整棵树：posix 杀负 pgid；win32 走 taskkill /T（分支保留，本机 darwin 实测 posix 路径）。
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(parent.pid), "/T", "/F"]);
  } else {
    process.kill(-parent.pid!, "SIGKILL");
  }
  // 以 ESRCH 为准的宽限轮询（不是「等 5 秒应该死了」）。
  const goneDeadline = Date.now() + 10_000;
  let allGone = false;
  while (Date.now() < goneDeadline) {
    allGone = pids.every((pid) => !alive(pid));
    if (allGone) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  evidence.processTree = {
    pids,
    roles: [...reportedRoles],
    killStrategy: process.platform === "win32" ? "taskkill /T /F" : "kill(-pgid, SIGKILL)",
    allGone,
    verifiedOn: `${process.platform}/${process.arch}`,
  };
  assert.ok(allGone, `进程树未整棵取消，存活: ${JSON.stringify(pids.filter(alive))}`);
});
