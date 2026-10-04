// Continuous WorkspacePreparation adapter（CT-02，规格 §7/D1/D4）：
// 经现有公开 Git 边界（GitCommandProvider + GitCliRepo.resolveRepository）创建
// codex/continuous-<programId> 分支与独立 worktree；原始 workspace 只读、不复制不覆盖
// staged/unstaged/untracked 改动。worktree 位于产品数据目录，不落在用户仓库内。
//
// 交付边界（回滚规则）：release 只解除本功能的管理登记，保留分支、worktree 与用户成果；
// 不执行 git worktree remove/prune，不清理用户自己的 worktree。

import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "../../paths.js";
import { createGitCommandProvider } from "../../git/providers/gitCommandProvider.js";
import { createGitCliRepo } from "../../git/repo/gitCliRepo.js";
import type { GitCommandProvider } from "../../git/providers/gitCommandProvider.js";
import type { GitCliRepo } from "../../git/repo/gitCliRepo.js";
import type {
  CandidateCheckpointMeta,
  CandidateRestoreOutcome,
  CandidateRestoreRequest,
  ContinuousClockPort,
  WorkspacePreparationPort,
  WorkspacePreparationRequest,
  WorkspacePreparationResult,
} from "../application/ports.js";
import { CandidateCheckpointStore } from "./candidateCheckpointStore.js";
import {
  WorkspacePreparationError,
  addWorktree,
  attachWorktreeToBranch,
  branchExists,
  createWorkspaceGitRunner,
  listWorktrees,
  resolveCommitOid,
  toBranchShortName,
} from "./workspaceGitOps.js";
import type { WorkspaceGitRunner } from "./workspaceGitOps.js";

/** 默认 worktree 根：{dataBaseDir}/.cotaya/continuous-worktrees/<programId>。 */
export function getContinuousWorktreesRootDir(): string {
  return join(getZCodeDataRootDir(), "continuous-worktrees");
}

/** programId 进入文件系统前的白名单清洗（协议 idString 本已受限，这里防御性兜底）。 */
function sanitizeProgramIdSegment(programId: string): string {
  const sanitized = programId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    throw new WorkspacePreparationError("worktree_not_managed", `非法 programId: ${programId}`);
  }
  return sanitized;
}

export interface WorkspacePreparationDependencies {
  commandProvider?: GitCommandProvider;
  /** 现有公开 Git 仓库解析边界；生产默认 createGitCliRepo()。 */
  gitRepo?: Pick<GitCliRepo, "resolveRepository">;
  /** 测试注入临时根目录；生产默认产品数据目录。 */
  worktreeRootDir?: string;
  clock: Pick<ContinuousClockPort, "now">;
}

interface ManagedWorktree {
  programId: string;
  executionPath: string;
  branchName: string;
}

export function createWorkspacePreparation(
  dependencies: WorkspacePreparationDependencies,
): WorkspacePreparationPort {
  const commandProvider = dependencies.commandProvider ?? createGitCommandProvider();
  const gitRepo = dependencies.gitRepo ?? createGitCliRepo({ commandProvider });
  const runner: WorkspaceGitRunner = createWorkspaceGitRunner({ commandProvider, gitRepo });
  const checkpoints = new CandidateCheckpointStore(runner);
  const managed = new Map<string, ManagedWorktree>();
  const worktreeRootDir = dependencies.worktreeRootDir ?? getContinuousWorktreesRootDir();

  // git worktree list 报告的是真实路径（符号链接已解析，如 macOS /var → /private/var），
  // 与我们拼接的 executionPath 可能形态不同；统一按 realpath 判同一位置。
  async function isSameLocation(left: string, right: string): Promise<boolean> {
    const resolvePath = async (value: string): Promise<string> =>
      (await realpath(value).catch(() => value)).replace(/\\/g, "/");
    return (await resolvePath(left)) === (await resolvePath(right));
  }

  async function prepare(
    request: WorkspacePreparationRequest,
  ): Promise<WorkspacePreparationResult> {
    const resolution = await runner.resolveRepository(request.workspacePath);
    if (!resolution.isGitAvailable) {
      throw new WorkspacePreparationError("git_unavailable", "当前环境没有可用的 Git 二进制");
    }
    if (!resolution.isRepository) {
      throw new WorkspacePreparationError(
        "not_a_repository",
        `workspace 不在 Git 仓库内: ${request.workspacePath}`,
      );
    }

    // 从用户明确选择的现有 HEAD 开始；解析为完整 OID，避免短哈希/符号引用漂移。
    const baseCommitOid = await resolveCommitOid(runner, resolution.repoRoot, request.baseCommit);

    const executionPath = join(worktreeRootDir, sanitizeProgramIdSegment(request.programId));
    const existing = managed.get(request.programId);
    if (existing && existing.executionPath === executionPath) {
      return verifyExistingWorktree(request, existing.executionPath);
    }

    const worktrees = await listWorktrees(runner, resolution.repoRoot);
    let occupying: (typeof worktrees)[number] | undefined;
    for (const entry of worktrees) {
      if (await isSameLocation(entry.path, executionPath)) {
        occupying = entry;
        break;
      }
    }
    if (occupying) {
      // Git 会继续登记目录已被删除的 worktree；目录缺失时不能假装备活，交上层恢复决策。
      const dirInfo = await stat(executionPath).catch(() => null);
      if (!dirInfo?.isDirectory()) {
        throw new WorkspacePreparationError(
          "worktree_directory_missing",
          `worktree 目录缺失但 Git 元数据仍登记: ${executionPath}`,
        );
      }
      // 同一受管路径已存在 worktree：只有分支匹配时才复用（幂等重试），否则拒绝接管。
      const branch = toBranchShortName(occupying.branch);
      if (branch !== request.branchName) {
        throw new WorkspacePreparationError(
          "worktree_branch_mismatch",
          `受管 worktree 路径被其他分支占用: ${executionPath}（${branch ?? "detached"}）`,
        );
      }
      managed.set(request.programId, {
        programId: request.programId,
        executionPath,
        branchName: request.branchName,
      });
      return { executionPath, branchName: request.branchName, baseCommit: occupying.head };
    }

    if (await branchExists(runner, resolution.repoRoot, request.branchName)) {
      // 分支已存在（例如创建 worktree 前中断的重试）：附加分支而不重建，保留已有提交。
      await attachWorktreeToBranch(runner, resolution.repoRoot, {
        executionPath,
        branchName: request.branchName,
      });
    } else {
      await addWorktree(runner, resolution.repoRoot, {
        executionPath,
        branchName: request.branchName,
        baseCommitOid,
      });
    }

    const attachedList = await listWorktrees(runner, resolution.repoRoot);
    let attached: (typeof attachedList)[number] | undefined;
    for (const entry of attachedList) {
      if (await isSameLocation(entry.path, executionPath)) {
        attached = entry;
        break;
      }
    }
    if (!attached || toBranchShortName(attached.branch) !== request.branchName) {
      throw new WorkspacePreparationError(
        "worktree_branch_mismatch",
        `worktree 创建后校验失败: ${executionPath}`,
      );
    }

    managed.set(request.programId, {
      programId: request.programId,
      executionPath,
      branchName: request.branchName,
    });
    return { executionPath, branchName: request.branchName, baseCommit: attached.head };
  }

  /** 已登记 worktree 的幂等复用：只核对身份，不再改动仓库。 */
  async function verifyExistingWorktree(
    request: WorkspacePreparationRequest,
    executionPath: string,
  ): Promise<WorkspacePreparationResult> {
    const info = await stat(executionPath).catch(() => null);
    if (!info?.isDirectory()) {
      managed.delete(request.programId);
      return prepare(request);
    }
    const head = await runner.run(executionPath, ["rev-parse", "HEAD"]);
    return { executionPath, branchName: request.branchName, baseCommit: head.stdout.trim() };
  }

  return {
    prepare,

    async release(programId) {
      // 只解除管理登记（幂等）；分支、worktree、提交全部保留，不清理用户成果。
      managed.delete(programId);
    },

    async createCandidateCheckpoint(request) {
      const registered = managed.get(request.programId);
      if (!registered || registered.executionPath !== request.executionPath) {
        throw new WorkspacePreparationError(
          "worktree_not_managed",
          `executionPath 未登记为本 Program 的 worktree: ${request.executionPath}`,
        );
      }
      const meta: CandidateCheckpointMeta = await checkpoints.createCheckpoint({
        ...request,
        now: dependencies.clock.now(),
      });
      return meta;
    },

    async restoreCandidateFiles(
      request: CandidateRestoreRequest,
    ): Promise<CandidateRestoreOutcome[]> {
      return await checkpoints.restore(request);
    },
  };
}
