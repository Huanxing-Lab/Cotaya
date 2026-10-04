// Continuous 候选检查点（CT-02，规格 §7）：候选修改前在 worktree 内记录受控检查点，
// 验证失败时只恢复「确认是本候选所写且无人外部修改」的路径。
//
// 归属判定规则（单一所有者，不在 CLI 侧重复实现）：
// - 调用方提供候选最后写入指纹（path → git blob OID）；
// - 当前文件内容与指纹一致 → 归属明确，可恢复到检查点内容（或删除检查点后新增的文件）；
// - 指纹缺失但文件相对检查点有变化 → 归属不明，refused，保持字节不动并保留证据；
// - 恢复操作全部 pathspec 限定（git checkout <baseCommit> -- <path> / 单文件删除），
//   禁止整仓 hard reset、clean 或清理未跟踪文件。
//
// 检查点是 Cycle 内运行时状态：进程内 Map 保存元数据，内容事实始终从 Git 对象读取，
// 恢复前重新核对当前字节，因此崩溃后重建检查点也不会基于过期内存状态覆盖外部改动。

import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  CandidateCheckpointMeta,
  CandidateRestoreOutcome,
  CandidateRestoreRequest,
  CandidateWriteFingerprint,
} from "../application/ports.js";
import type { WorkspaceGitRunner } from "./workspaceGitOps.js";
import { WorkspacePreparationError } from "./workspaceGitOps.js";

interface CheckpointRecord extends CandidateCheckpointMeta {
  /** 本功能登记的 worktree（prepare 成功后才有检查点资格）。 */
  executionPath: string;
}

/** 暴露给执行适配器：候选每次写入后计算指纹（git blob OID 语义：blob <size>\0<content>）。 */
export async function computeCandidateWriteFingerprint(
  absolutePath: string,
): Promise<CandidateWriteFingerprint["contentOid"]> {
  const content = await readFile(absolutePath);
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, content]))
    .digest("hex");
}

/** 相对 executionPath 的 repo 相对路径（"/" 分隔）；拒绝绝对路径与逃逸路径。 */
export function toWorktreeRelativePath(executionPath: string, rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/");
  if (isAbsolute(normalized)) {
    const withoutPrefix = normalized.replace(/^\/+/, "");
    if (withoutPrefix.length === 0) {
      return null;
    }
    // 绝对路径仅接受 executionPath 前缀形式；其余（外部绝对路径）一律拒绝。
    const prefix = executionPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    return withoutPrefix.toLowerCase().startsWith(prefix.toLowerCase())
      ? withoutPrefix.slice(prefix.length)
      : null;
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const relative = segments.join("/");
  return relative.length > 0 ? relative : null;
}

export class CandidateCheckpointStore {
  private readonly checkpoints = new Map<string, CheckpointRecord>();
  private readonly runner: WorkspaceGitRunner;

  constructor(runner: WorkspaceGitRunner) {
    this.runner = runner;
  }

  private key(programId: string, candidateId: string): string {
    return `${programId}\0${candidateId}`;
  }

  /** worktree 内 HEAD OID；worktree 必须已由 prepare 登记在册。 */
  private async readWorktreeHead(executionPath: string): Promise<string> {
    const result = await this.runner.run(executionPath, ["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  async createCheckpoint(request: {
    programId: string;
    candidateId: string;
    executionPath: string;
    ownedPaths: string[];
    now: number;
  }): Promise<CandidateCheckpointMeta> {
    const owned = new Set<string>();
    for (const rawPath of request.ownedPaths) {
      const relative = toWorktreeRelativePath(request.executionPath, rawPath);
      if (!relative) {
        throw new WorkspacePreparationError(
          "worktree_not_managed",
          `检查点路径越界（必须位于 executionPath 内）: ${rawPath}`,
        );
      }
      owned.add(relative);
    }
    const baseCommit = await this.readWorktreeHead(request.executionPath);
    const meta: CheckpointRecord = {
      programId: request.programId,
      candidateId: request.candidateId,
      executionPath: request.executionPath,
      baseCommit,
      ownedPaths: [...owned],
      createdAt: request.now,
    };
    this.checkpoints.set(this.key(request.programId, request.candidateId), meta);
    return { ...meta };
  }

  /** 检查点时刻该路径的 blob OID；路径不存在于该 commit 时返回 null（同时用于存在性判断）。 */
  private async blobOidAtCommit(
    executionPath: string,
    baseCommit: string,
    path: string,
  ): Promise<string | null> {
    // 用 rev-parse --quiet 判存在：cat-file -e 对「盘上存在但 commit 里没有」的路径
    // 会以 128 退出（fatal），与真实失败无法区分；rev-parse 缺失时稳定 exit 1 + 空输出。
    const result = await this.runner.run(
      executionPath,
      ["rev-parse", "--verify", "--quiet", `${baseCommit}:${path}`],
      { allowedExitCodes: [0, 1] },
    );
    const oid = result.stdout.trim();
    return result.exitCode === 0 && oid.length > 0 ? oid : null;
  }

  async restore(request: CandidateRestoreRequest): Promise<CandidateRestoreOutcome[]> {
    const record = this.checkpoints.get(this.key(request.programId, request.candidateId));
    if (!record) {
      throw new WorkspacePreparationError(
        "candidate_checkpoint_unknown",
        `候选检查点不存在或已被消费: ${request.candidateId}`,
      );
    }

    const writes = new Map<string, string>();
    for (const write of request.candidateWrites) {
      const relative = toWorktreeRelativePath(record.executionPath, write.path);
      if (relative) {
        writes.set(relative, write.contentOid);
      }
    }

    const outcomes: CandidateRestoreOutcome[] = [];
    for (const path of record.ownedPaths) {
      outcomes.push(await this.restorePath(record, path, writes.get(path) ?? null));
    }
    // 恢复完成后检查点一次性消费，防止同一检查点被二次解释（外部字节可能已变）。
    this.checkpoints.delete(this.key(request.programId, request.candidateId));
    return outcomes;
  }

  private async restorePath(
    record: CheckpointRecord,
    path: string,
    candidateWriteOid: string | null,
  ): Promise<CandidateRestoreOutcome> {
    const absolutePath = join(record.executionPath, ...path.split("/"));

    let info;
    try {
      info = await lstat(absolutePath);
    } catch {
      // 文件已消失：候选写过 → 归属不明（无法区分候选删除还是外部删除）；未写过 → 无需恢复。
      return candidateWriteOid
        ? { path, action: "refused", reason: "missing_after_write" }
        : { path, action: "unchanged" };
    }

    // 符号链接不读取内容：无法安全归属，交由上层保存证据并停止该候选的恢复。
    if (info.isSymbolicLink()) {
      return { path, action: "refused", reason: "symlink_present" };
    }

    const currentOid = await computeCandidateWriteFingerprint(absolutePath);
    if (candidateWriteOid) {
      if (currentOid !== candidateWriteOid) {
        // 指纹不匹配：候选最后一次写入之后有人改动（外部编辑），不能覆盖。
        return { path, action: "refused", reason: "externally_modified" };
      }
      const checkpointBlob = await this.blobOidAtCommit(
        record.executionPath,
        record.baseCommit,
        path,
      );
      if (checkpointBlob !== null) {
        await this.runner.run(record.executionPath, ["checkout", record.baseCommit, "--", path]);
        return { path, action: "restored" };
      }
      // 检查点之后由候选新增的文件：恢复 = 删除该文件本身，不触碰任何其他未跟踪文件。
      await rm(absolutePath, { force: true });
      return { path, action: "deleted" };
    }

    // 候选未登记写入：只有与检查点完全一致才算「无需恢复」；任何差异都归属不明。
    const checkpointOid = await this.blobOidAtCommit(record.executionPath, record.baseCommit, path);
    if (checkpointOid === null || currentOid !== checkpointOid) {
      return { path, action: "refused", reason: "modified_without_attribution" };
    }
    return { path, action: "unchanged" };
  }
}
