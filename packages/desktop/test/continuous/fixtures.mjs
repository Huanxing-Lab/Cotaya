// CT-09 测试 fixtures（docs/testing/continuous.md §3/§9）。
//
// - 可控时钟与 barrier：等待条件必须是 observable event/状态/文件事实，禁止「等 5 秒应该完成」。
//   barrier 先记录到达再放行故障注入（kill/ACK 丢失/乱序重复结果），超时即失败并留证据。
// - 临时 Git 仓库 fixture：Program worktree 的原始仓库（E-01/E-02/E-14 的 staged/unstaged/
//   untracked 保护断言来源）。git 全部走 argv，不用 shell 拼接；身份用 -c 注入，不写全局配置。
// - 进程控制器：只杀本 runner spawn 的进程树（E-17/R 用例的 forced kill 注入点）。
//
// 脚本化 provider 与目标应用分别在 fixturesProvider.mjs / fixturesTargetApp.mjs（行数拆分）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 事件 barrier：测试在业务事件到达后精确注入故障。
 * arrive() 挂起等待 release()；wait 超时抛错并返回已等待时长（写入失败证据）。
 */
export function createBarrier(name, { timeoutMs = 30_000 } = {}) {
  let arrived = false;
  let released = false;
  let timedOut = false;
  const waiters = [];
  const timer = setTimeout(() => {
    if (!released) {
      timedOut = true;
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error(`[barrier] ${name} 等待超时`));
    }
  }, timeoutMs);
  timer.unref?.();
  return {
    name,
    isArrived: () => arrived,
    isReleased: () => released,
    arrive() {
      if (arrived) return;
      arrived = true;
      if (released) for (const waiter of waiters.splice(0)) waiter.resolve();
    },
    release() {
      if (released) return;
      released = true;
      clearTimeout(timer);
      for (const waiter of waiters.splice(0)) waiter.resolve();
    },
    async wait() {
      if (released) return;
      await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (timedOut) reject(new Error(`[barrier] ${name} 已超时`));
      });
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * 可注入时钟（测试文档 §9）：区分墙钟 / 有效执行 / 已确认正常等待三类推进。
 * 只用于 Supervisor/预算窗口等测试组合注入；不触碰工作流 VM 的 Date/随机限制。
 */
export function createControllableClock({ startMs = Date.now() } = {}) {
  let nowMs = startMs;
  let effectiveMs = 0;
  let normalWaitMs = 0;
  let wallMs = 0;
  const listeners = new Set();
  return {
    now: () => nowMs,
    totals: () => ({ wallMs, effectiveMs, normalWaitMs }),
    /** 推进墙钟；countsAsEffective=false 且 normalWait=true 表示已确认正常等待区间（不计时）。 */
    advance(ms, { countsAsEffective = true, normalWait = false } = {}) {
      nowMs += ms;
      wallMs += ms;
      if (normalWait) normalWaitMs += ms;
      else if (countsAsEffective) effectiveMs += ms;
      for (const listener of listeners) listener({ at: nowMs, ms, countsAsEffective, normalWait });
      return this.totals();
    },
    onTick(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function git(repoDir, args) {
  // argv 直传不经 shell；-c 注入临时身份，避免读写用户全局 git 配置。
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "user.email=e2e@continuous.test", "-c", "user.name=Continuous E2E", ...args],
      { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`git ${args.join(" ")} exit=${code}: ${stderr}`)),
    );
  });
}

/**
 * 临时 Git 仓库 fixture：Program worktree 的原始仓库。
 * 初始内容包含已知 UI 问题页（由 target-app fixture 提供），首个 commit 为所选 HEAD。
 */
export async function createGitRepoFixture(run, { name = "origin-repo" } = {}) {
  const repoDir = run.assertInsideRoot(path.join(run.dirs.repositories, name), `git-repo:${name}`);
  mkdirSync(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  const { writeTargetAppFiles } = await import("./fixturesTargetApp.mjs");
  writeTargetAppFiles(repoDir);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "chore: initial fixture with known UI issues"]);
  return {
    dir: repoDir,
    git: (args) => git(repoDir, args),
    /** E-02：制造 staged / unstaged / untracked 三类未提交改动。 */
    async addUncommittedUserChanges() {
      await writeFile(path.join(repoDir, "staged-note.txt"), "staged by user\n", "utf8");
      await git(repoDir, ["add", "staged-note.txt"]);
      const styles = path.join(repoDir, "styles.css");
      const current = await readFile(styles, "utf8");
      await writeFile(styles, `${current}/* unstaged user edit */\n`, "utf8");
      writeFileSync(path.join(repoDir, "untracked-user-file.txt"), "untracked by user\n", "utf8");
    },
    /** 证据快照：HEAD、分支、porcelain 状态与跟踪文件清单。 */
    async snapshotState() {
      const [head, branch, status, files] = await Promise.all([
        git(repoDir, ["rev-parse", "HEAD"]),
        git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(repoDir, ["status", "--porcelain"]),
        git(repoDir, ["ls-files"]),
      ]);
      return {
        head: head.trim(),
        branch: branch.trim(),
        statusPorcelain: status.split("\n").filter(Boolean),
        trackedFiles: files.split("\n").filter(Boolean),
      };
    },
    async diffPatch() {
      return git(repoDir, ["diff", "HEAD"]);
    },
    async listBranches() {
      return (await git(repoDir, ["branch", "--list", "--format=%(refname:short)"]))
        .split("\n")
        .filter(Boolean);
    },
  };
}

/**
 * 进程控制器：登记本 runner spawn 的长驻进程，提供整树停止（E-17/R 的 forced kill）。
 * 只操作登记过的 pid；绝不按进程名清杀 Electron/Node（测试文档 §2 清理边界）。
 */
export function createProcessController() {
  const tracked = new Map();
  return {
    spawnTracked(label, command, args, options = {}) {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        ...options,
      });
      tracked.set(child.pid, { label, child });
      child.on("close", () => tracked.delete(child.pid));
      return child;
    },
    /** 跨平台停止整棵进程树：posix 用进程组负 pid；Windows 用 taskkill /T。 */
    async killTree(pid, { signal = "SIGKILL" } = {}) {
      const entry = tracked.get(pid);
      if (!entry) throw new Error(`[process] 未登记的 pid=${pid}，拒绝清理（隔离边界）`);
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("close", () => resolve());
          killer.on("error", () => resolve());
        });
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // 进程已退出：视为已停止。
        }
      }
    },
    async stopAll() {
      for (const pid of tracked.keys()) await this.killTree(pid).catch(() => {});
    },
  };
}
