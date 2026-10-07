// ============================================================
// Continuous 可信 Git 读面（CT-11 第 4/5 条）
// ============================================================
// trusted ports 专用的 Git 事实采集与提交执行：由受信代码直接 spawn git（argv 固定、
// 绝不经 shell、env 最小、输出有界），不经 actor 的任何端口——actor 无 Git 写能力
//（io-guards 对 mutating git 恒拒），提交只能走本模块（受三阶段证据门约束）。
//
// 提交身份固定（-c user.name/-c user.email）：不依赖 worktree 里可能缺失或被改写的
// 用户级 git 配置；每条提交可归因到本功能。

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";

const GIT_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 最小环境：不给 git 任何宿主凭据/HOME 之外的上下文。 */
const GIT_ENV: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

export async function runTrustedGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  return await new Promise((resolve) => {
    const child = spawn("git", [...args], { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出。 */
      }
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes <= GIT_OUTPUT_CAP_BYTES) stdoutChunks.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes <= 64 * 1024) stderrChunks.push(chunk);
      stderrBytes += chunk.byteLength;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/**
 * 候选授权路径是否覆盖某个 repo 相对文件（段前缀语义；"." 与 "" 视为全仓授权）。
 * evidence 提交门与 trusted 提交前复查共用这一份实现——两处各写一份迟早分叉。
 */
export function continuousPathPrefixCovers(prefix: string, file: string): boolean {
  const normalized = prefix
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (normalized === "" || normalized === ".") return true;
  const segments = file.split("/").filter((segment) => segment.length > 0);
  const prefixSegments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => segment === segments[index]);
}

export interface GitStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
  staged: boolean;
}

/**
 * 工作区状态（含 untracked）。-z 输出的 rename 双 token（"XY new\0old"）在整体解析中
 * 消费；oldPath 一并给出（rename 的旧路径在变更量口径里占一个独立文件名额，规格 §2）。
 */
export async function gitStatusEntries(cwd: string): Promise<GitStatusEntry[]> {
  // -uall：untracked 目录展开成逐文件条目（默认折叠成 "dir/" 一条，文件名额会漏计）。
  const result = await runTrustedGit(cwd, ["status", "--porcelain", "-z", "-uall"]);
  if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.slice(0, 400)}`);
  const tokens = result.stdout.split("\0").filter((token) => token.length > 0);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const statusCode = token.slice(0, 2);
    const path = token.slice(3);
    const isRename = statusCode[0] === "R";
    const oldPath = isRename ? tokens[index + 1] : undefined;
    if (isRename) index += 1;
    entries.push({
      status: statusCode.trim() || "?",
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      staged: statusCode[0] !== " " && statusCode[0] !== "?",
    });
  }
  return entries;
}

export interface GitDiffStats {
  changedFiles: string[];
  added: number;
  removed: number;
  binaryFiles: number;
}

/**
 * `git diff --numstat <base>` 的解析：binary 行是 "-\t-\tpath"（计文件不计行）。
 */
export function parseGitNumstat(raw: string): GitDiffStats {
  const changed = new Set<string>();
  let added = 0;
  let removed = 0;
  let binaryFiles = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const [addedPart, removedPart, pathPart] = line.split("\t");
    if (pathPart === undefined || addedPart === undefined || removedPart === undefined) continue;
    changed.add(pathPart);
    if (addedPart === "-" || removedPart === "-") {
      binaryFiles += 1;
      continue;
    }
    added += Number.parseInt(addedPart, 10) || 0;
    removed += Number.parseInt(removedPart, 10) || 0;
  }
  return { changedFiles: [...changed].sort(), added, removed, binaryFiles };
}

/**
 * untracked 文件行数：内容按行计（新增口径）。binary/超大文件按 0 行计但文件名仍
 * 计入（规格 §2「binary 计文件不计行」；测试运行在 worktree 里的构建产物不该把行数
 * 预算炸穿）。NUL 字节视为 binary；超过 1MB 不逐行统计。
 */
async function untrackedLineCount(cwd: string, path: string): Promise<number> {
  try {
    const handle = await open(join(cwd, path), "r");
    try {
      const probe = Buffer.alloc(8192);
      const first = await handle.read(probe, 0, probe.byteLength, 0);
      const sample = probe.subarray(0, first.bytesRead);
      if (sample.includes(0)) return 0;
      const { size } = await handle.stat();
      if (size > 1024 * 1024) return 0;
      const whole = Buffer.alloc(size);
      const readResult = await handle.read(whole, 0, size, 0);
      const text = whole.subarray(0, readResult.bytesRead).toString("utf8");
      return text.length === 0 ? 0 : text.split("\n").length;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return 0;
  }
}

export interface WorkspaceDiffSummary extends GitDiffStats {
  untrackedFiles: string[];
}

/** 工作区相对 HEAD 的当前改动（tracked diff + untracked 文件/行数）。 */
export async function gitWorkspaceDiff(cwd: string): Promise<WorkspaceDiffSummary> {
  const [numstat, status] = await Promise.all([
    runTrustedGit(cwd, ["diff", "--numstat", "HEAD"]),
    gitStatusEntries(cwd),
  ]);
  const tracked = parseGitNumstat(numstat.exitCode === 0 ? numstat.stdout : "");
  // porcelain 的 untracked 状态码是 "??"（trim 不会变成 "?"）：按前缀判，不能漏计。
  const untrackedFiles = status
    .filter((entry) => entry.status.startsWith("?"))
    .map((entry) => entry.path);
  let untrackedLines = 0;
  for (const path of untrackedFiles) {
    untrackedLines += await untrackedLineCount(cwd, path);
  }
  return {
    changedFiles: [...new Set([...tracked.changedFiles, ...untrackedFiles])].sort(),
    added: tracked.added + untrackedLines,
    removed: tracked.removed,
    binaryFiles: tracked.binaryFiles,
    untrackedFiles,
  };
}

/**
 * 相对单轮起始 commit 的累计改动（规格 §2：按相对单轮起始 commit 的累计实际 diff 计算；
 * 本轮内已提交的改动自然包含在内），加上当前工作区未提交部分。
 */
export async function gitCumulativeDiff(
  cwd: string,
  baseCommit: string,
): Promise<WorkspaceDiffSummary> {
  const [numstat, status] = await Promise.all([
    runTrustedGit(cwd, ["diff", "--numstat", baseCommit]),
    gitStatusEntries(cwd),
  ]);
  const tracked = parseGitNumstat(numstat.exitCode === 0 ? numstat.stdout : "");
  // porcelain 的 untracked 状态码是 "??"（trim 不会变成 "?"）：按前缀判，不能漏计。
  const untrackedFiles = status
    .filter((entry) => entry.status.startsWith("?"))
    .map((entry) => entry.path);
  let untrackedLines = 0;
  for (const path of untrackedFiles) {
    untrackedLines += await untrackedLineCount(cwd, path);
  }
  const renamedOld = status
    .filter((entry) => entry.oldPath !== undefined)
    .map((entry) => entry.oldPath as string);
  return {
    changedFiles: [...new Set([...tracked.changedFiles, ...untrackedFiles, ...renamedOld])].sort(),
    added: tracked.added + untrackedLines,
    removed: tracked.removed,
    binaryFiles: tracked.binaryFiles,
    untrackedFiles,
  };
}

/** 当前 HEAD（短 hash 足够报告引用；full 由调用方按需 rev-parse）。 */
export async function gitHeadCommit(cwd: string): Promise<string | undefined> {
  const result = await runTrustedGit(cwd, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim();
}

/**
 * 受信本地提交：add 指定 pathspec + pathspec 限定 commit（不卷入无关 staged 内容）+
 * 复核这些路径已干净。任何一步失败都返回结构化失败，不产生半提交状态。
 */
export async function gitCommitPaths(
  cwd: string,
  message: string,
  paths: readonly string[],
  identity: { name: string; email: string },
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  if (paths.length === 0) return { ok: false, error: "no paths to commit" };
  const add = await runTrustedGit(cwd, ["add", "--", ...paths]);
  if (add.exitCode !== 0)
    return { ok: false, error: `git add failed: ${add.stderr.slice(0, 400)}` };
  const commit = await runTrustedGit(cwd, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "-m",
    message,
    "--",
    ...paths,
  ]);
  if (commit.exitCode !== 0)
    return { ok: false, error: `git commit failed: ${commit.stderr.slice(0, 400)}` };
  const head = await gitHeadCommit(cwd);
  if (head === undefined) return { ok: false, error: "rev-parse HEAD failed after commit" };
  return { ok: true, commit: head };
}
