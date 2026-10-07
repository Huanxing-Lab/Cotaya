// Continuous worktree Git 操作（CT-02）：经现有公开 Git 边界（GitCommandProvider/GitCliRepo）
// 执行 worktree/分支/对象命令，全部 argv 传递、不经 shell、pathspec 限定，禁止整仓 reset/clean。
// 本文件只负责把 Git 原始结果解析成 Continuous 需要的事实，不承载业务决策。

import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../../git/config.js";
import type { GitCommandProvider } from "../../git/providers/gitCommandProvider.js";
import type { GitCliRepo } from "../../git/repo/gitCliRepo.js";
import { ensureGitCommandSucceeded } from "../../git/repo/gitCliHelpers.js";

/** 稳定错误码：上层（ContinuousService/Host）据此映射结构化错误；不透出 Git 原始文案。 */
export const WORKSPACE_PREPARATION_ERROR_CODES = [
  "git_unavailable",
  "not_a_repository",
  "unknown_base_commit",
  "worktree_branch_mismatch",
  "worktree_directory_missing",
  "worktree_not_managed",
  "candidate_checkpoint_unknown",
] as const;
export type WorkspacePreparationErrorCode = (typeof WORKSPACE_PREPARATION_ERROR_CODES)[number];

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode;

  constructor(code: WorkspacePreparationErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePreparationError";
    this.code = code;
  }
}

/** git worktree list --porcelain 的最小解析：只取 worktree 路径、HEAD 与分支。 */
export interface WorktreeListEntry {
  path: string;
  head: string;
  branch: string | null;
}

export function parseWorktreeListPorcelain(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (line.length === 0) {
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: "", branch: null };
      entries.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

/** 执行层包装：统一超时/输出上限与错误标签，禁止调用方拼接 shell 字符串。 */
export interface WorkspaceGitRunner {
  run(
    cwd: string,
    args: string[],
    options?: { allowedExitCodes?: number[] },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  resolveRepository(workspacePath: string): Promise<{
    repoRoot: string;
    isGitAvailable: boolean;
    isRepository: boolean;
  }>;
}

export function createWorkspaceGitRunner(options: {
  commandProvider: GitCommandProvider;
  gitRepo: Pick<GitCliRepo, "resolveRepository">;
}): WorkspaceGitRunner {
  const { commandProvider, gitRepo } = options;

  return {
    async run(cwd, args, runOptions) {
      const result = await commandProvider.run({
        cwd,
        args,
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded(
        `git ${args[0] ?? ""}`,
        result,
        runOptions?.allowedExitCodes ?? [0],
      );
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },

    async resolveRepository(workspacePath) {
      const resolution = await gitRepo.resolveRepository(workspacePath);
      return {
        repoRoot: resolution.repoRoot,
        isGitAvailable: resolution.isGitAvailable,
        isRepository: resolution.isRepository,
      };
    },
  };
}

/** 解析用户选择的起点为完整 commit OID；不存在或非 commit 则 unknown_base_commit。 */
export async function resolveCommitOid(
  runner: WorkspaceGitRunner,
  repoRoot: string,
  baseCommit: string,
): Promise<string> {
  // rev-parse --quiet 在解析失败时以 exit 1 + 空输出表示；这里必须容忍该退出码再判空。
  const result = await runner.run(
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `${baseCommit}^{commit}`],
    { allowedExitCodes: [0, 1] },
  );
  const oid = result.stdout.trim();
  if (result.exitCode !== 0 || oid.length === 0) {
    throw new WorkspacePreparationError(
      "unknown_base_commit",
      `Base commit 不能解析为现有 commit: ${baseCommit}`,
    );
  }
  return oid;
}

export async function listWorktrees(
  runner: WorkspaceGitRunner,
  repoRoot: string,
): Promise<WorktreeListEntry[]> {
  const result = await runner.run(repoRoot, ["worktree", "list", "--porcelain"]);
  return parseWorktreeListPorcelain(result.stdout);
}

/** 创建 worktree（必要时连分支一起建）；已存在时由调用方先核对归属再复用。 */
export async function addWorktree(
  runner: WorkspaceGitRunner,
  repoRoot: string,
  request: { executionPath: string; branchName: string; baseCommitOid: string },
): Promise<void> {
  await runner.run(repoRoot, [
    "worktree",
    "add",
    "-b",
    request.branchName,
    request.executionPath,
    request.baseCommitOid,
  ]);
}

export async function attachWorktreeToBranch(
  runner: WorkspaceGitRunner,
  repoRoot: string,
  request: { executionPath: string; branchName: string },
): Promise<void> {
  await runner.run(repoRoot, ["worktree", "add", request.executionPath, request.branchName]);
}

export function toBranchShortName(ref: string | null): string | null {
  if (!ref) {
    return null;
  }
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** 分支是否已存在（用于崩溃重试后区分「重建」与「附加已有分支」）。 */
export async function branchExists(
  runner: WorkspaceGitRunner,
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const result = await runner.run(
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    { allowedExitCodes: [0, 1] },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}
